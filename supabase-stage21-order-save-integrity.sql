-- DK Computer Stage 21｜訂單儲存完整性＋報價備註持久化
-- 目的：
--   1. 舊訂單引用的庫存品項已不存在時，只要數量不變，仍可修改訂單表頭與售價。
--   2. 歷史失效品項的數量不得變更，避免憑空扣回／補回庫存。
--   3. 報價備註寫入 orders.extra.quote_note。
--   4. 已被訂單引用的庫存品項禁止硬刪除，避免再產生孤兒資料。
--
-- 此 migration 不會刪除、補建或改寫既有訂單／庫存資料。

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.inventory_ledger') IS NULL THEN
    RAISE EXCEPTION 'Stage 21 preflight failed: required order/inventory tables are missing';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 21 preflight failed: dk_require_backoffice() is missing';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_order_quote_note(
  p_order_id TEXT,
  p_quote_note TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.dk_require_backoffice();

  IF COALESCE(p_order_id, '') = '' THEN
    RAISE EXCEPTION 'order_id required';
  END IF;

  UPDATE public.orders
  SET extra = pg_catalog.jsonb_set(
        COALESCE(extra, '{}'::jsonb),
        '{quote_note}',
        pg_catalog.to_jsonb(COALESCE(p_quote_note, '')),
        true
      ),
      updated_at = pg_catalog.now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_set_order_quote_note(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_order_quote_note(TEXT, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_update_order(
  p_order_id TEXT,
  p_order_no TEXT,
  p_customer_name TEXT,
  p_sales_type TEXT,
  p_shipping_income NUMERIC,
  p_discount NUMERIC,
  p_payment_method TEXT,
  p_status TEXT,
  p_lines JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  rec RECORD;
  v_line JSONB;
  v_item_id TEXT;
  v_need NUMERIC;
  v_price NUMERIC;
  v_on_hand NUMERIC;
  v_unit_cost NUMERIC;
  v_delta NUMERIC;
  v_cogs NUMERIC := 0;
  v_total_sale NUMERIC := 0;
  v_line_id TEXT;
  v_ledger_id TEXT;
  v_order_status TEXT;
  v_order_no TEXT;
  v_item_sku TEXT;
  v_item_name TEXT;
  v_item_spec TEXT;
  v_old_lines JSONB := '[]'::jsonb;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_order_id IS NULL OR p_order_id = '' THEN
    RAISE EXCEPTION 'order_id required';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_lines) < 1 THEN
    RAISE EXCEPTION 'lines required';
  END IF;
  v_order_no := COALESCE(NULLIF(p_order_no, ''), '');
  IF v_order_no = '' THEN
    RAISE EXCEPTION 'order_no required';
  END IF;
  v_order_status := COALESCE(NULLIF(p_status, ''), 'pending');

  PERFORM 1 FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', oi.id,
               'item_id', oi.item_id,
               'sku', oi.sku,
               'name', oi.name,
               'spec', oi.spec,
               'qty', oi.qty,
               'unit_price', oi.unit_price,
               'cost_unit', COALESCE(oic.cost_unit, 0)
             ) ORDER BY oi.id
           ),
           '[]'::jsonb
         )
  INTO v_old_lines
  FROM public.order_items oi
  LEFT JOIN public.order_item_costs oic ON oic.order_item_id = oi.id
  WHERE oi.order_id = p_order_id;

  IF EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.order_no = v_order_no AND o.id <> p_order_id
  ) THEN
    RAISE EXCEPTION 'duplicate order_no';
  END IF;

  FOR v_line IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  LOOP
    IF v_line ?| ARRAY['cost_unit', 'costUnit', 'unit_cost', 'unitCost', 'cogs', 'cogs_total', 'cogsTotal'] THEN
      RAISE EXCEPTION 'line must not contain cost fields';
    END IF;
    IF COALESCE(v_line->>'item_id', '') = ''
       OR COALESCE((v_line->>'qty')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid line';
    END IF;
  END LOOP;

  -- 先鎖定仍存在的庫存品項並驗證差額。
  -- 若歷史品項已不存在，只允許新舊總數量完全相同。
  FOR rec IN
    SELECT x.item_id, SUM(x.need) AS need
    FROM (
      SELECT oi.item_id, COALESCE(oi.qty, 0) * -1 AS need
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
      UNION ALL
      SELECT t.elem->>'item_id', COALESCE((t.elem->>'qty')::numeric, 0)
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
    ) x
    WHERE COALESCE(x.item_id, '') <> ''
    GROUP BY 1
    ORDER BY 1
  LOOP
    SELECT it.qty_on_hand INTO v_on_hand
    FROM public.inventory_items it
    WHERE it.id = rec.item_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF COALESCE(rec.need, 0) <> 0 THEN
        RAISE EXCEPTION '歷史品項已不存在庫存，不能變更數量：%', rec.item_id;
      END IF;
      CONTINUE;
    END IF;

    IF rec.need > 0 AND rec.need > COALESCE(v_on_hand, 0) THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(
           COALESCE((t.elem->>'qty')::numeric, 0)
           * COALESCE((t.elem->>'unit_price')::numeric, 0)
         ), 0)
  INTO v_total_sale
  FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem);

  -- 只有真正有數量差額的現存庫存品項才異動庫存與 ledger。
  FOR rec IN
    SELECT x.item_id, SUM(x.need) AS delta
    FROM (
      SELECT oi.item_id, COALESCE(oi.qty, 0) * -1 AS need
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
      UNION ALL
      SELECT t.elem->>'item_id', COALESCE((t.elem->>'qty')::numeric, 0)
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
    ) x
    WHERE COALESCE(x.item_id, '') <> ''
    GROUP BY 1
  LOOP
    v_delta := COALESCE(rec.delta, 0);
    IF v_delta = 0 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(ic.cost_unit, 0) INTO v_unit_cost
    FROM public.inventory_costs ic
    WHERE ic.item_id = rec.item_id;
    IF NOT FOUND THEN
      v_unit_cost := 0;
    END IF;

    UPDATE public.inventory_items
    SET qty_on_hand = qty_on_hand - v_delta,
        last_moved_at = pg_catalog.now(),
        is_archived = CASE WHEN qty_on_hand - v_delta > 0 THEN false ELSE true END,
        archived_at = CASE
          WHEN qty_on_hand > 0 AND qty_on_hand - v_delta <= 0 THEN pg_catalog.now()
          WHEN qty_on_hand - v_delta > 0 THEN NULL
          ELSE archived_at
        END,
        updated_at = pg_catalog.now()
    WHERE id = rec.item_id
      AND (v_delta <= 0 OR qty_on_hand >= v_delta);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;

    v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    INSERT INTO public.inventory_ledger
      (id, item_id, type, qty, ref_type, ref_id, note, created_at)
    VALUES (
      v_ledger_id,
      rec.item_id,
      CASE WHEN v_delta > 0 THEN 'OUT' ELSE 'IN' END,
      -v_delta,
      'ORDER',
      p_order_id,
      '訂單編輯 ' || v_order_no,
      pg_catalog.now()
    );
    INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
    VALUES (v_ledger_id, COALESCE(v_unit_cost, 0));
  END LOOP;

  UPDATE public.orders
  SET order_no = v_order_no,
      customer_name = p_customer_name,
      sales_type = p_sales_type,
      total_sale = v_total_sale,
      shipping_income = COALESCE(p_shipping_income, 0),
      discount = COALESCE(p_discount, 0),
      payment_method = p_payment_method,
      status = v_order_status,
      updated_at = pg_catalog.now()
  WHERE id = p_order_id;

  DELETE FROM public.order_items WHERE order_id = p_order_id;

  -- 重建明細時，現存品項使用庫存主檔；失效歷史品項使用刪除前保存的快照。
  FOR rec IN
    SELECT e.elem, e.ord
    FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS e(elem, ord)
  LOOP
    v_line := rec.elem;
    v_item_id := v_line->>'item_id';
    v_need := (v_line->>'qty')::numeric;
    v_price := COALESCE((v_line->>'unit_price')::numeric, 0);

    SELECT it.sku, it.name, it.spec
    INTO v_item_sku, v_item_name, v_item_spec
    FROM public.inventory_items it
    WHERE it.id = v_item_id;

    IF NOT FOUND THEN
      SELECT h.elem->>'sku', h.elem->>'name', h.elem->>'spec'
      INTO v_item_sku, v_item_name, v_item_spec
      FROM pg_catalog.jsonb_array_elements(v_old_lines) AS h(elem)
      WHERE h.elem->>'item_id' = v_item_id
      ORDER BY h.elem->>'id'
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION '歷史品項快照不存在：%', v_item_id;
      END IF;
    END IF;

    SELECT COALESCE(ic.cost_unit, 0) INTO v_unit_cost
    FROM public.inventory_costs ic
    WHERE ic.item_id = v_item_id;
    IF NOT FOUND THEN
      SELECT COALESCE(NULLIF(h.elem->>'cost_unit', '')::numeric, 0)
      INTO v_unit_cost
      FROM pg_catalog.jsonb_array_elements(v_old_lines) AS h(elem)
      WHERE h.elem->>'item_id' = v_item_id
      ORDER BY h.elem->>'id'
      LIMIT 1;
      IF NOT FOUND THEN
        v_unit_cost := 0;
      END IF;
    END IF;

    v_line_id := p_order_id || ':' || rec.ord::text;
    INSERT INTO public.order_items
      (id, order_id, item_id, sku, name, spec, qty, unit_price)
    VALUES (
      v_line_id,
      p_order_id,
      v_item_id,
      v_item_sku,
      v_item_name,
      v_item_spec,
      v_need,
      v_price
    );
    INSERT INTO public.order_item_costs (order_item_id, cost_unit)
    VALUES (v_line_id, COALESCE(v_unit_cost, 0));

    v_cogs := v_cogs + (COALESCE(v_unit_cost, 0) * v_need);
  END LOOP;

  INSERT INTO public.order_costs (order_id, cogs_total)
  VALUES (p_order_id, v_cogs)
  ON CONFLICT (order_id) DO UPDATE SET cogs_total = EXCLUDED.cogs_total;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_order_id,
    'order_no', v_order_no,
    'total_sale', v_total_sale,
    'status', v_order_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_update_order(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_order(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB
) TO authenticated;

CREATE OR REPLACE FUNCTION public.dk_prevent_ordered_item_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.item_id = OLD.id
  ) THEN
    RAISE EXCEPTION '此品項已有訂單紀錄，不能刪除；請保留歷史品項';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_dk_prevent_ordered_item_hard_delete
  ON public.inventory_items;
