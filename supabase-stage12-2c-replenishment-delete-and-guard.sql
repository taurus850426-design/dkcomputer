-- ============================================================
-- DK Computer Stage 12-2C：Replenishment Group Delete + Staff Guard
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_RPC → M1_VERIFY
--
-- 本 Stage：
--   + backoffice_delete_replenishment_group(text)  Admin-only
--   + backoffice_upsert_item 對 Staff 強制：
--       category ∈ {記憶體,硬碟,電源供應器} 且 replenishment_group_id 為空 → 拒絕
--       Admin 不受限（可略過）
--
-- 禁止：
--   改 qty_on_hand / ledger / costs / orders
--   改 adjust_stock / create_order / update_order 核心
--   drop reorder_point
--   自動 migration / 自動綁 group
--   改 is_admin() / dk_require_backoffice() 語意
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 Stage 12 物件與 FK ON DELETE SET NULL 仍在。
-- ============================================================
/*

SELECT 'replenishment_groups' AS obj,
       (to_regclass('public.replenishment_groups') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.replenishment_groups') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'inventory_items.replenishment_group_id',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'replenishment_group_id'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'replenishment_group_id'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'fk.on_delete_set_null',
       COALESCE((
         SELECT CASE WHEN pg_get_constraintdef(c.oid) ILIKE '%ON DELETE SET NULL%' THEN 'true' ELSE 'false' END
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
           AND c.conname = 'inventory_items_replenishment_group_id_fkey'
       ), 'missing'), 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
           AND c.conname = 'inventory_items_replenishment_group_id_fkey'
           AND pg_get_constraintdef(c.oid) ILIKE '%ON DELETE SET NULL%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.upsert_replenishment_group',
       (to_regprocedure('public.backoffice_upsert_replenishment_group(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_replenishment_group(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.upsert_item',
       (to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.delete_group_absent_before',
       (to_regprocedure('public.backoffice_delete_replenishment_group(text)') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regprocedure('public.backoffice_delete_replenishment_group(text)') IS NULL THEN 'PASS'
            ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'rpc.create_order_untouched',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.adjust_stock_untouched',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

-- PREFLIGHT END
*/


