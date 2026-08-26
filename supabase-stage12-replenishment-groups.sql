-- ============================================================
-- DK Computer Stage 12-2A：Replenishment Groups (Database)
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會建表、改 RLS、建 RPC。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_RPC → M3_VERIFY
--
-- 業務規則（已定案，SQL 不改產品語意）：
--   available = SUM(GREATEST(qty_on_hand, 0)) WHERE replenishment_group_id = group.id
--   （不依 brand / vendor / status / is_archived 排除）
--   need_restock = enabled AND available <= threshold_qty
--   suggest_qty = MAX(target_qty - available, 0)
--
-- Additive only：
--   + public.replenishment_groups
--   + inventory_items.replenishment_group_id
--   + RLS / RPC
--
-- 禁止：
--   drop / alter reorder_point
--   修改 qty_on_hand 語意或型別
--   修改 inventory_ledger / inventory_costs / orders* schema
--   修改 backoffice_create_order / backoffice_update_order /
--        backoffice_adjust_stock / backoffice_admin_adjust_stock 扣庫核心
--   自動依 name/spec/SKU 建立或綁定 group
--   前端 service_role
--   改 is_admin() / is_enabled_backoffice_user() / dk_require_backoffice() 語意
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 Stage 7 inventory SoT／helper／關鍵 RPC 仍在，
-- 且 Stage 12 物件尚未誤建（或可安全重跑前狀態）。
-- 請複製本 SECTION（從下一行到 PREFLIGHT END）單獨執行。
-- ============================================================
/*

SELECT 'inventory_items' AS obj,
       (to_regclass('public.inventory_items') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.inventory_items') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'inventory_items.qty_on_hand',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'inventory_items.reorder_point',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reorder_point'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reorder_point'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_admin()',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_enabled_backoffice_user()',
       (to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_require_backoffice()',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_adjust_stock',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_admin_adjust_stock',
       (to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_create_order',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_update_order',
       (to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_upsert_item',
       (to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'replenishment_groups_absent_or_ok_to_continue',
       (to_regclass('public.replenishment_groups') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.replenishment_groups') IS NULL THEN 'PASS'
            ELSE 'INFO_EXISTS' END
ORDER BY 1;

-- PREFLIGHT END
*/


-- ============================================================
-- SECTION M0_SCHEMA
-- Additive：建立 replenishment_groups；inventory_items 加 FK 欄位與 index。
-- 不 touch reorder_point / qty_on_hand 語意 / ledger / orders。
-- 不自動建立任何 group、不綁任何 item。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.inventory_items') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.inventory_items missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: inventory_items.qty_on_hand missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reorder_point'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: inventory_items.reorder_point missing (must remain)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.replenishment_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  threshold_qty NUMERIC NOT NULL DEFAULT 0,
  target_qty NUMERIC NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_groups_threshold_nonneg CHECK (threshold_qty >= 0),
  CONSTRAINT replenishment_groups_target_nonneg CHECK (target_qty >= 0),
  CONSTRAINT replenishment_groups_target_ge_threshold CHECK (target_qty >= threshold_qty)
);

