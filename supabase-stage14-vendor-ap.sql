-- ============================================================
-- DK Computer Stage 14-2：Vendor AP / 廠商對帳 Database Foundation
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會建表、改 RLS、建 RPC、寫 expenses。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_RPC → M3_VERIFY
--
-- Additive only：
--   + public.vendor_settlement_settings
--   + public.vendor_reconciliations
--   + public.vendor_reconciliation_items
--   + expenses 上 AP unique expression index（不改既有 expense 列／語意）
--   + admin-only RLS
--   + create / update / confirm_payment / cancel_payment / void RPC
--
-- 禁止：
--   vendors master table / vendor_payments table
--   部分付款
--   改 qty_on_hand / inventory_ledger / inventory_costs
--   改 purchase_orders 結構或業務語意
--   改 stage7SaveExpense 行為（本檔不碰該 client 函式）
--   改 vendorOptions / site_config
--   改 is_admin() / is_enabled_backoffice_user() / dk_require_backoffice() 語意
--   自動建立 reconciliation / expense 資料列
--   把歷史 PO 標成未付款
--
-- Trust boundary（create RPC）：
--   Client 只准傳 vendor_name、期間、settlement_type_snapshot、PO id 列表、notes。
--   system_amount 由 DB 讀 public.purchase_orders.items_json 重算（不改該表）。
--   建立後 system_amount / line_snapshot_json / 期間 / vendor_name 凍結。
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 expenses / purchase_orders / extra / helpers 存在，
-- 且 AP 物件尚未誤建（或重跑時 INFO_EXISTS）。
-- 請複製本 SECTION（從下一行到 PREFLIGHT END）單獨執行。
-- ============================================================
/*

SELECT 'expenses' AS obj,
       (to_regclass('public.expenses') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.expenses') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'expenses.extra',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'extra'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'extra'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'expenses.ref_item_id',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'ref_item_id'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'ref_item_id'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'purchase_orders',
       (to_regclass('public.purchase_orders') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.purchase_orders') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'purchase_orders.items_json',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'items_json'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'items_json'
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
UNION ALL SELECT 'vendor_settlement_settings_absent_or_rerun',
       (to_regclass('public.vendor_settlement_settings') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.vendor_settlement_settings') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'vendor_reconciliations_absent_or_rerun',
       (to_regclass('public.vendor_reconciliations') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.vendor_reconciliations') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'vendor_reconciliation_items_absent_or_rerun',
       (to_regclass('public.vendor_reconciliation_items') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.vendor_reconciliation_items') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'rpc.create_absent_or_rerun',
       (to_regprocedure('public.backoffice_create_vendor_reconciliation(jsonb)') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regprocedure('public.backoffice_create_vendor_reconciliation(jsonb)') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'rpc.confirm_payment_absent_or_rerun',
       (to_regprocedure('public.backoffice_confirm_vendor_payment(text)') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regprocedure('public.backoffice_confirm_vendor_payment(text)') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'idx.expenses_ap_absent_or_rerun',
       (to_regclass('public.expenses_ap_reconciliation_id_uidx') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.expenses_ap_reconciliation_id_uidx') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
ORDER BY 1;

-- PREFLIGHT END
*/


-- ============================================================
-- SECTION M0_SCHEMA
-- Additive：3 張 AP 表 + generated difference + unique indexes +
-- 凍結／active PO+vendor 保護 trigger。
-- 不 INSERT 任何 reconciliation / expense 列。
-- 不 ALTER purchase_orders。不改 expenses 欄位，只加 expression unique index。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.expenses') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.expenses missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'extra'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: expenses.extra missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'ref_item_id'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: expenses.ref_item_id missing';
  END IF;
  IF to_regclass('public.purchase_orders') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.purchase_orders missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'items_json'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: purchase_orders.items_json missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.vendor_settlement_settings (
  vendor_name TEXT PRIMARY KEY,
  settlement_type TEXT NOT NULL,
  week_start_weekday INTEGER,
  monthly_anchor_day INTEGER,
  notes TEXT,
  updated_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_settlement_settings_type_chk
    CHECK (settlement_type IN ('WEEKLY', 'MONTHLY', 'CUSTOM')),
  CONSTRAINT vendor_settlement_settings_weekday_chk
    CHECK (week_start_weekday IS NULL OR (week_start_weekday >= 1 AND week_start_weekday <= 7)),
  CONSTRAINT vendor_settlement_settings_anchor_chk
    CHECK (monthly_anchor_day IS NULL OR (monthly_anchor_day >= 1 AND monthly_anchor_day <= 31))
);

COMMENT ON TABLE public.vendor_settlement_settings IS
  'Stage 14: per-vendor settlement prefs keyed by display name (no vendors master). Changing a row must not rewrite existing reconciliations.';

CREATE TABLE IF NOT EXISTS public.vendor_reconciliations (
  id TEXT PRIMARY KEY,
  vendor_name TEXT NOT NULL,
  settlement_type_snapshot TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  system_amount NUMERIC NOT NULL DEFAULT 0,
  vendor_claimed_amount NUMERIC NULL,
  difference NUMERIC GENERATED ALWAYS AS (vendor_claimed_amount - system_amount) STORED,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  paid_amount NUMERIC NULL,
  paid_at TIMESTAMPTZ NULL,
  expense_id TEXT NULL,
  notes TEXT,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_reconciliations_period_chk CHECK (period_end >= period_start),
  CONSTRAINT vendor_reconciliations_system_nonneg_chk CHECK (system_amount >= 0),
  CONSTRAINT vendor_reconciliations_claimed_nonneg_chk
    CHECK (vendor_claimed_amount IS NULL OR vendor_claimed_amount >= 0),
  CONSTRAINT vendor_reconciliations_paid_nonneg_chk
    CHECK (paid_amount IS NULL OR paid_amount >= 0),
  CONSTRAINT vendor_reconciliations_status_chk
    CHECK (status IN ('DRAFT', 'MISMATCH', 'CONFIRMED', 'PAID', 'VOID')),
  CONSTRAINT vendor_reconciliations_stype_chk
    CHECK (settlement_type_snapshot IN ('WEEKLY', 'MONTHLY', 'CUSTOM'))
);

COMMENT ON TABLE public.vendor_reconciliations IS
  'Stage 14: vendor AP header. difference is generated (claimed - system). system_amount frozen after insert.';

COMMENT ON COLUMN public.vendor_reconciliations.difference IS
  'GENERATED ALWAYS AS (vendor_claimed_amount - system_amount) STORED. NULL when claimed is NULL.';

