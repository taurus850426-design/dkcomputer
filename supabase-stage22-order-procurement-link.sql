-- Stage 22: 訂單手動規格、洽談狀態與採購來源連結
-- 先執行本檔，再發布相同版本前端。

BEGIN;

DO $$
DECLARE
  missing TEXT;
BEGIN
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 22 preflight failed: dk_require_backoffice() is missing';
  END IF;
  SELECT pg_catalog.string_agg(req.tbl || '.' || req.col, ', ' ORDER BY req.tbl, req.col)
  INTO missing
  FROM (VALUES
    ('inventory_items','id'),('inventory_items','qty_on_hand'),
    ('inventory_costs','item_id'),('inventory_costs','cost_unit'),
    ('inventory_ledger','id'),('inventory_ledger_costs','ledger_id'),
    ('orders','id'),('orders','extra'),('order_items','id'),('order_items','extra'),
    ('order_costs','order_id'),('order_item_costs','order_item_id')
  ) AS req(tbl,col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=req.tbl AND c.column_name=req.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 22 preflight failed: missing %', missing;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_save_order_v2(
  p_order_id TEXT,
  p_order_no TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_line TEXT,
  p_sales_type TEXT,
  p_shipping_income NUMERIC,
  p_discount NUMERIC,
  p_payment_method TEXT,
  p_status TEXT,
  p_lines JSONB,
  p_create BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id TEXT := COALESCE(NULLIF(p_order_id, ''), 'ORD-' || replace(pg_catalog.gen_random_uuid()::text, '-', ''));
  v_status TEXT := COALESCE(NULLIF(p_status, ''), 'negotiating');
  v_old_status TEXT := 'negotiating';
  v_old_affects BOOLEAN := false;
  v_new_affects BOOLEAN := false;
  v_line JSONB;
  v_old JSONB := '[]'::jsonb;
  v_item_id TEXT;
  v_type TEXT;
  v_qty NUMERIC;
  v_price NUMERIC;
  v_delta NUMERIC;
  v_on_hand NUMERIC;
  v_cost NUMERIC;
  v_total NUMERIC := 0;
  v_cogs NUMERIC := 0;
  v_line_id TEXT;
  v_ledger_id TEXT;
  v_sku TEXT;
  v_name TEXT;
  v_spec TEXT;
  v_extra JSONB;
  rec RECORD;
BEGIN
  v_role := public.dk_require_backoffice();
  IF COALESCE(NULLIF(p_order_no, ''), '') = '' THEN RAISE EXCEPTION 'order_no required'; END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) < 1 THEN
    RAISE EXCEPTION 'lines required';
  END IF;
  IF v_status NOT IN ('negotiating','confirmed','pending','paid','shipped','completed','refunded') THEN
    RAISE EXCEPTION 'invalid order status';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.order_no = p_order_no AND o.id <> v_id) THEN
    RAISE EXCEPTION 'duplicate order_no';
  END IF;

  IF p_create THEN
    IF EXISTS (SELECT 1 FROM public.orders o WHERE o.id = v_id) THEN RAISE EXCEPTION 'duplicate order id'; END IF;
  ELSE
    SELECT o.status INTO v_old_status FROM public.orders o WHERE o.id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', oi.id, 'item_id', oi.item_id, 'sku', oi.sku, 'name', oi.name, 'spec', oi.spec,
      'qty', oi.qty, 'unit_price', oi.unit_price, 'cost_unit', COALESCE(oic.cost_unit, 0),
      'fulfillment_type', COALESCE(oi.extra->>'fulfillment_type', CASE WHEN oi.item_id IS NULL THEN 'service' ELSE 'inventory' END)
    )), '[]'::jsonb)
    INTO v_old
    FROM public.order_items oi
    LEFT JOIN public.order_item_costs oic ON oic.order_item_id = oi.id
    WHERE oi.order_id = v_id;
  END IF;

  v_old_affects := v_old_status IN ('confirmed','pending','paid','shipped','completed');
  v_new_affects := v_status IN ('confirmed','pending','paid','shipped','completed');

  FOR v_line IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_lines) t(elem)
  LOOP
    v_type := COALESCE(NULLIF(v_line->>'fulfillment_type',''), CASE WHEN COALESCE(v_line->>'item_id','') <> '' THEN 'inventory' ELSE 'service' END);
    v_qty := COALESCE((v_line->>'qty')::numeric, 0);
    IF v_type NOT IN ('inventory','procurement','service') OR v_qty <= 0 THEN RAISE EXCEPTION 'invalid line'; END IF;
    IF v_type = 'inventory' AND COALESCE(v_line->>'item_id','') = '' THEN RAISE EXCEPTION 'inventory line requires item_id'; END IF;
    IF v_type <> 'inventory' AND COALESCE(v_line->>'name','') = '' THEN RAISE EXCEPTION 'manual line requires name'; END IF;
    IF v_line ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs','cogs_total','cogsTotal'] THEN
      RAISE EXCEPTION 'line must not contain cost fields';
    END IF;
  END LOOP;

  -- 計算只有庫存型品項的淨變化；洽談中與退貨不占用庫存。
  FOR rec IN
    SELECT x.item_id, SUM(x.qty) AS delta
    FROM (
      SELECT t.elem->>'item_id' AS item_id, CASE WHEN v_old_affects THEN -COALESCE((t.elem->>'qty')::numeric,0) ELSE 0 END AS qty
      FROM pg_catalog.jsonb_array_elements(v_old) AS t(elem)
      WHERE COALESCE(t.elem->>'fulfillment_type','inventory') = 'inventory'
      UNION ALL
      SELECT t.elem->>'item_id', CASE WHEN v_new_affects THEN COALESCE((t.elem->>'qty')::numeric,0) ELSE 0 END
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
      WHERE COALESCE(t.elem->>'fulfillment_type', CASE WHEN COALESCE(t.elem->>'item_id','') <> '' THEN 'inventory' ELSE 'service' END) = 'inventory'
    ) x WHERE COALESCE(x.item_id,'') <> '' GROUP BY x.item_id
  LOOP
    v_delta := COALESCE(rec.delta,0);
    IF v_delta = 0 THEN CONTINUE; END IF;
    SELECT it.qty_on_hand INTO v_on_hand FROM public.inventory_items it WHERE it.id = rec.item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '歷史品項已不存在庫存，不能變更數量：%', rec.item_id; END IF;
    IF v_delta > 0 AND v_delta > COALESCE(v_on_hand,0) THEN RAISE EXCEPTION 'insufficient stock'; END IF;
    UPDATE public.inventory_items
    SET qty_on_hand = qty_on_hand - v_delta,
        last_moved_at = pg_catalog.now(),
        is_archived = (qty_on_hand - v_delta <= 0),
        archived_at = CASE WHEN qty_on_hand - v_delta <= 0 THEN COALESCE(archived_at, pg_catalog.now()) ELSE NULL END,
        updated_at = pg_catalog.now()
    WHERE id = rec.item_id;
    SELECT COALESCE(ic.cost_unit,0) INTO v_cost FROM public.inventory_costs ic WHERE ic.item_id = rec.item_id;
    v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    INSERT INTO public.inventory_ledger(id,item_id,type,qty,ref_type,ref_id,note,created_at)
    VALUES(v_ledger_id,rec.item_id,CASE WHEN v_delta > 0 THEN 'OUT' ELSE 'IN' END,-v_delta,'ORDER',v_id,'訂單狀態／明細更新 ' || p_order_no,pg_catalog.now());
    INSERT INTO public.inventory_ledger_costs(ledger_id,unit_cost) VALUES(v_ledger_id,COALESCE(v_cost,0));
  END LOOP;

  SELECT COALESCE(SUM(COALESCE((t.elem->>'qty')::numeric,0) * COALESCE((t.elem->>'unit_price')::numeric,0)),0)
  INTO v_total FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem);
  v_extra := pg_catalog.jsonb_build_object('customer_phone',COALESCE(p_customer_phone,''),'customer_line',COALESCE(p_customer_line,''));

  INSERT INTO public.orders(id,order_no,customer_name,sales_type,total_sale,shipping_income,discount,payment_method,status,created_at,updated_at,extra)
  VALUES(v_id,p_order_no,COALESCE(p_customer_name,''),NULLIF(p_sales_type,''),v_total,COALESCE(p_shipping_income,0),COALESCE(p_discount,0),COALESCE(p_payment_method,'transfer'),v_status,pg_catalog.now(),pg_catalog.now(),v_extra)
  ON CONFLICT(id) DO UPDATE SET order_no=EXCLUDED.order_no,customer_name=EXCLUDED.customer_name,sales_type=EXCLUDED.sales_type,total_sale=EXCLUDED.total_sale,shipping_income=EXCLUDED.shipping_income,discount=EXCLUDED.discount,payment_method=EXCLUDED.payment_method,status=EXCLUDED.status,updated_at=pg_catalog.now(),extra=COALESCE(public.orders.extra,'{}'::jsonb)||v_extra;

  DELETE FROM public.order_items WHERE order_id = v_id;
  FOR rec IN SELECT e.elem,e.ord FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY e(elem,ord)
  LOOP
    v_line := rec.elem;
    v_type := COALESCE(NULLIF(v_line->>'fulfillment_type',''), CASE WHEN COALESCE(v_line->>'item_id','') <> '' THEN 'inventory' ELSE 'service' END);
    v_item_id := NULLIF(v_line->>'item_id','');
    v_qty := (v_line->>'qty')::numeric;
    v_price := COALESCE((v_line->>'unit_price')::numeric,0);
    IF v_type = 'inventory' THEN
      v_cost := 0;
      SELECT it.sku,it.name,it.spec INTO v_sku,v_name,v_spec FROM public.inventory_items it WHERE it.id=v_item_id;
      IF NOT FOUND THEN
        SELECT h.elem->>'sku', h.elem->>'name', h.elem->>'spec', COALESCE(NULLIF(h.elem->>'cost_unit','')::numeric,0)
        INTO v_sku,v_name,v_spec,v_cost
        FROM pg_catalog.jsonb_array_elements(v_old) AS h(elem)
        WHERE h.elem->>'item_id'=v_item_id
        ORDER BY h.elem->>'id'
        LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION '歷史品項快照不存在：%', v_item_id; END IF;
      ELSE
        SELECT COALESCE(ic.cost_unit,0) INTO v_cost FROM public.inventory_costs ic WHERE ic.item_id=v_item_id;
        IF NOT FOUND THEN v_cost := 0; END IF;
      END IF;
    ELSE
      v_sku := COALESCE(v_line->>'sku',''); v_name := v_line->>'name'; v_spec := COALESCE(v_line->>'spec',''); v_cost := 0;
    END IF;
    v_line_id := v_id || ':' || COALESCE(NULLIF(v_line->>'line_key',''),rec.ord::text);
    v_extra := v_line - ARRAY['item_id','sku','name','spec','qty','unit_price']::text[];
    INSERT INTO public.order_items(id,order_id,item_id,sku,name,spec,qty,unit_price,extra)
    VALUES(v_line_id,v_id,v_item_id,v_sku,v_name,v_spec,v_qty,v_price,v_extra);
    INSERT INTO public.order_item_costs(order_item_id,cost_unit) VALUES(v_line_id,COALESCE(v_cost,0));
    v_cogs := v_cogs + COALESCE(v_cost,0)*v_qty;
  END LOOP;
  INSERT INTO public.order_costs(order_id,cogs_total) VALUES(v_id,v_cogs)
  ON CONFLICT(order_id) DO UPDATE SET cogs_total=EXCLUDED.cogs_total;
  RETURN pg_catalog.jsonb_build_object('ok',true,'id',v_id,'order_no',p_order_no,'status',v_status,'total_sale',v_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_create_order_v2(
  p_order_no TEXT,p_customer_name TEXT,p_customer_phone TEXT,p_customer_line TEXT,p_sales_type TEXT,
  p_shipping_income NUMERIC,p_discount NUMERIC,p_payment_method TEXT,p_status TEXT,p_lines JSONB
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT public.dk_save_order_v2(NULL,p_order_no,p_customer_name,p_customer_phone,p_customer_line,p_sales_type,p_shipping_income,p_discount,p_payment_method,p_status,p_lines,true);
$$;

CREATE OR REPLACE FUNCTION public.backoffice_update_order_v2(
  p_order_id TEXT,p_order_no TEXT,p_customer_name TEXT,p_customer_phone TEXT,p_customer_line TEXT,p_sales_type TEXT,
  p_shipping_income NUMERIC,p_discount NUMERIC,p_payment_method TEXT,p_status TEXT,p_lines JSONB
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT public.dk_save_order_v2(p_order_id,p_order_no,p_customer_name,p_customer_phone,p_customer_line,p_sales_type,p_shipping_income,p_discount,p_payment_method,p_status,p_lines,false);
$$;

REVOKE ALL ON FUNCTION public.dk_save_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_create_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_update_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) TO authenticated;

COMMIT;

SELECT
  to_regprocedure('public.backoffice_create_order_v2(text,text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL AS create_ready,
  to_regprocedure('public.backoffice_update_order_v2(text,text,text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL AS update_ready;
