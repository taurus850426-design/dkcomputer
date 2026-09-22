-- Stage 25: 叫貨到貨自動入庫，並精準綁定來源訂單品項
-- 先執行本檔並確認 stage25_ready = true，再發布相同版本前端。

BEGIN;

DO $$
DECLARE
  missing TEXT;
BEGIN
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 25 preflight failed: dk_require_backoffice() is missing';
  END IF;
  SELECT pg_catalog.string_agg(req.tbl || '.' || req.col, ', ' ORDER BY req.tbl, req.col)
  INTO missing
  FROM (VALUES
    ('inventory_items','id'),('inventory_items','qty_on_hand'),('inventory_items','extra'),
    ('inventory_costs','item_id'),('inventory_costs','cost_unit'),
    ('inventory_ledger','id'),('inventory_ledger','ref_id'),('inventory_ledger','extra'),
    ('inventory_ledger_costs','ledger_id'),
    ('orders','id'),('orders','status'),
    ('order_items','id'),('order_items','order_id'),('order_items','item_id'),('order_items','extra'),
    ('order_item_costs','order_item_id'),('order_item_costs','cost_unit'),
    ('order_costs','order_id'),('order_costs','cogs_total')
  ) AS req(tbl,col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=req.tbl AND c.column_name=req.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 25 preflight failed: missing %', missing;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_receive_purchase_item(
  p_order_id TEXT,
  p_line_key TEXT,
  p_purchase_order_id TEXT,
  p_purchase_item_id TEXT,
  p_inventory_item_id TEXT,
  p_name TEXT,
  p_category TEXT,
  p_qty NUMERIC,
  p_unit_cost NUMERIC,
  p_vendor TEXT,
  p_received_at DATE,
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
  v_line_id TEXT;
  v_order_status TEXT;
  v_linked BOOLEAN := false;
  v_reserve BOOLEAN := false;
  v_qty NUMERIC := GREATEST(COALESCE(p_qty,0),0);
  v_old_qty NUMERIC;
  v_old_cost NUMERIC;
  v_new_qty NUMERIC;
  v_new_cost NUMERIC;
  v_ledger_id TEXT;
  v_out_ledger_id TEXT;
  v_sku TEXT;
  v_cogs NUMERIC;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role <> 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  IF COALESCE(NULLIF(p_purchase_order_id,''),'')='' OR COALESCE(NULLIF(p_purchase_item_id,''),'')='' THEN
    RAISE EXCEPTION 'purchase order and item required';
  END IF;
  IF COALESCE(NULLIF(pg_catalog.btrim(p_name),''),'')='' THEN RAISE EXCEPTION 'item name required'; END IF;
  IF COALESCE(NULLIF(pg_catalog.btrim(p_category),''),'')='' THEN RAISE EXCEPTION 'category required'; END IF;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'qty must be > 0'; END IF;
  IF COALESCE(p_unit_cost,0) <= 0 THEN RAISE EXCEPTION 'unit cost must be > 0'; END IF;

  v_receipt_key := 'purchase-order:' || p_purchase_order_id || ':' || p_purchase_item_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_receipt_key));
  SELECT l.item_id, l.id INTO v_item_id, v_ledger_id
  FROM public.inventory_ledger l
  WHERE l.ref_type='PURCHASE_RECEIPT' AND l.ref_id=v_receipt_key
  ORDER BY l.created_at LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok',true,'already_received',true,'item_id',v_item_id,'ledger_id',v_ledger_id);
  END IF;

  IF COALESCE(NULLIF(p_order_id,''),'')<>'' OR COALESCE(NULLIF(p_line_key,''),'')<>'' THEN
    IF COALESCE(NULLIF(p_order_id,''),'')='' OR COALESCE(NULLIF(p_line_key,''),'')='' THEN
      RAISE EXCEPTION 'order id and line key must be provided together';
    END IF;
    SELECT oi.id,o.status INTO v_line_id,v_order_status
    FROM public.order_items oi
    JOIN public.orders o ON o.id=oi.order_id
    WHERE oi.order_id=p_order_id
      AND (oi.extra->>'line_key'=p_line_key OR oi.id=p_order_id || ':' || p_line_key)
    FOR UPDATE OF oi,o;
    IF NOT FOUND THEN RAISE EXCEPTION 'linked order line not found'; END IF;
    v_linked := true;
    v_reserve := v_order_status IN ('confirmed','pending','paid','shipped','completed');
  END IF;

  v_item_id := COALESCE(NULLIF(p_inventory_item_id,''), 'i-po-' || pg_catalog.md5(COALESCE(p_order_id,'') || ':' || COALESCE(p_line_key,'') || ':' || v_receipt_key));
  SELECT it.qty_on_hand INTO v_old_qty FROM public.inventory_items it WHERE it.id=v_item_id FOR UPDATE;
  IF NOT FOUND THEN
    v_old_qty := 0;
    v_sku := 'PO-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.md5(v_receipt_key),1,10));
    INSERT INTO public.inventory_items(
      id,sku,category,name,spec,vendor,condition,status,qty_on_hand,inbound_date,reorder_point,
      is_archived,archived_at,extra,created_at,updated_at
    ) VALUES(
      v_item_id,v_sku,pg_catalog.btrim(p_category),pg_catalog.btrim(p_name),'',NULLIF(pg_catalog.btrim(p_vendor),''),
      'NEW','READY',0,p_received_at,0,false,NULL,
      pg_catalog.jsonb_build_object(
        'source_purchase_order_id',p_purchase_order_id,
        'source_purchase_item_id',p_purchase_item_id,
        'reserved_order_id',COALESCE(p_order_id,''),
        'reserved_order_line_key',COALESCE(p_line_key,'')
      ),pg_catalog.now(),pg_catalog.now()
    );
    INSERT INTO public.inventory_costs(item_id,cost_unit,updated_at)
    VALUES(v_item_id,0,pg_catalog.now()) ON CONFLICT(item_id) DO NOTHING;
  END IF;

  SELECT COALESCE(ic.cost_unit,0) INTO v_old_cost FROM public.inventory_costs ic WHERE ic.item_id=v_item_id;
  IF NOT FOUND THEN v_old_cost:=0; END IF;
  v_new_qty := COALESCE(v_old_qty,0)+v_qty;
  v_new_cost := CASE WHEN v_new_qty>0 THEN (COALESCE(v_old_qty,0)*v_old_cost+v_qty*p_unit_cost)/v_new_qty ELSE p_unit_cost END;
  UPDATE public.inventory_items SET
    qty_on_hand=v_new_qty,inbound_date=COALESCE(p_received_at,inbound_date),last_moved_at=pg_catalog.now(),
    is_archived=false,archived_at=NULL,updated_at=pg_catalog.now(),
    extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object(
      'source_purchase_order_id',p_purchase_order_id,'source_purchase_item_id',p_purchase_item_id,
      'reserved_order_id',COALESCE(p_order_id,''),'reserved_order_line_key',COALESCE(p_line_key,'')
    )
  WHERE id=v_item_id;
  INSERT INTO public.inventory_costs(item_id,cost_unit,updated_at) VALUES(v_item_id,v_new_cost,pg_catalog.now())
  ON CONFLICT(item_id) DO UPDATE SET cost_unit=EXCLUDED.cost_unit,updated_at=pg_catalog.now();

  v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text,'-','');
  INSERT INTO public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id,note,extra,created_at)
  VALUES(v_ledger_id,v_item_id,'IN',v_qty,'PURCHASE_RECEIPT',v_receipt_key,
    '叫貨到貨｜' || p_name || CASE WHEN COALESCE(p_note,'')<>'' THEN '｜'||p_note ELSE '' END,
    pg_catalog.jsonb_build_object('purchase_order_id',p_purchase_order_id,'purchase_item_id',p_purchase_item_id),pg_catalog.now());
  INSERT INTO public.inventory_ledger_costs(ledger_id,unit_cost) VALUES(v_ledger_id,p_unit_cost);

  IF v_linked THEN
    UPDATE public.order_items SET
      item_id=v_item_id,sku=(SELECT it.sku FROM public.inventory_items it WHERE it.id=v_item_id),
      extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object(
        'fulfillment_type','inventory','procurement_received',true,'receipt_inventory_item_id',v_item_id,
        'receipt_purchase_order_id',p_purchase_order_id,'receipt_purchase_item_id',p_purchase_item_id,
        'receipt_at',COALESCE(p_received_at::text,''),'line_key',p_line_key
      )
    WHERE id=v_line_id;
    INSERT INTO public.order_item_costs(order_item_id,cost_unit) VALUES(v_line_id,p_unit_cost)
    ON CONFLICT(order_item_id) DO UPDATE SET cost_unit=EXCLUDED.cost_unit;
    SELECT COALESCE(SUM(COALESCE(oic.cost_unit,0)*COALESCE(oi.qty,0)),0)
    INTO v_cogs
    FROM public.order_items oi
    LEFT JOIN public.order_item_costs oic ON oic.order_item_id=oi.id
    WHERE oi.order_id=p_order_id;
    INSERT INTO public.order_costs(order_id,cogs_total) VALUES(p_order_id,v_cogs)
    ON CONFLICT(order_id) DO UPDATE SET cogs_total=EXCLUDED.cogs_total;

    IF v_reserve THEN
      UPDATE public.inventory_items SET qty_on_hand=qty_on_hand-v_qty,last_moved_at=pg_catalog.now(),
        is_archived=(qty_on_hand-v_qty<=0),archived_at=CASE WHEN qty_on_hand-v_qty<=0 THEN pg_catalog.now() ELSE NULL END,
        updated_at=pg_catalog.now() WHERE id=v_item_id AND qty_on_hand>=v_qty;
      IF NOT FOUND THEN RAISE EXCEPTION 'insufficient stock after receipt'; END IF;
      v_out_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text,'-','');
      INSERT INTO public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id,note,extra,created_at)
      VALUES(v_out_ledger_id,v_item_id,'OUT',-v_qty,'ORDER',p_order_id,'訂單預留｜到貨自動綁定',
        pg_catalog.jsonb_build_object('order_id',p_order_id,'line_key',p_line_key,'receipt_key',v_receipt_key),pg_catalog.now());
      INSERT INTO public.inventory_ledger_costs(ledger_id,unit_cost) VALUES(v_out_ledger_id,v_new_cost);
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok',true,'item_id',v_item_id,'ledger_id',v_ledger_id,'reserved_for_order',v_reserve,
    'linked_order',v_linked,'qty_on_hand',(SELECT it.qty_on_hand FROM public.inventory_items it WHERE it.id=v_item_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_receive_purchase_item(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,DATE,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_receive_purchase_item(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,DATE,TEXT)
  TO authenticated;

COMMIT;

SELECT to_regprocedure(
  'public.backoffice_receive_purchase_item(text,text,text,text,text,text,text,numeric,numeric,text,date,text)'
) IS NOT NULL AS stage25_ready;