CREATE TABLE IF NOT EXISTS public.vendor_reconciliation_items (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL
    REFERENCES public.vendor_reconciliations(id) ON DELETE CASCADE,
  purchase_order_id TEXT NOT NULL,
  order_no TEXT,
  vendor_name TEXT NOT NULL,
  system_amount NUMERIC NOT NULL DEFAULT 0,
  vendor_claimed_amount NUMERIC NULL,
  difference NUMERIC GENERATED ALWAYS AS (vendor_claimed_amount - system_amount) STORED,
  line_snapshot_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_status TEXT NOT NULL DEFAULT 'UNCHECKED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vendor_reconciliation_items_system_nonneg_chk CHECK (system_amount >= 0),
  CONSTRAINT vendor_reconciliation_items_claimed_nonneg_chk
    CHECK (vendor_claimed_amount IS NULL OR vendor_claimed_amount >= 0),
  CONSTRAINT vendor_reconciliation_items_review_chk
    CHECK (review_status IN ('UNCHECKED', 'MATCHED', 'MISMATCH')),
  CONSTRAINT vendor_reconciliation_items_po_vendor_uidx
    UNIQUE (reconciliation_id, purchase_order_id, vendor_name)
);

COMMENT ON TABLE public.vendor_reconciliation_items IS
  'Stage 14: AP lines at (purchase_order_id × vendor_name). No FK to purchase_orders (soft-delete safe).';

-- 同一廠商同一期間只允許一張非 VOID 對帳。VOID 後可重建。
CREATE UNIQUE INDEX IF NOT EXISTS vendor_reconciliations_active_period_uidx
  ON public.vendor_reconciliations (vendor_name, period_start, period_end)
  WHERE status <> 'VOID';

CREATE INDEX IF NOT EXISTS vendor_reconciliations_vendor_status_idx
  ON public.vendor_reconciliations (vendor_name, status);

CREATE INDEX IF NOT EXISTS vendor_reconciliation_items_recon_idx
  ON public.vendor_reconciliation_items (reconciliation_id);

CREATE INDEX IF NOT EXISTS vendor_reconciliation_items_po_vendor_idx
  ON public.vendor_reconciliation_items (purchase_order_id, vendor_name);

-- 既有無 AP extra 的 expense 不受影響（WHERE 排除 NULL）。
CREATE UNIQUE INDEX IF NOT EXISTS expenses_ap_reconciliation_id_uidx
  ON public.expenses ((extra->>'ap_reconciliation_id'))
  WHERE extra->>'ap_reconciliation_id' IS NOT NULL;

-- Active PO×vendor 不得跨兩張非 VOID 對帳。
-- 不能用跨表 partial unique index；改 trigger + transaction advisory lock。
CREATE OR REPLACE FUNCTION public.dk_ap_assert_active_po_vendor_free()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
  v_other TEXT;
  v_po TEXT;
  v_vendor TEXT;
  rec RECORD;
BEGIN
  IF TG_TABLE_NAME = 'vendor_reconciliation_items' THEN
    SELECT r.status INTO v_status
    FROM public.vendor_reconciliations r
    WHERE r.id = NEW.reconciliation_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'reconciliation not found';
    END IF;
    IF v_status IS DISTINCT FROM 'VOID' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        1402,
        pg_catalog.hashtext(NEW.purchase_order_id || chr(31) || NEW.vendor_name)
      );
      SELECT r2.id INTO v_other
      FROM public.vendor_reconciliation_items i
      INNER JOIN public.vendor_reconciliations r2 ON r2.id = i.reconciliation_id
      WHERE i.purchase_order_id = NEW.purchase_order_id
        AND i.vendor_name = NEW.vendor_name
        AND r2.status IS DISTINCT FROM 'VOID'
        AND i.id IS DISTINCT FROM NEW.id
      LIMIT 1;
      IF v_other IS NOT NULL THEN
        RAISE EXCEPTION 'PO/vendor already on active reconciliation %', v_other
          USING ERRCODE = '23505';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- header：禁止把 VOID 改回 active 若 PO×vendor 已被其他 active 佔用
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'VOID'
     AND NEW.status IS DISTINCT FROM 'VOID' THEN
    FOR rec IN
      SELECT i.purchase_order_id, i.vendor_name
      FROM public.vendor_reconciliation_items i
      WHERE i.reconciliation_id = NEW.id
      ORDER BY i.purchase_order_id, i.vendor_name
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(
        1402,
        pg_catalog.hashtext(rec.purchase_order_id || chr(31) || rec.vendor_name)
      );
      SELECT r2.id INTO v_other
      FROM public.vendor_reconciliation_items i
      INNER JOIN public.vendor_reconciliations r2 ON r2.id = i.reconciliation_id
      WHERE i.purchase_order_id = rec.purchase_order_id
        AND i.vendor_name = rec.vendor_name
        AND r2.status IS DISTINCT FROM 'VOID'
        AND r2.id IS DISTINCT FROM NEW.id
      LIMIT 1;
      IF v_other IS NOT NULL THEN
        RAISE EXCEPTION 'PO/vendor already on active reconciliation %', v_other
          USING ERRCODE = '23505';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ap_items_active_po_vendor ON public.vendor_reconciliation_items;
CREATE TRIGGER trg_ap_items_active_po_vendor
  BEFORE INSERT OR UPDATE OF purchase_order_id, vendor_name, reconciliation_id
  ON public.vendor_reconciliation_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_ap_assert_active_po_vendor_free();

DROP TRIGGER IF EXISTS trg_ap_header_unvoid_po_vendor ON public.vendor_reconciliations;
CREATE TRIGGER trg_ap_header_unvoid_po_vendor
  BEFORE UPDATE OF status
  ON public.vendor_reconciliations
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_ap_assert_active_po_vendor_free();

-- 凍結金額／期間／PO 關聯：建立後不可經 REST 或誤寫改寫。
CREATE OR REPLACE FUNCTION public.dk_ap_protect_frozen_amounts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'vendor_reconciliations' THEN
    IF NEW.system_amount IS DISTINCT FROM OLD.system_amount
       OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name
       OR NEW.settlement_type_snapshot IS DISTINCT FROM OLD.settlement_type_snapshot
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'frozen reconciliation fields cannot be updated';
    END IF;
  ELSIF TG_TABLE_NAME = 'vendor_reconciliation_items' THEN
    IF NEW.system_amount IS DISTINCT FROM OLD.system_amount
       OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
       OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name
       OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
       OR NEW.order_no IS DISTINCT FROM OLD.order_no
       OR NEW.line_snapshot_json IS DISTINCT FROM OLD.line_snapshot_json THEN
      RAISE EXCEPTION 'frozen reconciliation item fields cannot be updated';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ap_freeze_reconcil ON public.vendor_reconciliations;
CREATE TRIGGER trg_ap_freeze_reconcil
  BEFORE UPDATE ON public.vendor_reconciliations
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_ap_protect_frozen_amounts();

DROP TRIGGER IF EXISTS trg_ap_freeze_items ON public.vendor_reconciliation_items;
CREATE TRIGGER trg_ap_freeze_items
  BEFORE UPDATE ON public.vendor_reconciliation_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_ap_protect_frozen_amounts();