-- ============================================================
-- SECTION M0_RPC
-- 1) backoffice_delete_replenishment_group(text) Admin-only
-- 2) backoffice_upsert_item：Staff 對必填品類不可省略 group；Admin 可略過
-- 不改 create_order / update_order / adjust_stock*
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.replenishment_groups') IS NULL THEN
    RAISE EXCEPTION 'M0_RPC blocked: replenishment_groups missing';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M0_RPC blocked: auth helpers missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
      AND c.conname = 'inventory_items_replenishment_group_id_fkey'
      AND pg_get_constraintdef(c.oid) ILIKE '%ON DELETE SET NULL%'
  ) THEN
    RAISE EXCEPTION 'M0_RPC blocked: FK ON DELETE SET NULL missing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_delete_replenishment_group(
  p_group_id TEXT
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
  v_member_count BIGINT := 0;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  v_id := NULLIF(btrim(COALESCE(p_group_id, '')), '');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'group_id required';
  END IF;

  SELECT g.name INTO v_name
  FROM public.replenishment_groups g
  WHERE g.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group not found';
  END IF;

  SELECT COUNT(*) INTO v_member_count
  FROM public.inventory_items it
  WHERE it.replenishment_group_id = v_id;

  -- FK ON DELETE SET NULL：成員 item 保留；僅清空 replenishment_group_id。
  DELETE FROM public.replenishment_groups
  WHERE id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'name', v_name,
    'unbound_count', COALESCE(v_member_count, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_delete_replenishment_group(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_delete_replenishment_group(TEXT) TO authenticated;

-- Additive REPLACE：保留 Stage 12 group 欄位語意；新增 Staff 必填品類防漏。
-- 必填品類（與前端常數）：記憶體 / 硬碟 / 電源供應器
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
  v_category TEXT;
  v_require_group BOOLEAN := false;
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

  IF p_item ? 'replenishment_group_id' THEN
    v_group_id := NULLIF(btrim(COALESCE(p_item->>'replenishment_group_id', '')), '');
    IF v_group_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.replenishment_groups g WHERE g.id = v_group_id
    ) THEN
      RAISE EXCEPTION 'replenishment group not found';
    END IF;
  ELSE
    v_group_id := NULL;
  END IF;

  SELECT true, it.qty_on_hand INTO v_exists, v_qty
  FROM public.inventory_items it
  WHERE it.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_exists := false;
    v_qty := 0;
  END IF;

  -- 決定儲存後的 category（UPDATE 時若 payload 未帶 category 則沿用舊值）
  IF v_exists THEN
    SELECT COALESCE(NULLIF(p_item->>'category', ''), it.category, '') INTO v_category
    FROM public.inventory_items it
    WHERE it.id = v_id;
  ELSE
    v_category := COALESCE(NULLIF(p_item->>'category', ''), '');
  END IF;

  v_require_group := v_category IN ('記憶體', '硬碟', '電源供應器');

  -- Staff 不可略過；Admin 可略過。僅在本次 payload 有帶 replenishment_group_id
  -- 或新建品項時檢查（避免舊流程未帶 key 時誤傷）。
  IF v_role IS DISTINCT FROM 'admin' AND v_require_group THEN
    IF (NOT v_exists) OR (p_item ? 'replenishment_group_id') THEN
      IF (
        CASE
          WHEN p_item ? 'replenishment_group_id' THEN v_group_id
          ELSE NULL
        END
      ) IS NULL THEN
        -- 新建：必須有 group。更新且明確送 null：拒絕。
        IF (NOT v_exists) OR (p_item ? 'replenishment_group_id' AND v_group_id IS NULL) THEN
          RAISE EXCEPTION 'replenishment group required' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
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
    -- Staff 新建必填品類：上面已擋；此處 INSERT
    IF v_role IS DISTINCT FROM 'admin' AND v_require_group AND (
      CASE WHEN p_item ? 'replenishment_group_id' THEN v_group_id ELSE NULL END
    ) IS NULL THEN
      RAISE EXCEPTION 'replenishment group required' USING ERRCODE = 'P0001';
    END IF;

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

-- M0_RPC END
*/


-- ============================================================
-- SECTION M1_VERIFY
-- 只讀驗證。
-- ============================================================
/*

SELECT 10 AS seq, 'rpc.delete_replenishment_group'::text AS check_name,
       (to_regprocedure('public.backoffice_delete_replenishment_group(text)') IS NOT NULL)::text AS actual,
       'true'::text AS expected,
       CASE WHEN to_regprocedure('public.backoffice_delete_replenishment_group(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'rpc.delete_is_admin_guard',
       (EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_delete_replenishment_group'
           AND pg_get_functiondef(p.oid) ILIKE '%admin only%'
           AND pg_get_functiondef(p.oid) ILIKE '%is_admin()%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_delete_replenishment_group'
           AND pg_get_functiondef(p.oid) ILIKE '%admin only%'
           AND pg_get_functiondef(p.oid) ILIKE '%is_admin()%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'rpc.delete_no_qty_write',
       (EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_delete_replenishment_group'
           AND pg_get_functiondef(p.oid) NOT ILIKE '%qty_on_hand%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_delete_replenishment_group'
           AND pg_get_functiondef(p.oid) NOT ILIKE '%qty_on_hand%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'rpc.upsert_item_staff_group_guard',
       (EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_item'
           AND pg_get_functiondef(p.oid) ILIKE '%replenishment group required%'
           AND pg_get_functiondef(p.oid) ILIKE '%記憶體%'
           AND pg_get_functiondef(p.oid) ILIKE '%硬碟%'
           AND pg_get_functiondef(p.oid) ILIKE '%電源供應器%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_item'
           AND pg_get_functiondef(p.oid) ILIKE '%replenishment group required%'
           AND pg_get_functiondef(p.oid) ILIKE '%記憶體%'
           AND pg_get_functiondef(p.oid) ILIKE '%硬碟%'
           AND pg_get_functiondef(p.oid) ILIKE '%電源供應器%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'fk.on_delete_set_null_still',
       (EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
           AND c.conname = 'inventory_items_replenishment_group_id_fkey'
           AND pg_get_constraintdef(c.oid) ILIKE '%ON DELETE SET NULL%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'inventory_items'
           AND c.conname = 'inventory_items_replenishment_group_id_fkey'
           AND pg_get_constraintdef(c.oid) ILIKE '%ON DELETE SET NULL%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'rpc.create_order_untouched_sig',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'rpc.update_order_untouched_sig',
       (to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'rpc.adjust_stock_untouched_sig',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'rpc.admin_adjust_stock_untouched_sig',
       (to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'col.qty_on_hand_still',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'col.reorder_point_still',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reorder_point'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'reorder_point'
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

-- M1_VERIFY END
*/


-- ============================================================
-- SECTION ROLLBACK（僅撤 12-2C；預設不要執行）
-- ============================================================
/*

-- DROP FUNCTION IF EXISTS public.backoffice_delete_replenishment_group(TEXT);
-- 還原 upsert_item：請從 supabase-stage12-replenishment-groups.sql M2_RPC 重貼 Stage 12 版（無 Staff guard）。

*/
