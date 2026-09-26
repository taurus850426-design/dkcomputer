-- Stage 25.1: 已到貨品項可安全修改「客戶訂單專用／一般庫存」
-- 只調整訂單綁定與庫存占用，不重複建立到貨入庫紀錄。

BEGIN;

CREATE OR REPLACE FUNCTION public.backoffice_set_purchase_receipt_destination(
  p_order_id TEXT,
  p_line_key TEXT,
  p_purchase_order_id TEXT,
  p_purchase_item_id TEXT,
  p_destination TEXT,
  p_note TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_receipt_key TEXT;
  v_item_id TEXT;
  v_receipt_qty NUMERIC;
  v_unit_cost NUMERIC;
  v_line_id TEXT;
  v_order_status TEXT;
  v_reserved_balance NUMERIC := 0;
  v_cogs NUMERIC := 0;
  v_ledger_id TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role <> 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  IF p_destination NOT IN ('customer','inventory') THEN RAISE EXCEPTION 'invalid destination'; END IF;
  IF COALESCE(NULLIF(p_purchase_order_id,''),'')='' OR COALESCE(NULLIF(p_purchase_item_id,''),'')='' THEN
    RAISE EXCEPTION 'purchase order and item required';
  END IF;

  v_receipt_key := 'purchase-order:' || p_purchase_order_id || ':' || p_purchase_item_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_receipt_key));

  SELECT l.item_id, l.qty, COALESCE(lc.unit_cost,0)
  INTO v_item_id, v_receipt_qty, v_unit_cost
  FROM public.inventory_ledger l
  LEFT JOIN public.inventory_ledger_costs lc ON lc.ledger_id=l.id
  WHERE l.ref_type='PURCHASE_RECEIPT' AND l.ref_id=v_receipt_key
  ORDER BY l.created_at LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'purchase receipt not found'; END IF;

  SELECT COALESCE(SUM(l.qty),0) INTO v_reserved_balance
  FROM public.inventory_ledger l
  WHERE (l.ref_type='ORDER' AND l.extra->>'receipt_key'=v_receipt_key)
     OR (l.ref_type='PURCHASE_DESTINATION' AND l.ref_id=v_receipt_key);

  IF p_destination='customer' THEN
    IF COALESCE(NULLIF(p_order_id,''),'')='' OR COALESCE(NULLIF(p_line_key,''),'')='' THEN
      RAISE EXCEPTION 'linked order required';
    END IF;
    SELECT oi.id,o.status INTO v_line_id,v_order_status
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id
    WHERE oi.order_id=p_order_id
      AND (oi.extra->>'line_key'=p_line_key OR oi.id=p_order_id || ':' || p_line_key)
    FOR UPDATE OF oi,o;
    IF NOT FOUND THEN RAISE EXCEPTION 'linked order line not found'; END IF;
    IF v_order_status='refunded' THEN RAISE EXCEPTION 'refunded order cannot reserve stock'; END IF;

    UPDATE public.order_items SET
      item_id=v_item_id,
      sku=(SELECT it.sku FROM public.inventory_items it WHERE it.id=v_item_id),
      extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object(
        'fulfillment_type','inventory','procurement_received',true,
        'receipt_inventory_item_id',v_item_id,'receipt_purchase_order_id',p_purchase_order_id,
        'receipt_purchase_item_id',p_purchase_item_id,'line_key',p_line_key
      )
    WHERE id=v_line_id;
    INSERT INTO public.order_item_costs(order_item_id,cost_unit) VALUES(v_line_id,v_unit_cost)
    ON CONFLICT(order_item_id) DO UPDATE SET cost_unit=EXCLUDED.cost_unit;
    SELECT COALESCE(SUM(COALESCE(oic.cost_unit,0)*COALESCE(oi.qty,0)),0)
    INTO v_cogs
    FROM public.order_items oi
    LEFT JOIN public.order_item_costs oic ON oic.order_item_id=oi.id
    WHERE oi.order_id=p_order_id;
    INSERT INTO public.order_costs(order_id,cogs_total) VALUES(p_order_id,v_cogs)
    ON CONFLICT(order_id) DO UPDATE SET cogs_total=EXCLUDED.cogs_total;

    UPDATE public.inventory_items SET
      extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object(
        'reserved_order_id',p_order_id,'reserved_order_line_key',p_line_key
      ),updated_at=pg_catalog.now()
    WHERE id=v_item_id;

    IF v_reserved_balance >= 0 AND v_order_status IN ('confirmed','pending','paid','shipped','completed') THEN
      UPDATE public.inventory_items SET qty_on_hand=qty_on_hand-v_receipt_qty,last_moved_at=pg_catalog.now(),
        is_archived=(qty_on_hand-v_receipt_qty<=0),
        archived_at=CASE WHEN qty_on_hand-v_receipt_qty<=0 THEN COALESCE(archived_at,pg_catalog.now()) ELSE NULL END,
        updated_at=pg_catalog.now()
      WHERE id=v_item_id AND qty_on_hand>=v_receipt_qty;
      IF NOT FOUND THEN RAISE EXCEPTION 'insufficient stock'; END IF;
      v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text,'-','');
      INSERT INTO public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id,note,extra,created_at)
      VALUES(v_ledger_id,v_item_id,'OUT',-v_receipt_qty,'PURCHASE_DESTINATION',v_receipt_key,
        '到貨用途改為客戶訂單專用' || CASE WHEN COALESCE(p_note,'')<>'' THEN '｜'||p_note ELSE '' END,
        pg_catalog.jsonb_build_object('order_id',p_order_id,'line_key',p_line_key,'destination','customer'),pg_catalog.now());
      INSERT INTO public.inventory_ledger_costs(ledger_id,unit_cost) VALUES(v_ledger_id,v_unit_cost);
    END IF;
  ELSE
    IF v_reserved_balance < 0 THEN
      IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id=p_order_id AND o.status IN ('shipped','completed','refunded')) THEN
        RAISE EXCEPTION 'finalized order destination cannot be changed';
      END IF;
      UPDATE public.inventory_items SET qty_on_hand=qty_on_hand+ABS(v_reserved_balance),last_moved_at=pg_catalog.now(),
        is_archived=false,archived_at=NULL,updated_at=pg_catalog.now()
      WHERE id=v_item_id;
      v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text,'-','');
      INSERT INTO public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id,note,extra,created_at)
      VALUES(v_ledger_id,v_item_id,'IN',ABS(v_reserved_balance),'PURCHASE_DESTINATION',v_receipt_key,
        '到貨用途改為一般庫存' || CASE WHEN COALESCE(p_note,'')<>'' THEN '｜'||p_note ELSE '' END,
        pg_catalog.jsonb_build_object('order_id',COALESCE(p_order_id,''),'line_key',COALESCE(p_line_key,''),'destination','inventory'),pg_catalog.now());
      INSERT INTO public.inventory_ledger_costs(ledger_id,unit_cost) VALUES(v_ledger_id,v_unit_cost);
    END IF;

    IF COALESCE(NULLIF(p_order_id,''),'')<>'' AND COALESCE(NULLIF(p_line_key,''),'')<>'' THEN
      UPDATE public.order_items SET item_id=NULL,sku=NULL,
        extra=(COALESCE(extra,'{}'::jsonb)
          - 'procurement_received' - 'receipt_inventory_item_id'
          - 'receipt_purchase_order_id' - 'receipt_purchase_item_id')
          || pg_catalog.jsonb_build_object('fulfillment_type','procurement','line_key',p_line_key)
      WHERE order_id=p_order_id
        AND (extra->>'line_key'=p_line_key OR id=p_order_id || ':' || p_line_key);
    END IF;
    UPDATE public.inventory_items SET
      extra=COALESCE(extra,'{}'::jsonb)-'reserved_order_id'-'reserved_order_line_key',updated_at=pg_catalog.now()
    WHERE id=v_item_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok',true,'destination',p_destination,'item_id',v_item_id,
    'qty_on_hand',(SELECT it.qty_on_hand FROM public.inventory_items it WHERE it.id=v_item_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_set_purchase_receipt_destination(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_purchase_receipt_destination(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
  TO authenticated;

COMMIT;

SELECT to_regprocedure(
  'public.backoffice_set_purchase_receipt_destination(text,text,text,text,text,text)'
) IS NOT NULL AS stage25_1_ready;