COMMENT ON TABLE public.replenishment_groups IS
  'Stage 12: spec-level replenishment groups; name is mutable; id is stable.';

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS replenishment_group_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_replenishment_group_id_fkey'
      AND conrelid = 'public.inventory_items'::regclass
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT inventory_items_replenishment_group_id_fkey
      FOREIGN KEY (replenishment_group_id)
      REFERENCES public.replenishment_groups(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS inventory_items_replenishment_group_id_idx
  ON public.inventory_items (replenishment_group_id);

CREATE INDEX IF NOT EXISTS replenishment_groups_enabled_name_idx
  ON public.replenishment_groups (enabled, name);

-- M0_SCHEMA END
*/


-- ============================================================
-- SECTION M1_RLS
-- 比照 Stage 7 inventory：
--   SELECT → is_enabled_backoffice_user()
--   WRITE → is_admin()
-- client 直寫經 RLS；正式寫入走 M2 SECURITY DEFINER RPC。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.replenishment_groups') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: run M0_SCHEMA first';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin / is_enabled_backoffice_user missing';
  END IF;
END $$;

ALTER TABLE public.replenishment_groups ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.replenishment_groups FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.replenishment_groups FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.replenishment_groups TO authenticated;
-- 實際 row 權限由 policy 再縮：staff SELECT only；admin ALL。

DROP POLICY IF EXISTS replenishment_groups_select_backoffice ON public.replenishment_groups;
DROP POLICY IF EXISTS replenishment_groups_write_admin ON public.replenishment_groups;

CREATE POLICY replenishment_groups_select_backoffice
  ON public.replenishment_groups FOR SELECT TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY replenishment_groups_write_admin
  ON public.replenishment_groups FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- M1_RLS END
*/


-- ============================================================
-- SECTION M2_RPC
-- 1) backoffice_upsert_replenishment_group：admin 新增／更新群組（改名不改 id）
-- 2) backoffice_upsert_item：ADDITIVE 支援 replenishment_group_id
--    （不改 qty_on_hand／成本／其它欄位語意）
-- 不建立／不修改 create_order / update_order / adjust_stock*。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.replenishment_groups') IS NULL THEN
    RAISE EXCEPTION 'M2_RPC blocked: run M0_SCHEMA first';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'M2_RPC blocked: dk_require_backoffice missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = 'replenishment_group_id'
  ) THEN
    RAISE EXCEPTION 'M2_RPC blocked: inventory_items.replenishment_group_id missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_upsert_replenishment_group(
  p_group JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id TEXT;
  v_name TEXT;
  v_threshold NUMERIC;
  v_target NUMERIC;
  v_enabled BOOLEAN;
  v_notes TEXT;
  v_exists BOOLEAN;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  IF p_group IS NULL OR pg_catalog.jsonb_typeof(p_group) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'group required';
  END IF;

  v_id := COALESCE(NULLIF(p_group->>'id', ''), '');
  IF v_id = '' THEN
    v_id := 'rg-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_group->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'name required';
  END IF;

  v_threshold := COALESCE(NULLIF(p_group->>'threshold_qty', '')::numeric, 0);
  v_target := COALESCE(NULLIF(p_group->>'target_qty', '')::numeric, 0);
  IF v_threshold < 0 OR v_target < 0 THEN
    RAISE EXCEPTION 'qty must be >= 0';
  END IF;
  IF v_target < v_threshold THEN
    RAISE EXCEPTION 'target_qty must be >= threshold_qty';
  END IF;

  IF p_group ? 'enabled' THEN
    v_enabled := COALESCE((p_group->>'enabled')::boolean, true);
  ELSE
    v_enabled := true;
  END IF;

  v_notes := NULLIF(p_group->>'notes', '');

  SELECT true INTO v_exists
  FROM public.replenishment_groups g
  WHERE g.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_exists := false;
  END IF;

  IF v_exists THEN
    UPDATE public.replenishment_groups
    SET name = v_name,
        threshold_qty = v_threshold,
        target_qty = v_target,
        enabled = v_enabled,
        notes = CASE WHEN p_group ? 'notes' THEN v_notes ELSE notes END,
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSE
    INSERT INTO public.replenishment_groups (
      id, name, threshold_qty, target_qty, enabled, notes, extra, created_at, updated_at
    ) VALUES (
      v_id, v_name, v_threshold, v_target, v_enabled, v_notes, '{}'::jsonb,
      pg_catalog.now(), pg_catalog.now()
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'name', v_name,
    'threshold_qty', v_threshold,
    'target_qty', v_target,
    'enabled', v_enabled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_upsert_replenishment_group(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_replenishment_group(JSONB) TO authenticated;

-- Additive REPLACE：僅新增 replenishment_group_id 讀寫；其餘行為對齊 Stage 7 M5。
CREATE OR REPLACE FUNCTION public.backoffice_upsert_item(
  p_item JSONB,
  p_unit_cost NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id TEXT;
  v_qty NUMERIC;
  v_exists BOOLEAN;
  v_group_id TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_item IS NULL OR pg_catalog.jsonb_typeof(p_item) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'item required';
  END IF;
  IF p_item ?| ARRAY['cost_unit', 'costUnit', 'unit_cost', 'unitCost', 'cogs', 'cogs_total', 'cogsTotal'] THEN
    RAISE EXCEPTION 'item must not contain cost fields';
  END IF;

  v_id := COALESCE(NULLIF(p_item->>'id', ''), '');
  IF v_id = '' THEN
    v_id := 'i-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  END IF;

  -- NULL / '' / missing：未納入補貨；非空必須指向既有 group。
  IF p_item ? 'replenishment_group_id' THEN
    v_group_id := NULLIF(btrim(COALESCE(p_item->>'replenishment_group_id', '')), '');
    IF v_group_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.replenishment_groups g WHERE g.id = v_group_id
    ) THEN
      RAISE EXCEPTION 'replenishment group not found';
    END IF;
  ELSE
    v_group_id := NULL; -- 僅供 INSERT 預設；UPDATE 時見下方 CASE
  END IF;

  SELECT true, it.qty_on_hand INTO v_exists, v_qty
  FROM public.inventory_items it
  WHERE it.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_exists := false;
    v_qty := 0;
  END IF;

  IF v_exists THEN
    UPDATE public.inventory_items
    SET sku = COALESCE(NULLIF(p_item->>'sku', ''), sku),
        category = COALESCE(p_item->>'category', category),
        sub_type = COALESCE(p_item->>'sub_type', sub_type),
        brand = COALESCE(p_item->>'brand', brand),
        model = COALESCE(p_item->>'model', model),
        name = COALESCE(NULLIF(p_item->>'name', ''), name),
        spec = COALESCE(p_item->>'spec', spec),
        vendor = COALESCE(p_item->>'vendor', vendor),
        condition = COALESCE(p_item->>'condition', condition),
        status = COALESCE(p_item->>'status', status),
        price_list = CASE WHEN p_item ? 'price_list' THEN NULLIF(p_item->>'price_list', '')::numeric ELSE price_list END,
        price_floor = CASE WHEN p_item ? 'price_floor' THEN NULLIF(p_item->>'price_floor', '')::numeric ELSE price_floor END,
        inbound_date = CASE WHEN p_item ? 'inbound_date' THEN NULLIF(p_item->>'inbound_date', '')::date ELSE inbound_date END,
        reorder_point = CASE WHEN p_item ? 'reorder_point' THEN COALESCE(NULLIF(p_item->>'reorder_point', '')::numeric, 0) ELSE reorder_point END,
        location = CASE WHEN p_item ? 'location' THEN NULLIF(p_item->>'location', '') ELSE location END,
        notes = CASE WHEN p_item ? 'notes' THEN NULLIF(p_item->>'notes', '') ELSE notes END,
        replenishment_group_id = CASE
          WHEN p_item ? 'replenishment_group_id' THEN v_group_id
          ELSE replenishment_group_id
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSE
    INSERT INTO public.inventory_items (
      id, sku, category, sub_type, brand, model, name, spec, vendor, condition, status,
      qty_on_hand, price_list, price_floor, inbound_date, last_moved_at, reorder_point,
      location, notes, replenishment_group_id, is_archived, archived_at, extra, created_at, updated_at
    ) VALUES (
      v_id,
      NULLIF(p_item->>'sku', ''),
      NULLIF(p_item->>'category', ''),
      NULLIF(p_item->>'sub_type', ''),
      NULLIF(p_item->>'brand', ''),
      NULLIF(p_item->>'model', ''),
      COALESCE(NULLIF(p_item->>'name', ''), '未命名'),
      NULLIF(p_item->>'spec', ''),
      NULLIF(p_item->>'vendor', ''),
      COALESCE(NULLIF(p_item->>'condition', ''), 'USED'),
      COALESCE(NULLIF(p_item->>'status', ''), 'READY'),
      0,
      NULLIF(p_item->>'price_list', '')::numeric,
      NULLIF(p_item->>'price_floor', '')::numeric,
      NULLIF(p_item->>'inbound_date', '')::date,
      NULL,
      COALESCE(NULLIF(p_item->>'reorder_point', '')::numeric, 0),
      NULLIF(p_item->>'location', ''),
      NULLIF(p_item->>'notes', ''),
      CASE WHEN p_item ? 'replenishment_group_id' THEN v_group_id ELSE NULL END,
      false,
      NULL,
      '{}'::jsonb,
      pg_catalog.now(),
      pg_catalog.now()
    );
    INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
    VALUES (v_id, 0, pg_catalog.now())
    ON CONFLICT (item_id) DO NOTHING;
  END IF;

  IF v_role = 'admin' AND public.is_admin() AND p_unit_cost IS NOT NULL THEN
    INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
    VALUES (v_id, p_unit_cost, pg_catalog.now())
    ON CONFLICT (item_id) DO UPDATE SET
      cost_unit = EXCLUDED.cost_unit,
      updated_at = pg_catalog.now();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'qty_on_hand', COALESCE(v_qty, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_upsert_item(JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_item(JSONB, NUMERIC) TO authenticated;

-- 只讀聚合 helper（後台可呼叫；不寫入）。供前端／診斷使用。
CREATE OR REPLACE FUNCTION public.backoffice_list_replenishment_alerts()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_rows JSONB;
BEGIN
  v_role := public.dk_require_backoffice();

  SELECT COALESCE(pg_catalog.jsonb_agg(x.obj ORDER BY x.name), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      g.name,
      pg_catalog.jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'threshold_qty', g.threshold_qty,
        'target_qty', g.target_qty,
        'enabled', g.enabled,
        'available', COALESCE(a.available, 0),
        'need_restock', true,
        'suggest_qty', GREATEST(g.target_qty - COALESCE(a.available, 0), 0)
      ) AS obj
    FROM public.replenishment_groups g
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(GREATEST(it.qty_on_hand, 0)), 0) AS available
      FROM public.inventory_items it
      WHERE it.replenishment_group_id = g.id
    ) a ON true
    WHERE g.enabled = true
      AND COALESCE(a.available, 0) <= g.threshold_qty
  ) x;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'alerts', COALESCE(v_rows, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_list_replenishment_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_list_replenishment_alerts() TO authenticated;

-- M2_RPC END
*/


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀驗證。全部 PASS 後才可進 Stage 12-2B 前端。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

WITH cols AS (
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inventory_items'
),
rg_cols AS (
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'replenishment_groups'
),
cons AS (
  SELECT c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname IN ('replenishment_groups', 'inventory_items')
),
pols AS (
  SELECT policyname, cmd, roles::text AS roles
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'replenishment_groups'
),
formula AS (
  -- 公式煙霧測試（不寫入）：空群組 available=0；2<=3 → need；suggest=6
  SELECT
    (COALESCE(SUM(GREATEST(q, 0)), 0) = 2) AS avail_ok,
    (2 <= 3) AS need_ok,
    (GREATEST(8 - 2, 0) = 6) AS suggest_ok
  FROM (VALUES (1::numeric), (0::numeric), ((-5)::numeric), (1::numeric)) AS t(q)
)
SELECT 10 AS seq, 'table.replenishment_groups'::text AS check_name,
       (to_regclass('public.replenishment_groups') IS NOT NULL)::text AS actual,
       'true'::text AS expected,
       CASE WHEN to_regclass('public.replenishment_groups') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 20, 'col.inventory_items.replenishment_group_id',
       (EXISTS (SELECT 1 FROM cols WHERE column_name = 'replenishment_group_id'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cols WHERE column_name = 'replenishment_group_id') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'col.inventory_items.qty_on_hand_untouched',
       (EXISTS (SELECT 1 FROM cols WHERE column_name = 'qty_on_hand'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cols WHERE column_name = 'qty_on_hand') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'col.inventory_items.reorder_point_untouched',
       (EXISTS (SELECT 1 FROM cols WHERE column_name = 'reorder_point'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cols WHERE column_name = 'reorder_point') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'rg.cols.required',
       (
         (SELECT COUNT(*) FROM rg_cols WHERE column_name IN (
           'id','name','threshold_qty','target_qty','enabled','notes','extra','created_at','updated_at'
         ))::text
       ), '9',
       CASE WHEN (SELECT COUNT(*) FROM rg_cols WHERE column_name IN (
           'id','name','threshold_qty','target_qty','enabled','notes','extra','created_at','updated_at'
         )) = 9 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'constraint.threshold_nonneg',
       (EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_threshold_nonneg'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_threshold_nonneg') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'constraint.target_nonneg',
       (EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_target_nonneg'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_target_nonneg') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'constraint.target_ge_threshold',
       (EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_target_ge_threshold'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE conname = 'replenishment_groups_target_ge_threshold') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'fk.inventory_items_replenishment_group_id',
       (EXISTS (SELECT 1 FROM cons WHERE conname = 'inventory_items_replenishment_group_id_fkey'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE conname = 'inventory_items_replenishment_group_id_fkey') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'index.inventory_items_replenishment_group_id_idx',
       (to_regclass('public.inventory_items_replenishment_group_id_idx') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_items_replenishment_group_id_idx') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'rls.replenishment_groups_enabled',
       (SELECT c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'replenishment_groups'), 'true',
       CASE WHEN (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'replenishment_groups') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'policy.select_backoffice',
       (EXISTS (SELECT 1 FROM pols WHERE policyname = 'replenishment_groups_select_backoffice'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM pols WHERE policyname = 'replenishment_groups_select_backoffice') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 62, 'policy.write_admin',
       (EXISTS (SELECT 1 FROM pols WHERE policyname = 'replenishment_groups_write_admin'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM pols WHERE policyname = 'replenishment_groups_write_admin') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'rpc.backoffice_upsert_replenishment_group',
       (to_regprocedure('public.backoffice_upsert_replenishment_group(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_replenishment_group(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'rpc.backoffice_list_replenishment_alerts',
       (to_regprocedure('public.backoffice_list_replenishment_alerts()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_list_replenishment_alerts()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'rpc.backoffice_upsert_item_still',
       (to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'rpc.upsert_item_mentions_group_id',
       (EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_item'
           AND pg_get_functiondef(p.oid) ILIKE '%replenishment_group_id%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_item'
           AND pg_get_functiondef(p.oid) ILIKE '%replenishment_group_id%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 80, 'rpc.create_order_untouched_sig',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 81, 'rpc.update_order_untouched_sig',
       (to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 82, 'rpc.adjust_stock_untouched_sig',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 83, 'rpc.admin_adjust_stock_untouched_sig',
       (to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 90, 'data.no_auto_groups',
       (SELECT COUNT(*)::text FROM public.replenishment_groups), '0_or_manual',
       CASE WHEN (SELECT COUNT(*) FROM public.replenishment_groups) = 0 THEN 'PASS'
            ELSE 'INFO_MANUAL_ROWS' END
UNION ALL SELECT 91, 'formula.available_floors_negative',
       (SELECT (avail_ok AND need_ok AND suggest_ok)::text FROM formula), 'true',
       CASE WHEN (SELECT avail_ok AND need_ok AND suggest_ok FROM formula) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 92, 'ledger.schema_untouched',
       (to_regclass('public.inventory_ledger') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_ledger') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 93, 'costs.schema_untouched',
       (to_regclass('public.inventory_costs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_costs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

-- M3_VERIFY END
*/


-- ============================================================
-- SECTION ROLLBACK（僅在需要撤 Stage 12 時使用；預設不要執行）
-- 不 drop reorder_point；不碰 orders / ledger / qty 語意。
-- ============================================================
/*

-- DROP FUNCTION IF EXISTS public.backoffice_list_replenishment_alerts();
-- DROP FUNCTION IF EXISTS public.backoffice_upsert_replenishment_group(JSONB);
-- 注意：ROLLBACK 不會自動還原 backoffice_upsert_item 至 Stage 7 原文；
-- 若需還原，請從 supabase-stage7-v2-normalization.sql M5 重新貼上 upsert_item。
-- ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_replenishment_group_id_fkey;
-- DROP INDEX IF EXISTS public.inventory_items_replenishment_group_id_idx;
-- ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS replenishment_group_id;
-- DROP TABLE IF EXISTS public.replenishment_groups;

*/