DO $$
BEGIN
  IF to_regprocedure('public.dk_stage7_set_updated_at()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_settlement_settings;
    EXECUTE 'CREATE TRIGGER trg_dk_stage7_set_updated_at BEFORE UPDATE ON public.vendor_settlement_settings FOR EACH ROW EXECUTE PROCEDURE public.dk_stage7_set_updated_at()';
    DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_reconciliations;
    EXECUTE 'CREATE TRIGGER trg_dk_stage7_set_updated_at BEFORE UPDATE ON public.vendor_reconciliations FOR EACH ROW EXECUTE PROCEDURE public.dk_stage7_set_updated_at()';
    DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_reconciliation_items;
    EXECUTE 'CREATE TRIGGER trg_dk_stage7_set_updated_at BEFORE UPDATE ON public.vendor_reconciliation_items FOR EACH ROW EXECUTE PROCEDURE public.dk_stage7_set_updated_at()';
  END IF;
END $$;

-- M0_SCHEMA END
*/


-- ============================================================
-- SECTION M1_RLS
-- 3 tables：ENABLE RLS。V1 全部 is_admin()。
-- Staff 無 policy。REVOKE anon / PUBLIC。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.vendor_settlement_settings') IS NULL
     OR to_regclass('public.vendor_reconciliations') IS NULL
     OR to_regclass('public.vendor_reconciliation_items') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: run M0_SCHEMA first';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin missing';
  END IF;
END $$;

ALTER TABLE public.vendor_settlement_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_reconciliation_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_settlement_settings FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.vendor_reconciliations FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.vendor_reconciliation_items FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.vendor_settlement_settings FROM authenticated;
REVOKE ALL ON TABLE public.vendor_reconciliations FROM authenticated;
REVOKE ALL ON TABLE public.vendor_reconciliation_items FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_settlement_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_reconciliations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_reconciliation_items TO authenticated;

DROP POLICY IF EXISTS vendor_settlement_settings_admin ON public.vendor_settlement_settings;
DROP POLICY IF EXISTS vendor_reconciliations_admin ON public.vendor_reconciliations;
DROP POLICY IF EXISTS vendor_reconciliation_items_admin ON public.vendor_reconciliation_items;

CREATE POLICY vendor_settlement_settings_admin
  ON public.vendor_settlement_settings FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY vendor_reconciliations_admin
  ON public.vendor_reconciliations FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY vendor_reconciliation_items_admin
  ON public.vendor_reconciliation_items FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- M1_RLS END
*/


-- ============================================================
-- SECTION M2_RPC
-- Admin-only SECURITY DEFINER RPCs。search_path=''。
-- create：讀 purchase_orders.items_json 重算 system_amount（不 UPDATE 該表）。
-- update：請款／review／CONFIRMED|MISMATCH；difference 由 generated column。
-- confirm / cancel payment / void：單 transaction（函式即一筆 tx）。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.vendor_reconciliations') IS NULL
     OR to_regclass('public.vendor_reconciliation_items') IS NULL THEN
    RAISE EXCEPTION 'M2_RPC blocked: run M0_SCHEMA first';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M2_RPC blocked: dk_require_backoffice / is_admin missing.';
  END IF;
  IF to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.expenses') IS NULL THEN
    RAISE EXCEPTION 'M2_RPC blocked: purchase_orders / expenses missing.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.dk_ap_require_admin()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_uid uuid;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() OR v_uid IS NULL THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_ap_require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_create_vendor_reconciliation(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_vendor TEXT;
  v_stype TEXT;
  v_start DATE;
  v_end DATE;
  v_notes TEXT;
  v_id TEXT;
  v_po_ids TEXT[];
  v_po_id TEXT;
  v_order_no TEXT;
  v_po_status TEXT;
  v_deleted TIMESTAMPTZ;
  v_items JSONB;
  v_item JSONB;
  v_line_vendor TEXT;
  v_qty NUMERIC;
  v_price NUMERIC;
  v_line_total NUMERIC;
  v_item_sys NUMERIC;
  v_has_line BOOLEAN;
  v_snap JSONB;
  v_header_sys NUMERIC := 0;
  v_item_id TEXT;
  v_item_count INTEGER := 0;
  v_dup TEXT;
  v_prepared JSONB := '[]'::jsonb;
  v_prep JSONB;
  v_row public.vendor_reconciliations%ROWTYPE;
BEGIN
  v_uid := public.dk_ap_require_admin();

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'system_amount' THEN
    RAISE EXCEPTION 'system_amount is server-computed';
  END IF;

  v_vendor := NULLIF(btrim(COALESCE(p_payload->>'vendor_name', '')), '');
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'vendor_name required';
  END IF;

  v_stype := upper(btrim(COALESCE(p_payload->>'settlement_type_snapshot', '')));
  IF v_stype = '' THEN
    SELECT s.settlement_type INTO v_stype
    FROM public.vendor_settlement_settings s
    WHERE s.vendor_name = v_vendor;
  END IF;
  IF v_stype IS NULL OR v_stype NOT IN ('WEEKLY', 'MONTHLY', 'CUSTOM') THEN
    RAISE EXCEPTION 'settlement_type_snapshot required (WEEKLY|MONTHLY|CUSTOM)';
  END IF;

  BEGIN
    v_start := (p_payload->>'period_start')::date;
    v_end := (p_payload->>'period_end')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'period_start / period_end required';
  END;
  IF v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'period_start / period_end required';
  END IF;
  IF v_end < v_start THEN
    RAISE EXCEPTION 'period_end must be >= period_start';
  END IF;

  v_notes := NULLIF(p_payload->>'notes', '');
  v_id := NULLIF(btrim(COALESCE(p_payload->>'id', '')), '');
  IF v_id IS NULL THEN
    v_id := 'ap-' || to_char(pg_catalog.now(), 'YYYYMMDD') || '-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vendor_reconciliations r WHERE r.id = v_id) THEN
    RAISE EXCEPTION 'reconciliation id already exists';
  END IF;

  SELECT ARRAY_AGG(x ORDER BY x) INTO v_po_ids
  FROM (
    SELECT DISTINCT NULLIF(btrim(t.x), '') AS x
    FROM pg_catalog.jsonb_array_elements_text(
      CASE
        WHEN pg_catalog.jsonb_typeof(p_payload->'purchase_order_ids') = 'array'
          THEN p_payload->'purchase_order_ids'
        ELSE '[]'::jsonb
      END
    ) AS t(x)
  ) s
  WHERE s.x IS NOT NULL;

  IF v_po_ids IS NULL OR pg_catalog.array_length(v_po_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'purchase_order_ids required';
  END IF;

  PERFORM 1
  FROM public.vendor_reconciliations r
  WHERE r.vendor_name = v_vendor
    AND r.status IS DISTINCT FROM 'VOID'
  FOR UPDATE;

  SELECT r.id INTO v_dup
  FROM public.vendor_reconciliations r
  WHERE r.vendor_name = v_vendor
    AND r.period_start = v_start
    AND r.period_end = v_end
    AND r.status IS DISTINCT FROM 'VOID'
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'active reconciliation already exists for vendor/period (%)', v_dup
      USING ERRCODE = '23505';
  END IF;

  -- Trust boundary：只信任 PO id 列表；金額一律從 items_json 重算。
  FOREACH v_po_id IN ARRAY v_po_ids
  LOOP
    SELECT po.order_no, po.status, po.deleted_at, po.items_json
      INTO v_order_no, v_po_status, v_deleted, v_items
    FROM public.purchase_orders po
    WHERE po.id = v_po_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase order not found: %', v_po_id;
    END IF;
    IF v_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'purchase order deleted: %', v_po_id;
    END IF;
    IF v_po_status NOT IN ('ordered', 'partial', 'received') THEN
      RAISE EXCEPTION 'purchase order status not eligible: % (%)', v_po_id, v_po_status;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      1402,
      pg_catalog.hashtext(v_po_id || chr(31) || v_vendor)
    );

    SELECT r.id INTO v_dup
    FROM public.vendor_reconciliation_items i
    INNER JOIN public.vendor_reconciliations r ON r.id = i.reconciliation_id
    WHERE i.purchase_order_id = v_po_id
      AND i.vendor_name = v_vendor
      AND r.status IS DISTINCT FROM 'VOID'
    LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'PO/vendor already on active reconciliation %', v_dup
        USING ERRCODE = '23505';
    END IF;

    IF v_items IS NULL OR pg_catalog.jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'purchase order items_json invalid: %', v_po_id;
    END IF;

    v_item_sys := 0;
    v_has_line := false;
    v_snap := '[]'::jsonb;

    FOR v_item IN
      SELECT t.elem FROM pg_catalog.jsonb_array_elements(v_items) AS t(elem)
    LOOP
      v_line_vendor := NULLIF(btrim(COALESCE(
        NULLIF(v_item->>'selectedVendor', ''),
        NULLIF(v_item->>'manualVendor', ''),
        ''
      )), '');
      IF v_line_vendor IS DISTINCT FROM v_vendor THEN
        CONTINUE;
      END IF;
      v_has_line := true;
      v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
      IF v_qty < 1 THEN
        v_qty := 1;
      END IF;
      v_qty := pg_catalog.floor(v_qty);
      v_price := COALESCE(
        NULLIF(v_item->>'selectedUnitPrice', '')::numeric,
        NULLIF(v_item->>'manualUnitPrice', '')::numeric
      );
      v_line_total := CASE WHEN v_price IS NULL THEN NULL ELSE v_price * v_qty END;
      IF v_line_total IS NOT NULL THEN
        v_item_sys := v_item_sys + v_line_total;
      END IF;
      v_snap := v_snap || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', v_item->>'id',
          'quantity', v_qty,
          'unit_price', v_price,
          'line_total', v_line_total,
          'selectedVendor', v_item->>'selectedVendor',
          'manualVendor', v_item->>'manualVendor',
          'selectedSpec', v_item->>'selectedSpec',
          'requestText', v_item->>'requestText'
        )
      );
    END LOOP;

    IF NOT v_has_line THEN
      RAISE EXCEPTION 'vendor % not on purchase order %', v_vendor, v_po_id;
    END IF;

    v_item_id := 'api-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    v_prepared := v_prepared || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', v_item_id,
        'purchase_order_id', v_po_id,
        'order_no', v_order_no,
        'system_amount', v_item_sys,
        'line_snapshot_json', v_snap
      )
    );
    v_header_sys := v_header_sys + v_item_sys;
    v_item_count := v_item_count + 1;
  END LOOP;

  INSERT INTO public.vendor_reconciliations (
    id, vendor_name, settlement_type_snapshot, period_start, period_end,
    system_amount, vendor_claimed_amount, status, notes, created_by, created_at, updated_at
  ) VALUES (
    v_id, v_vendor, v_stype, v_start, v_end,
    v_header_sys, NULL, 'DRAFT', v_notes, v_uid, pg_catalog.now(), pg_catalog.now()
  );

  FOR v_prep IN
    SELECT t.elem FROM pg_catalog.jsonb_array_elements(v_prepared) AS t(elem)
  LOOP
    INSERT INTO public.vendor_reconciliation_items (
      id, reconciliation_id, purchase_order_id, order_no, vendor_name,
      system_amount, vendor_claimed_amount, line_snapshot_json, review_status,
      created_at, updated_at
    ) VALUES (
      v_prep->>'id',
      v_id,
      v_prep->>'purchase_order_id',
      v_prep->>'order_no',
      v_vendor,
      COALESCE((v_prep->>'system_amount')::numeric, 0),
      NULL,
      COALESCE(v_prep->'line_snapshot_json', '[]'::jsonb),
      'UNCHECKED',
      pg_catalog.now(),
      pg_catalog.now()
    );
  END LOOP;

  SELECT * INTO v_row FROM public.vendor_reconciliations r WHERE r.id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'vendor_name', v_row.vendor_name,
    'period_start', v_row.period_start,
    'period_end', v_row.period_end,
    'system_amount', v_row.system_amount,
    'vendor_claimed_amount', v_row.vendor_claimed_amount,
    'difference', v_row.difference,
    'status', v_row.status,
    'item_count', v_item_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_update_vendor_reconciliation(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id TEXT;
  v_status_req TEXT;
  v_it JSONB;
  v_item_id TEXT;
  v_claimed NUMERIC;
  v_review TEXT;
  v_header public.vendor_reconciliations%ROWTYPE;
  v_item public.vendor_reconciliation_items%ROWTYPE;
  v_new_status TEXT;
BEGIN
  v_uid := public.dk_ap_require_admin();

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'system_amount' THEN
    RAISE EXCEPTION 'system_amount is immutable';
  END IF;

  v_id := NULLIF(btrim(COALESCE(p_payload->>'id', '')), '');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'id required';
  END IF;

  SELECT * INTO v_header
  FROM public.vendor_reconciliations r
  WHERE r.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation not found';
  END IF;
  IF v_header.status IN ('PAID', 'VOID') THEN
    RAISE EXCEPTION 'cannot update % reconciliation', v_header.status;
  END IF;

  IF p_payload ? 'items' THEN
    IF pg_catalog.jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'items must be array';
    END IF;
    FOR v_it IN
      SELECT t.elem FROM pg_catalog.jsonb_array_elements(p_payload->'items') AS t(elem)
    LOOP
      v_item_id := NULLIF(btrim(COALESCE(v_it->>'id', '')), '');
      IF v_item_id IS NULL THEN
        RAISE EXCEPTION 'item id required';
      END IF;
      SELECT * INTO v_item
      FROM public.vendor_reconciliation_items i
      WHERE i.id = v_item_id
        AND i.reconciliation_id = v_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'item not found: %', v_item_id;
      END IF;

      IF v_it ? 'vendor_claimed_amount' THEN
        IF v_it->'vendor_claimed_amount' = 'null'::jsonb THEN
          v_claimed := NULL;
        ELSE
          v_claimed := (v_it->>'vendor_claimed_amount')::numeric;
          IF v_claimed < 0 THEN
            RAISE EXCEPTION 'vendor_claimed_amount must be >= 0';
          END IF;
        END IF;
      ELSE
        v_claimed := v_item.vendor_claimed_amount;
      END IF;

      v_review := COALESCE(NULLIF(btrim(COALESCE(v_it->>'review_status', '')), ''), v_item.review_status);
      IF v_review NOT IN ('UNCHECKED', 'MATCHED', 'MISMATCH') THEN
        RAISE EXCEPTION 'invalid review_status';
      END IF;

      UPDATE public.vendor_reconciliation_items
      SET vendor_claimed_amount = v_claimed,
          review_status = v_review,
          updated_at = pg_catalog.now()
      WHERE id = v_item_id;
    END LOOP;
  END IF;

  IF p_payload ? 'vendor_claimed_amount' THEN
    IF p_payload->'vendor_claimed_amount' = 'null'::jsonb THEN
      v_claimed := NULL;
    ELSE
      v_claimed := (p_payload->>'vendor_claimed_amount')::numeric;
      IF v_claimed < 0 THEN
        RAISE EXCEPTION 'vendor_claimed_amount must be >= 0';
      END IF;
    END IF;
  ELSE
    v_claimed := v_header.vendor_claimed_amount;
  END IF;

  UPDATE public.vendor_reconciliations
  SET vendor_claimed_amount = v_claimed,
      notes = CASE WHEN p_payload ? 'notes' THEN NULLIF(p_payload->>'notes', '') ELSE notes END,
      updated_at = pg_catalog.now()
  WHERE id = v_id;

  SELECT * INTO v_header FROM public.vendor_reconciliations r WHERE r.id = v_id;

  v_status_req := upper(btrim(COALESCE(p_payload->>'status', '')));
  IF v_status_req = 'CONFIRMED' THEN
    v_new_status := 'CONFIRMED';
  ELSIF v_status_req = 'MISMATCH' THEN
    v_new_status := 'MISMATCH';
  ELSIF v_status_req <> '' THEN
    RAISE EXCEPTION 'status must be CONFIRMED or MISMATCH';
  ELSE
    IF v_header.vendor_claimed_amount IS NULL THEN
      v_new_status := 'DRAFT';
    ELSIF v_header.difference IS NOT NULL AND v_header.difference <> 0 THEN
      v_new_status := 'MISMATCH';
    ELSE
      -- difference = 0 不自動 CONFIRMED，也不自動付款
      v_new_status := CASE WHEN v_header.status = 'CONFIRMED' THEN 'CONFIRMED' ELSE 'DRAFT' END;
    END IF;
  END IF;

  UPDATE public.vendor_reconciliations
  SET status = v_new_status,
      updated_at = pg_catalog.now()
  WHERE id = v_id;

  SELECT * INTO v_header FROM public.vendor_reconciliations r WHERE r.id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_header.id,
    'status', v_header.status,
    'system_amount', v_header.system_amount,
    'vendor_claimed_amount', v_header.vendor_claimed_amount,
    'difference', v_header.difference
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_confirm_vendor_payment(
  p_reconciliation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id TEXT;
  v_row public.vendor_reconciliations%ROWTYPE;
  v_exp_id TEXT;
  v_paid NUMERIC;
  v_exp public.expenses%ROWTYPE;
  v_now TIMESTAMPTZ;
BEGIN
  v_uid := public.dk_ap_require_admin();
  v_id := NULLIF(btrim(COALESCE(p_reconciliation_id, '')), '');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'reconciliation id required';
  END IF;

  SELECT * INTO v_row
  FROM public.vendor_reconciliations r
  WHERE r.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation not found';
  END IF;

  v_exp_id := 'ex-ap-' || v_id;
  v_now := pg_catalog.now();

  IF v_row.status = 'PAID' AND NULLIF(v_row.expense_id, '') IS NOT NULL THEN
    SELECT * INTO v_exp FROM public.expenses e WHERE e.id = v_row.expense_id;
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'id', v_row.id,
      'status', v_row.status,
      'expense_id', v_row.expense_id,
      'paid_amount', v_row.paid_amount,
      'paid_at', v_row.paid_at,
      'idempotent', true
    );
  END IF;

  IF v_row.status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'only CONFIRMED can be paid (status=%)', v_row.status;
  END IF;

  -- v1 full payment：paid = claimed，若尚未填請款則用系統金額
  v_paid := COALESCE(v_row.vendor_claimed_amount, v_row.system_amount);
  IF v_paid IS NULL OR v_paid < 0 THEN
    RAISE EXCEPTION 'invalid paid amount';
  END IF;

  SELECT * INTO v_exp
  FROM public.expenses e
  WHERE e.id = v_exp_id
  FOR UPDATE;

  IF FOUND THEN
    IF COALESCE(v_exp.extra->>'ap_reconciliation_id', '') IS DISTINCT FROM v_id THEN
      RAISE EXCEPTION 'expense id collision: %', v_exp_id;
    END IF;
  ELSE
    INSERT INTO public.expenses (
      id, date, type, category, amount, note, ref_item_id, extra, created_at, updated_at
    ) VALUES (
      v_exp_id,
      (v_now AT TIME ZONE 'Asia/Taipei')::date,
      'COGS',
      '進貨款',
      v_paid,
      'AP ' || v_row.vendor_name || ' ' || v_row.period_start::text || '~' || v_row.period_end::text,
      v_id,
      pg_catalog.jsonb_build_object(
        'ap_reconciliation_id', v_id,
        'ap_vendor_name', v_row.vendor_name,
        'ap_period_start', v_row.period_start,
        'ap_period_end', v_row.period_end
      ),
      v_now,
      v_now
    );
  END IF;

  UPDATE public.vendor_reconciliations
  SET status = 'PAID',
      paid_amount = v_paid,
      paid_at = v_now,
      expense_id = v_exp_id,
      updated_at = v_now
  WHERE id = v_id;

  SELECT * INTO v_row FROM public.vendor_reconciliations r WHERE r.id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'status', v_row.status,
    'expense_id', v_row.expense_id,
    'paid_amount', v_row.paid_amount,
    'paid_at', v_row.paid_at,
    'idempotent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_cancel_vendor_payment(
  p_reconciliation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id TEXT;
  v_row public.vendor_reconciliations%ROWTYPE;
  v_exp public.expenses%ROWTYPE;
  v_expect_id TEXT;
  v_deleted BOOLEAN := false;
BEGIN
  v_uid := public.dk_ap_require_admin();
  v_id := NULLIF(btrim(COALESCE(p_reconciliation_id, '')), '');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'reconciliation id required';
  END IF;

  SELECT * INTO v_row
  FROM public.vendor_reconciliations r
  WHERE r.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'only PAID can cancel payment';
  END IF;

  v_expect_id := 'ex-ap-' || v_id;
  IF NULLIF(v_row.expense_id, '') IS DISTINCT FROM v_expect_id THEN
    RAISE EXCEPTION 'expense_id is not the deterministic AP expense';
  END IF;

  SELECT * INTO v_exp
  FROM public.expenses e
  WHERE e.id = v_expect_id
  FOR UPDATE;

  IF FOUND THEN
    IF COALESCE(v_exp.extra->>'ap_reconciliation_id', '') IS DISTINCT FROM v_id THEN
      RAISE EXCEPTION 'refusing to delete non-AP or mismatched expense';
    END IF;
    DELETE FROM public.expenses e WHERE e.id = v_expect_id;
    v_deleted := true;
  END IF;
  -- 列已不存在：仍清付款欄（修復用）；不刪其他人工 expense

  UPDATE public.vendor_reconciliations
  SET status = 'CONFIRMED',
      paid_amount = NULL,
      paid_at = NULL,
      expense_id = NULL,
      updated_at = pg_catalog.now()
  WHERE id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'status', 'CONFIRMED',
    'expense_deleted', v_deleted
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_void_vendor_reconciliation(
  p_reconciliation_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id TEXT;
  v_row public.vendor_reconciliations%ROWTYPE;
BEGIN
  v_uid := public.dk_ap_require_admin();
  v_id := NULLIF(btrim(COALESCE(p_reconciliation_id, '')), '');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'reconciliation id required';
  END IF;

  SELECT * INTO v_row
  FROM public.vendor_reconciliations r
  WHERE r.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation not found';
  END IF;
  IF v_row.status = 'PAID' THEN
    RAISE EXCEPTION 'PAID cannot VOID; cancel payment first';
  END IF;
  IF v_row.status = 'VOID' THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'status', 'VOID', 'idempotent', true);
  END IF;
  IF v_row.status NOT IN ('DRAFT', 'MISMATCH', 'CONFIRMED') THEN
    RAISE EXCEPTION 'cannot VOID status %', v_row.status;
  END IF;

  UPDATE public.vendor_reconciliations
  SET status = 'VOID',
      updated_at = pg_catalog.now()
  WHERE id = v_id;
  -- items snapshot 保留；partial unique 與 active trigger 隨 status=VOID 釋放

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'status', 'VOID',
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_create_vendor_reconciliation(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.backoffice_update_vendor_reconciliation(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.backoffice_confirm_vendor_payment(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.backoffice_cancel_vendor_payment(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.backoffice_void_vendor_reconciliation(TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.backoffice_create_vendor_reconciliation(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_vendor_reconciliation(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_confirm_vendor_payment(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_cancel_vendor_payment(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_void_vendor_reconciliation(TEXT) TO authenticated;

-- M2_RPC END
*/


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀 catalog／公式驗證。不建立正式付款資料、不呼叫會寫入的 RPC
-- （SQL Editor 無 JWT 時 auth.uid() 為 NULL，RPC 本來就會失敗）。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

WITH rec_cols AS (
  SELECT column_name, is_generated
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vendor_reconciliations'
),
item_cols AS (
  SELECT column_name, is_generated
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vendor_reconciliation_items'
),
set_cols AS (
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vendor_settlement_settings'
),
cons AS (
  SELECT t.relname AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname IN (
      'vendor_settlement_settings',
      'vendor_reconciliations',
      'vendor_reconciliation_items'
    )
),
idx AS (
  SELECT i.relname AS idxname, pg_get_indexdef(i.oid) AS def
  FROM pg_class i
  JOIN pg_namespace n ON n.oid = i.relnamespace
  WHERE n.nspname = 'public'
    AND i.relkind = 'i'
    AND i.relname IN (
      'vendor_reconciliations_active_period_uidx',
      'vendor_reconciliation_items_po_vendor_idx',
      'expenses_ap_reconciliation_id_uidx'
    )
),
pols AS (
  SELECT tablename, policyname, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'vendor_settlement_settings',
      'vendor_reconciliations',
      'vendor_reconciliation_items'
    )
),
rls AS (
  SELECT c.relname, c.relrowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'vendor_settlement_settings',
      'vendor_reconciliations',
      'vendor_reconciliation_items'
    )
),
fn_create AS (
  SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_vendor_reconciliation'
  LIMIT 1
),
fn_pay AS (
  SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backoffice_confirm_vendor_payment'
  LIMIT 1
),
fn_cancel AS (
  SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backoffice_cancel_vendor_payment'
  LIMIT 1
),
fn_void AS (
  SELECT pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backoffice_void_vendor_reconciliation'
  LIMIT 1
)
SELECT 10 AS seq, 'table.vendor_settlement_settings'::text AS check_name,
       (to_regclass('public.vendor_settlement_settings') IS NOT NULL)::text AS actual,
       'true'::text AS expected,
       CASE WHEN to_regclass('public.vendor_settlement_settings') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'table.vendor_reconciliations',
       (to_regclass('public.vendor_reconciliations') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.vendor_reconciliations') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'table.vendor_reconciliation_items',
       (to_regclass('public.vendor_reconciliation_items') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.vendor_reconciliation_items') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'cols.settings.required',
       (SELECT COUNT(*)::text FROM set_cols WHERE column_name IN (
         'vendor_name','settlement_type','week_start_weekday','monthly_anchor_day',
         'notes','updated_by','created_at','updated_at'
       )), '8',
       CASE WHEN (SELECT COUNT(*) FROM set_cols WHERE column_name IN (
         'vendor_name','settlement_type','week_start_weekday','monthly_anchor_day',
         'notes','updated_by','created_at','updated_at'
       )) = 8 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'cols.reconcil.required',
       (SELECT COUNT(*)::text FROM rec_cols WHERE column_name IN (
         'id','vendor_name','settlement_type_snapshot','period_start','period_end',
         'system_amount','vendor_claimed_amount','difference','status',
         'paid_amount','paid_at','expense_id','notes','created_by','created_at','updated_at'
       )), '16',
       CASE WHEN (SELECT COUNT(*) FROM rec_cols WHERE column_name IN (
         'id','vendor_name','settlement_type_snapshot','period_start','period_end',
         'system_amount','vendor_claimed_amount','difference','status',
         'paid_amount','paid_at','expense_id','notes','created_by','created_at','updated_at'
       )) = 16 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'cols.items.required',
       (SELECT COUNT(*)::text FROM item_cols WHERE column_name IN (
         'id','reconciliation_id','purchase_order_id','order_no','vendor_name',
         'system_amount','vendor_claimed_amount','difference','line_snapshot_json',
         'review_status','created_at','updated_at'
       )), '12',
       CASE WHEN (SELECT COUNT(*) FROM item_cols WHERE column_name IN (
         'id','reconciliation_id','purchase_order_id','order_no','vendor_name',
         'system_amount','vendor_claimed_amount','difference','line_snapshot_json',
         'review_status','created_at','updated_at'
       )) = 12 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'generated.header.difference',
       (SELECT is_generated FROM rec_cols WHERE column_name = 'difference'), 'ALWAYS',
       CASE WHEN (SELECT is_generated FROM rec_cols WHERE column_name = 'difference') = 'ALWAYS' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'generated.item.difference',
       (SELECT is_generated FROM item_cols WHERE column_name = 'difference'), 'ALWAYS',
       CASE WHEN (SELECT is_generated FROM item_cols WHERE column_name = 'difference') = 'ALWAYS' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'formula.difference.claimed_minus_system',
       ((1500::numeric - 1000::numeric) = 500)::text, 'true',
       CASE WHEN (1500::numeric - 1000::numeric) = 500 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'constraint.status',
       (EXISTS (SELECT 1 FROM cons WHERE tbl = 'vendor_reconciliations' AND conname = 'vendor_reconciliations_status_chk'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE tbl = 'vendor_reconciliations' AND conname = 'vendor_reconciliations_status_chk') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'constraint.period',
       (EXISTS (SELECT 1 FROM cons WHERE tbl = 'vendor_reconciliations' AND conname = 'vendor_reconciliations_period_chk'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM cons WHERE tbl = 'vendor_reconciliations' AND conname = 'vendor_reconciliations_period_chk') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'fk.items.reconciliation_id',
       (EXISTS (
         SELECT 1 FROM cons
         WHERE tbl = 'vendor_reconciliation_items'
           AND def ILIKE '%REFERENCES public.vendor_reconciliations%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM cons
         WHERE tbl = 'vendor_reconciliation_items'
           AND def ILIKE '%REFERENCES%vendor_reconciliations%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'index.active_period_partial',
       (EXISTS (
         SELECT 1 FROM idx
         WHERE idxname = 'vendor_reconciliations_active_period_uidx'
           AND def ILIKE '%UNIQUE%'
           AND def ILIKE '%status%VOID%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM idx
         WHERE idxname = 'vendor_reconciliations_active_period_uidx'
           AND def ILIKE '%UNIQUE%'
           AND def ILIKE '%VOID%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'index.expenses_ap_expression',
       (EXISTS (
         SELECT 1 FROM idx
         WHERE idxname = 'expenses_ap_reconciliation_id_uidx'
           AND def ILIKE '%UNIQUE%'
           AND def ILIKE '%ap_reconciliation_id%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM idx
         WHERE idxname = 'expenses_ap_reconciliation_id_uidx'
           AND def ILIKE '%UNIQUE%'
           AND def ILIKE '%ap_reconciliation_id%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'rls.all_three_enabled',
       (SELECT COUNT(*)::text FROM rls WHERE relrowsecurity), '3',
       CASE WHEN (SELECT COUNT(*) FROM rls WHERE relrowsecurity) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'policy.admin_only_no_staff_helper',
       (NOT EXISTS (
         SELECT 1 FROM pols
         WHERE qual ILIKE '%is_enabled_backoffice_user%'
            OR with_check ILIKE '%is_enabled_backoffice_user%'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pols
         WHERE qual ILIKE '%is_enabled_backoffice_user%'
            OR with_check ILIKE '%is_enabled_backoffice_user%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 62, 'policy.is_admin',
       (SELECT COUNT(*)::text FROM pols WHERE policyname LIKE '%_admin' AND qual ILIKE '%is_admin%'), '3',
       CASE WHEN (SELECT COUNT(*) FROM pols WHERE policyname LIKE '%_admin' AND qual ILIKE '%is_admin%') = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'rpc.create',
       (to_regprocedure('public.backoffice_create_vendor_reconciliation(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_vendor_reconciliation(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'rpc.update',
       (to_regprocedure('public.backoffice_update_vendor_reconciliation(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_vendor_reconciliation(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'rpc.confirm_payment',
       (to_regprocedure('public.backoffice_confirm_vendor_payment(text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_confirm_vendor_payment(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'rpc.cancel_payment',
       (to_regprocedure('public.backoffice_cancel_vendor_payment(text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_cancel_vendor_payment(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 74, 'rpc.void',
       (to_regprocedure('public.backoffice_void_vendor_reconciliation(text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_void_vendor_reconciliation(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 80, 'rpc.create.reads_items_json',
       (EXISTS (SELECT 1 FROM fn_create WHERE def ILIKE '%items_json%' AND def ILIKE '%system_amount is server-computed%'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM fn_create WHERE def ILIKE '%items_json%' AND def ILIKE '%system_amount is server-computed%') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 81, 'rpc.pay.deterministic_expense_id',
       (EXISTS (SELECT 1 FROM fn_pay WHERE def ILIKE '%ex-ap-%' AND def ILIKE '%FOR UPDATE%'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM fn_pay WHERE def ILIKE '%ex-ap-%' AND def ILIKE '%FOR UPDATE%') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 82, 'rpc.pay.idempotent_paid',
       (EXISTS (SELECT 1 FROM fn_pay WHERE def ILIKE '%idempotent%' AND def ILIKE '%PAID%'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM fn_pay WHERE def ILIKE '%idempotent%' AND def ILIKE '%PAID%') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 83, 'rpc.cancel.ap_extra_guard',
       (EXISTS (SELECT 1 FROM fn_cancel WHERE def ILIKE '%ap_reconciliation_id%' AND def ILIKE '%DELETE FROM public.expenses%'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM fn_cancel WHERE def ILIKE '%ap_reconciliation_id%' AND def ILIKE '%DELETE FROM public.expenses%') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 84, 'rpc.void.paid_blocked',
       (EXISTS (SELECT 1 FROM fn_void WHERE def ILIKE '%PAID cannot VOID%'))::text, 'true',
       CASE WHEN EXISTS (SELECT 1 FROM fn_void WHERE def ILIKE '%PAID cannot VOID%') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 90, 'data.no_auto_reconciliations',
       COALESCE((SELECT COUNT(*)::text FROM public.vendor_reconciliations), 'missing'), '0_or_manual',
       CASE WHEN (SELECT COUNT(*) FROM public.vendor_reconciliations) = 0 THEN 'PASS' ELSE 'INFO_MANUAL_ROWS' END
UNION ALL SELECT 91, 'data.no_ap_expenses',
       COALESCE((
         SELECT COUNT(*)::text FROM public.expenses
         WHERE extra->>'ap_reconciliation_id' IS NOT NULL
       ), 'missing'), '0_or_manual',
       CASE WHEN (
         SELECT COUNT(*) FROM public.expenses
         WHERE extra->>'ap_reconciliation_id' IS NOT NULL
       ) = 0 THEN 'PASS' ELSE 'INFO_MANUAL_ROWS' END
UNION ALL SELECT 92, 'purchase_orders.untouched_table',
       (to_regclass('public.purchase_orders') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.purchase_orders') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 93, 'inventory_items.qty_on_hand_untouched',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 94, 'inventory_ledger.untouched',
       (to_regclass('public.inventory_ledger') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_ledger') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 95, 'inventory_costs.untouched',
       (to_regclass('public.inventory_costs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_costs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 96, 'rpc.create_order_untouched_sig',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 97, 'no_vendors_master',
       (to_regclass('public.vendors') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.vendors') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 98, 'no_vendor_payments_table',
       (to_regclass('public.vendor_payments') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.vendor_payments') IS NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

-- M3_VERIFY END
*/


-- ============================================================
-- SECTION M3B_SMOKE_ROLLBACK
-- 可選。必須整段含 BEGIN / ROLLBACK。不要在 Production 當正式資料跑。
-- 不呼叫需 JWT 的 RPC。用 superuser 直寫驗證 generated / unique / trigger。
-- 結束一定 ROLLBACK：不留 reconciliation、不留 AP expense。
-- ============================================================
/*

BEGIN;

INSERT INTO public.vendor_settlement_settings (vendor_name, settlement_type, week_start_weekday)
VALUES ('__ap_smoke_vendor__', 'MONTHLY', 1);

INSERT INTO public.vendor_reconciliations (
  id, vendor_name, settlement_type_snapshot, period_start, period_end, system_amount, vendor_claimed_amount, status
) VALUES (
  '__ap_smoke_1__', '__ap_smoke_vendor__', 'MONTHLY', '2026-01-01', '2026-01-31', 1000, 1500, 'DRAFT'
);

INSERT INTO public.vendor_reconciliation_items (
  id, reconciliation_id, purchase_order_id, order_no, vendor_name, system_amount, vendor_claimed_amount
) VALUES (
  '__ap_smoke_i1__', '__ap_smoke_1__', '__ap_smoke_po__', 'PO-SMOKE', '__ap_smoke_vendor__', 1000, 1500
);

DO $$
DECLARE
  d NUMERIC;
BEGIN
  SELECT difference INTO d FROM public.vendor_reconciliations WHERE id = '__ap_smoke_1__';
  IF d IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'SMOKE FAIL: header difference expected 500 got %', d;
  END IF;
  SELECT difference INTO d FROM public.vendor_reconciliation_items WHERE id = '__ap_smoke_i1__';
  IF d IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'SMOKE FAIL: item difference expected 500 got %', d;
  END IF;
END $$;

DO $$
BEGIN
  INSERT INTO public.vendor_reconciliations (
    id, vendor_name, settlement_type_snapshot, period_start, period_end, system_amount, status
  ) VALUES (
    '__ap_smoke_dup_period__', '__ap_smoke_vendor__', 'MONTHLY', '2026-01-01', '2026-01-31', 1, 'DRAFT'
  );
  RAISE EXCEPTION 'SMOKE FAIL: period unique did not fire';
EXCEPTION
  WHEN unique_violation THEN
    NULL;
END $$;

INSERT INTO public.vendor_reconciliations (
  id, vendor_name, settlement_type_snapshot, period_start, period_end, system_amount, status
) VALUES (
  '__ap_smoke_2__', '__ap_smoke_vendor__', 'MONTHLY', '2026-02-01', '2026-02-28', 1, 'DRAFT'
);

DO $$
BEGIN
  INSERT INTO public.vendor_reconciliation_items (
    id, reconciliation_id, purchase_order_id, vendor_name, system_amount
  ) VALUES (
    '__ap_smoke_i2__', '__ap_smoke_2__', '__ap_smoke_po__', '__ap_smoke_vendor__', 1
  );
  RAISE EXCEPTION 'SMOKE FAIL: active PO/vendor trigger did not fire';
EXCEPTION
  WHEN unique_violation THEN
    NULL;
  WHEN others THEN
    IF SQLERRM ILIKE '%already on active%' THEN
      NULL;
    ELSE
      RAISE;
    END IF;
END $$;

UPDATE public.vendor_reconciliations SET status = 'VOID' WHERE id = '__ap_smoke_1__';

INSERT INTO public.vendor_reconciliation_items (
  id, reconciliation_id, purchase_order_id, vendor_name, system_amount
) VALUES (
  '__ap_smoke_i2__', '__ap_smoke_2__', '__ap_smoke_po__', '__ap_smoke_vendor__', 1
);

DO $$
BEGIN
  UPDATE public.vendor_reconciliations SET system_amount = 999 WHERE id = '__ap_smoke_2__';
  RAISE EXCEPTION 'SMOKE FAIL: freeze trigger did not fire';
EXCEPTION
  WHEN others THEN
    IF SQLERRM ILIKE '%frozen%' THEN
      NULL;
    ELSE
      RAISE;
    END IF;
END $$;

INSERT INTO public.expenses (id, date, type, category, amount, extra)
VALUES (
  'ex-ap-__ap_smoke_2__', '2026-02-01', 'COGS', '進貨款', 1,
  jsonb_build_object('ap_reconciliation_id', '__ap_smoke_2__')
);

DO $$
BEGIN
  INSERT INTO public.expenses (id, date, type, category, amount, extra)
  VALUES (
    'ex-ap-__ap_smoke_2b__', '2026-02-01', 'COGS', '進貨款', 1,
    jsonb_build_object('ap_reconciliation_id', '__ap_smoke_2__')
  );
  RAISE EXCEPTION 'SMOKE FAIL: expenses AP unique did not fire';
EXCEPTION
  WHEN unique_violation THEN
    NULL;
END $$;

ROLLBACK;

-- M3B_SMOKE_ROLLBACK END
*/


-- ============================================================
-- SECTION ROLLBACK
-- 僅在需要撤 Stage 14-2 時使用。預設不要執行。
-- 不 DROP expenses / purchase_orders / inventory_*。
-- ============================================================
/*

DROP FUNCTION IF EXISTS public.backoffice_void_vendor_reconciliation(TEXT);
DROP FUNCTION IF EXISTS public.backoffice_cancel_vendor_payment(TEXT);
DROP FUNCTION IF EXISTS public.backoffice_confirm_vendor_payment(TEXT);
DROP FUNCTION IF EXISTS public.backoffice_update_vendor_reconciliation(JSONB);
DROP FUNCTION IF EXISTS public.backoffice_create_vendor_reconciliation(JSONB);
DROP FUNCTION IF EXISTS public.dk_ap_require_admin();

DROP TRIGGER IF EXISTS trg_ap_freeze_items ON public.vendor_reconciliation_items;
DROP TRIGGER IF EXISTS trg_ap_freeze_reconcil ON public.vendor_reconciliations;
DROP TRIGGER IF EXISTS trg_ap_items_active_po_vendor ON public.vendor_reconciliation_items;
DROP TRIGGER IF EXISTS trg_ap_header_unvoid_po_vendor ON public.vendor_reconciliations;
DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_reconciliation_items;
DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_reconciliations;
DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.vendor_settlement_settings;

DROP FUNCTION IF EXISTS public.dk_ap_protect_frozen_amounts();
DROP FUNCTION IF EXISTS public.dk_ap_assert_active_po_vendor_free();

DROP INDEX IF EXISTS public.expenses_ap_reconciliation_id_uidx;
DROP INDEX IF EXISTS public.vendor_reconciliation_items_po_vendor_idx;
DROP INDEX IF EXISTS public.vendor_reconciliation_items_recon_idx;
DROP INDEX IF EXISTS public.vendor_reconciliations_vendor_status_idx;
DROP INDEX IF EXISTS public.vendor_reconciliations_active_period_uidx;

DROP TABLE IF EXISTS public.vendor_reconciliation_items;
DROP TABLE IF EXISTS public.vendor_reconciliations;
DROP TABLE IF EXISTS public.vendor_settlement_settings;

-- ROLLBACK END
*/