CREATE TRIGGER trg_dk_prevent_ordered_item_hard_delete
BEFORE DELETE ON public.inventory_items
FOR EACH ROW
EXECUTE FUNCTION public.dk_prevent_ordered_item_hard_delete();

REVOKE ALL ON FUNCTION public.dk_prevent_ordered_item_hard_delete() FROM PUBLIC;

COMMIT;

-- 執行後檢查（只讀）：historical_missing_item_refs 可大於 0，代表仍有歷史快照；
-- Stage 21 的 update RPC 已可在「數量不變」時安全保存這些舊訂單。
SELECT
  to_regprocedure('public.backoffice_set_order_quote_note(text,text)') IS NOT NULL
    AS quote_note_rpc_ready,
  to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL
    AS update_order_rpc_ready,
  (
    SELECT COUNT(*)
    FROM public.order_items oi
    LEFT JOIN public.inventory_items it ON it.id = oi.item_id
    WHERE COALESCE(oi.item_id, '') <> '' AND it.id IS NULL
  ) AS historical_missing_item_refs;

-- Rollback（僅供人工處理；不自動執行）：
-- DROP TRIGGER IF EXISTS trg_dk_prevent_ordered_item_hard_delete ON public.inventory_items;
-- DROP FUNCTION IF EXISTS public.dk_prevent_ordered_item_hard_delete();
-- DROP FUNCTION IF EXISTS public.backoffice_set_order_quote_note(TEXT, TEXT);
-- backoffice_update_order 請以 Stage 07 正式版本覆蓋回復。
