-- ============================================================
-- DK Computer Stage 16-1：庫存資產排除旗標 + 月分潤結算
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會改 schema／RLS／RPC／資料。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
--
-- Additive only：
--   + inventory_items.exclude_from_inventory_value
--   + public.monthly_profit_distributions
--   + Admin-only SELECT RLS（無 INSERT/UPDATE/DELETE policy）
--   + preview / settle RPC（server 重算 snapshot）
--   + backoffice_upsert_item：僅 Admin 可改 exclude flag
--
-- 禁止：
--   改 AP / PO / 訂單成本 snapshot 語意
--   自動建立歷史 settlement
--   自動修改任何 inventory 列（含「液晶螢幕面板更換」）
--   降低既有 RLS
--   service_role 前端
--
-- 財務規則（v1_gross_minus_non_cogs）：
--   營業額 = total_sale + shipping_income - discount
--   訂單毛利 = 營業額 - order_costs.cogs_total
--   分潤用營業支出 = expenses.amount WHERE type IN ('OPEX','OTHER')
--   type=COGS 不進分潤扣除（避免與 cogs_total／AP 進貨款 double count）
--   可分配淨利 = 訂單毛利 - 分潤用營業支出
--   分潤基數 = GREATEST(可分配淨利, 0)
--   35/40/25 整數元：s35=round(base*35/100), s40=round(base*40/100),
--                    company = base - s35 - s40
--
-- Business date：
--   orders.date DATE（create RPC 寫 now()::date；update 不改 date）
--   報表／結算統一 COALESCE(date, (created_at AT TIME ZONE 'UTC')::date)
--   不用 created_at UTC 字串優先於 date（與舊 client 不同，此 Stage 對齊）
--   join：order_costs.order_id = orders.id
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 Stage 7／Auth helpers 與尚未誤建的 Stage 16 物件。
-- 請複製本 SECTION（從下一行到 PREFLIGHT END）單獨執行。
-- ============================================================
/*

SELECT 'inventory_items' AS obj,
       (to_regclass('public.inventory_items') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.inventory_items') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'inventory_costs',
       (to_regclass('public.inventory_costs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_costs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'orders',
       (to_regclass('public.orders') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.orders') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'orders.date',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'date'
           AND data_type = 'date'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'date'
           AND data_type = 'date'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'orders.created_at',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at'
           AND data_type = 'timestamp with time zone'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'created_at'
           AND data_type = 'timestamp with time zone'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'order_costs.order_id',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'order_costs' AND column_name = 'order_id'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'order_costs' AND column_name = 'order_id'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'order_costs.cogs_total',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'order_costs' AND column_name = 'cogs_total'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'order_costs' AND column_name = 'cogs_total'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'expenses.type',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'type'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'type'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_admin()',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_require_backoffice()',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'backoffice_upsert_item(jsonb,numeric)',
       (to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'exclude_from_inventory_value_absent_or_rerun',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ))::text, 'true_or_rerun',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ) THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'monthly_profit_distributions_absent_or_rerun',
       (to_regclass('public.monthly_profit_distributions') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'rpc.settle_absent_or_rerun',
       (to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
ORDER BY 1;

-- PREFLIGHT END
*/


-- ============================================================
-- SECTION M0_SCHEMA
-- Additive：exclude flag + monthly_profit_distributions + protect trigger。
-- 不 UPDATE／DELETE 既有 inventory 列。不 INSERT settlement。
-- 請複製本 SECTION（去掉 /* */）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.inventory_items') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.inventory_items missing';
  END IF;
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.order_costs') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: orders / order_costs missing';
  END IF;
  IF to_regclass('public.expenses') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.expenses missing';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: is_admin() missing';
  END IF;
END $$;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS exclude_from_inventory_value BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.inventory_items.exclude_from_inventory_value IS
  'Stage 16: if true, item remains sellable but is excluded from current inventory asset cost. Does not affect order COGS.';

CREATE OR REPLACE FUNCTION public.inventory_items_protect_exclude_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.exclude_from_inventory_value IS DISTINCT FROM false
       AND NOT public.is_admin() THEN
      NEW.exclude_from_inventory_value := false;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.exclude_from_inventory_value IS DISTINCT FROM OLD.exclude_from_inventory_value
       AND NOT public.is_admin() THEN
      NEW.exclude_from_inventory_value := OLD.exclude_from_inventory_value;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_items_protect_exclude_flag ON public.inventory_items;
CREATE TRIGGER trg_inventory_items_protect_exclude_flag
  BEFORE INSERT OR UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.inventory_items_protect_exclude_flag();

CREATE TABLE IF NOT EXISTS public.monthly_profit_distributions (
  id TEXT PRIMARY KEY,
  period_month DATE NOT NULL,
  revenue_snapshot NUMERIC NOT NULL DEFAULT 0,
  gross_profit_snapshot NUMERIC NOT NULL DEFAULT 0,
  operating_expense_snapshot NUMERIC NOT NULL DEFAULT 0,
  cogs_expense_snapshot NUMERIC NOT NULL DEFAULT 0,
  distributable_profit_snapshot NUMERIC NOT NULL DEFAULT 0,
  share_35_amount NUMERIC NOT NULL DEFAULT 0,
  share_40_amount NUMERIC NOT NULL DEFAULT 0,
  company_retained_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'settled',
  formula_version TEXT NOT NULL DEFAULT 'v1_gross_minus_non_cogs',
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT monthly_profit_distributions_period_month_uidx UNIQUE (period_month),
  CONSTRAINT monthly_profit_distributions_period_first_day_chk
    CHECK (period_month = (date_trunc('month', period_month::timestamp))::date),
  CONSTRAINT monthly_profit_distributions_status_chk
    CHECK (status = 'settled'),
  CONSTRAINT monthly_profit_distributions_formula_chk
    CHECK (formula_version = 'v1_gross_minus_non_cogs'),
  CONSTRAINT monthly_profit_distributions_opex_nonneg_chk
    CHECK (operating_expense_snapshot >= 0),
  CONSTRAINT monthly_profit_distributions_cogs_exp_nonneg_chk
    CHECK (cogs_expense_snapshot >= 0),
  CONSTRAINT monthly_profit_distributions_share35_nonneg_chk
    CHECK (share_35_amount >= 0),
  CONSTRAINT monthly_profit_distributions_share40_nonneg_chk
    CHECK (share_40_amount >= 0),
  CONSTRAINT monthly_profit_distributions_company_nonneg_chk
    CHECK (company_retained_amount >= 0)
);

COMMENT ON TABLE public.monthly_profit_distributions IS
  'Stage 16 V1: one settled monthly profit-share snapshot. No hard delete. Amounts computed server-side.';

COMMENT ON COLUMN public.monthly_profit_distributions.cogs_expense_snapshot IS
  'Diagnostic only. Not used in distributable profit.';

COMMENT ON COLUMN public.monthly_profit_distributions.distributable_profit_snapshot IS
  'May be negative. Shares are based on GREATEST(this, 0).';

-- M0_SCHEMA END
*/


-- ============================================================
-- SECTION M1_RLS
-- Admin SELECT only。authenticated 無 INSERT/UPDATE/DELETE grant。
-- 不改 inventory_items 既有 policy。
-- ============================================================
/*

ALTER TABLE public.monthly_profit_distributions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.monthly_profit_distributions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.monthly_profit_distributions TO authenticated;

DROP POLICY IF EXISTS monthly_profit_distributions_admin_select ON public.monthly_profit_distributions;
CREATE POLICY monthly_profit_distributions_admin_select
  ON public.monthly_profit_distributions FOR SELECT TO authenticated
  USING (public.is_admin());

-- M1_RLS END
*/


-- ============================================================
-- SECTION M2_FUNCTIONS
-- Preview／Settlement 共用計算。Admin-only。
-- 同時 additive 更新 backoffice_upsert_item：Staff 不可改 exclude flag。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.monthly_profit_distributions') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: monthly_profit_distributions missing. Run M0_SCHEMA first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = 'exclude_from_inventory_value'
  ) THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: exclude_from_inventory_value missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: is_admin / dk_require_backoffice missing.';
  END IF;
  IF to_regprocedure('public.backoffice_upsert_item(jsonb,numeric)') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: backoffice_upsert_item missing.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.dk_profit_require_admin()
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

REVOKE ALL ON FUNCTION public.dk_profit_require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_order_business_date(
  p_date DATE,
  p_created_at TIMESTAMPTZ
)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT COALESCE(p_date, (p_created_at AT TIME ZONE 'UTC')::date);
$$;

REVOKE ALL ON FUNCTION public.dk_order_business_date(DATE, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_compute_profit_for_range(
  p_from DATE,
  p_to_exclusive DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revenue NUMERIC;
  v_cogs_orders NUMERIC;
  v_gross NUMERIC;
  v_opex NUMERIC;
  v_cogs_exp NUMERIC;
  v_dist NUMERIC;
  v_base NUMERIC;
  v_s35 NUMERIC;
  v_s40 NUMERIC;
  v_co NUMERIC;
BEGIN
  PERFORM public.dk_profit_require_admin();
  IF p_from IS NULL OR p_to_exclusive IS NULL OR p_to_exclusive <= p_from THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;

  SELECT
    COALESCE(ROUND(SUM(
      COALESCE(o.total_sale, 0) + COALESCE(o.shipping_income, 0) - COALESCE(o.discount, 0)
    ), 0), 0),
    COALESCE(ROUND(SUM(COALESCE(oc.cogs_total, 0)), 0), 0)
  INTO v_revenue, v_cogs_orders
  FROM public.orders o
  LEFT JOIN public.order_costs oc ON oc.order_id = o.id
  WHERE public.dk_order_business_date(o.date, o.created_at) >= p_from
    AND public.dk_order_business_date(o.date, o.created_at) < p_to_exclusive
    AND o.status IS DISTINCT FROM 'refunded';

  v_gross := v_revenue - v_cogs_orders;

  SELECT COALESCE(ROUND(SUM(COALESCE(e.amount, 0)), 0), 0)
  INTO v_opex
  FROM public.expenses e
  WHERE e.date >= p_from
    AND e.date < p_to_exclusive
    AND e.type IN ('OPEX', 'OTHER');

  SELECT COALESCE(ROUND(SUM(COALESCE(e.amount, 0)), 0), 0)
  INTO v_cogs_exp
  FROM public.expenses e
  WHERE e.date >= p_from
    AND e.date < p_to_exclusive
    AND e.type = 'COGS';

  v_dist := v_gross - v_opex;
  v_base := GREATEST(v_dist, 0);
  v_s35 := ROUND(v_base * 35 / 100, 0);
  v_s40 := ROUND(v_base * 40 / 100, 0);
  v_co := v_base - v_s35 - v_s40;

  RETURN pg_catalog.jsonb_build_object(
    'revenue_snapshot', v_revenue,
    'gross_profit_snapshot', v_gross,
    'operating_expense_snapshot', v_opex,
    'cogs_expense_snapshot', v_cogs_exp,
    'distributable_profit_snapshot', v_dist,
    'share_35_amount', v_s35,
    'share_40_amount', v_s40,
    'company_retained_amount', v_co,
    'formula_version', 'v1_gross_minus_non_cogs'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_compute_profit_for_range(DATE, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_current_inventory_asset_value()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total NUMERIC;
BEGIN
  PERFORM public.dk_profit_require_admin();
  SELECT COALESCE(ROUND(SUM(
    COALESCE(it.qty_on_hand, 0) * COALESCE(ic.cost_unit, 0)
  ), 0), 0)
  INTO v_total
  FROM public.inventory_items it
  LEFT JOIN public.inventory_costs ic ON ic.item_id = it.id
  WHERE COALESCE(it.is_archived, false) = false
    AND COALESCE(it.qty_on_hand, 0) > 0
    AND COALESCE(it.exclude_from_inventory_value, false) = false;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_current_inventory_asset_value() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_company_retained_cumulative()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total NUMERIC;
BEGIN
  PERFORM public.dk_profit_require_admin();
  SELECT COALESCE(SUM(d.company_retained_amount), 0)
  INTO v_total
  FROM public.monthly_profit_distributions d
  WHERE d.status = 'settled';
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_company_retained_cumulative() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_normalize_period_month(p_period_month DATE)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT (date_trunc('month', p_period_month::timestamp))::date;
$$;

REVOKE ALL ON FUNCTION public.dk_normalize_period_month(DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_profit_row_json(
  p_row public.monthly_profit_distributions,
  p_already BOOLEAN,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.dk_profit_require_admin();
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_row.id,
    'period_month', p_row.period_month,
    'revenue_snapshot', p_row.revenue_snapshot,
    'gross_profit_snapshot', p_row.gross_profit_snapshot,
    'operating_expense_snapshot', p_row.operating_expense_snapshot,
    'cogs_expense_snapshot', p_row.cogs_expense_snapshot,
    'distributable_profit_snapshot', p_row.distributable_profit_snapshot,
    'share_35_amount', p_row.share_35_amount,
    'share_40_amount', p_row.share_40_amount,
    'company_retained_amount', p_row.company_retained_amount,
    'status', p_row.status,
    'formula_version', p_row.formula_version,
    'settled_at', p_row.settled_at,
    'settled_by', p_row.settled_by,
    'settled_by_display_name', p_display_name,
    'already_settled', COALESCE(p_already, true),
    'can_settle', false,
    'inventory_value', public.dk_current_inventory_asset_value(),
    'company_retained_cumulative', public.dk_company_retained_cumulative()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_profit_row_json(public.monthly_profit_distributions, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_profit_preview_json(
  p_period_month DATE,
  p_calc JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current DATE;
BEGIN
  PERFORM public.dk_profit_require_admin();
  v_current := ((pg_catalog.now() AT TIME ZONE 'Asia/Taipei')::date);
  RETURN p_calc || pg_catalog.jsonb_build_object(
    'ok', true,
    'id', NULL,
    'period_month', p_period_month,
    'status', 'preview',
    'settled_at', NULL,
    'settled_by', NULL,
    'settled_by_display_name', NULL,
    'already_settled', false,
    'can_settle', p_period_month <= (date_trunc('month', v_current::timestamp))::date,
    'inventory_value', public.dk_current_inventory_asset_value(),
    'company_retained_cumulative', public.dk_company_retained_cumulative()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_profit_preview_json(DATE, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_preview_monthly_profit(
  p_period_month DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_month DATE;
  v_row public.monthly_profit_distributions%ROWTYPE;
  v_name TEXT;
  v_calc JSONB;
BEGIN
  v_uid := public.dk_profit_require_admin();
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'period_month required';
  END IF;
  v_month := public.dk_normalize_period_month(p_period_month);

  SELECT * INTO v_row
  FROM public.monthly_profit_distributions d
  WHERE d.period_month = v_month;

  IF FOUND THEN
    SELECT p.display_name INTO v_name
    FROM public.profiles p
    WHERE p.id = v_row.settled_by;
    RETURN public.dk_profit_row_json(v_row, true, v_name);
  END IF;

  v_calc := public.dk_compute_profit_for_range(v_month, (v_month + INTERVAL '1 month')::date);
  RETURN public.dk_profit_preview_json(v_month, v_calc);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_preview_monthly_profit(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_preview_monthly_profit(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_preview_profit_range(
  p_from DATE,
  p_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_calc JSONB;
BEGIN
  v_uid := public.dk_profit_require_admin();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'date range required';
  END IF;
  v_calc := public.dk_compute_profit_for_range(p_from, (p_to + 1));
  RETURN v_calc || pg_catalog.jsonb_build_object(
    'ok', true,
    'status', 'preview',
    'already_settled', false,
    'can_settle', false,
    'from', p_from,
    'to', p_to,
    'settled_at', NULL,
    'settled_by', NULL,
    'settled_by_display_name', NULL,
    'inventory_value', public.dk_current_inventory_asset_value(),
    'company_retained_cumulative', public.dk_company_retained_cumulative()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_preview_profit_range(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_preview_profit_range(DATE, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_preview_year_profit(
  p_year INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_month DATE;
  v_i INTEGER;
  v_one JSONB;
  v_months JSONB := '[]'::jsonb;
  v_s35 NUMERIC := 0;
  v_s40 NUMERIC := 0;
  v_co NUMERIC := 0;
BEGIN
  v_uid := public.dk_profit_require_admin();
  IF p_year IS NULL OR p_year < 2000 OR p_year > 2100 THEN
    RAISE EXCEPTION 'invalid year';
  END IF;

  FOR v_i IN 1..12 LOOP
    v_month := make_date(p_year, v_i, 1);
    v_one := public.backoffice_preview_monthly_profit(v_month);
    v_months := v_months || pg_catalog.jsonb_build_array(v_one);
    v_s35 := v_s35 + COALESCE((v_one->>'share_35_amount')::numeric, 0);
    v_s40 := v_s40 + COALESCE((v_one->>'share_40_amount')::numeric, 0);
    v_co := v_co + COALESCE((v_one->>'company_retained_amount')::numeric, 0);
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'year', p_year,
    'can_settle', false,
    'status', 'year',
    'months', v_months,
    'share_35_amount', v_s35,
    'share_40_amount', v_s40,
    'company_retained_amount', v_co,
    'inventory_value', public.dk_current_inventory_asset_value(),
    'company_retained_cumulative', public.dk_company_retained_cumulative(),
    'formula_version', 'v1_gross_minus_non_cogs'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_preview_year_profit(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_preview_year_profit(INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_settle_monthly_profit(
  p_period_month DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_month DATE;
  v_current DATE;
  v_calc JSONB;
  v_id TEXT;
  v_row public.monthly_profit_distributions%ROWTYPE;
  v_name TEXT;
BEGIN
  v_uid := public.dk_profit_require_admin();
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'period_month required';
  END IF;
  v_month := public.dk_normalize_period_month(p_period_month);
  v_current := (date_trunc('month', ((pg_catalog.now() AT TIME ZONE 'Asia/Taipei')::date)::timestamp))::date;
  IF v_month > v_current THEN
    RAISE EXCEPTION 'cannot settle a future month';
  END IF;

  SELECT * INTO v_row
  FROM public.monthly_profit_distributions d
  WHERE d.period_month = v_month;
  IF FOUND THEN
    SELECT p.display_name INTO v_name
    FROM public.profiles p
    WHERE p.id = v_row.settled_by;
    RETURN public.dk_profit_row_json(v_row, true, v_name);
  END IF;

  v_calc := public.dk_compute_profit_for_range(v_month, (v_month + INTERVAL '1 month')::date);
  v_id := 'mpd-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');

  INSERT INTO public.monthly_profit_distributions (
    id, period_month,
    revenue_snapshot, gross_profit_snapshot,
    operating_expense_snapshot, cogs_expense_snapshot,
    distributable_profit_snapshot,
    share_35_amount, share_40_amount, company_retained_amount,
    status, formula_version, settled_at, settled_by, created_at, updated_at
  ) VALUES (
    v_id,
    v_month,
    COALESCE((v_calc->>'revenue_snapshot')::numeric, 0),
    COALESCE((v_calc->>'gross_profit_snapshot')::numeric, 0),
    COALESCE((v_calc->>'operating_expense_snapshot')::numeric, 0),
    COALESCE((v_calc->>'cogs_expense_snapshot')::numeric, 0),
    COALESCE((v_calc->>'distributable_profit_snapshot')::numeric, 0),
    COALESCE((v_calc->>'share_35_amount')::numeric, 0),
    COALESCE((v_calc->>'share_40_amount')::numeric, 0),
    COALESCE((v_calc->>'company_retained_amount')::numeric, 0),
    'settled',
    'v1_gross_minus_non_cogs',
    pg_catalog.now(),
    v_uid,
    pg_catalog.now(),
    pg_catalog.now()
  )
  ON CONFLICT (period_month) DO NOTHING;

  SELECT * INTO v_row
  FROM public.monthly_profit_distributions d
  WHERE d.period_month = v_month;

  SELECT p.display_name INTO v_name
  FROM public.profiles p
  WHERE p.id = v_row.settled_by;

  RETURN public.dk_profit_row_json(v_row, v_row.id IS DISTINCT FROM v_id, v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_settle_monthly_profit(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_settle_monthly_profit(DATE) TO authenticated;

-- Additive update of existing upsert：Staff 不可改 exclude_from_inventory_value。
-- 其餘語意與 Stage 12-2c 相同。
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
  v_exclude BOOLEAN;
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

  IF v_exists THEN
    SELECT COALESCE(NULLIF(p_item->>'category', ''), it.category, '') INTO v_category
    FROM public.inventory_items it
    WHERE it.id = v_id;
  ELSE
    v_category := COALESCE(NULLIF(p_item->>'category', ''), '');
  END IF;

  v_require_group := v_category IN ('記憶體', '硬碟', '電源供應器');

  IF v_role IS DISTINCT FROM 'admin' AND v_require_group THEN
    IF (NOT v_exists) OR (p_item ? 'replenishment_group_id') THEN
      IF (
        CASE
          WHEN p_item ? 'replenishment_group_id' THEN v_group_id
          ELSE NULL
        END
      ) IS NULL THEN
        IF (NOT v_exists) OR (p_item ? 'replenishment_group_id' AND v_group_id IS NULL) THEN
          RAISE EXCEPTION 'replenishment group required' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  END IF;

  v_exclude := false;
  IF v_role = 'admin' AND public.is_admin() AND p_item ? 'exclude_from_inventory_value' THEN
    v_exclude := (p_item->'exclude_from_inventory_value') = 'true'::jsonb
      OR lower(COALESCE(p_item->>'exclude_from_inventory_value', '')) IN ('true', 't', '1');
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
        exclude_from_inventory_value = CASE
          WHEN v_role = 'admin' AND public.is_admin() AND p_item ? 'exclude_from_inventory_value' THEN v_exclude
          ELSE exclude_from_inventory_value
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSE
    IF v_role IS DISTINCT FROM 'admin' AND v_require_group AND (
      CASE WHEN p_item ? 'replenishment_group_id' THEN v_group_id ELSE NULL END
    ) IS NULL THEN
      RAISE EXCEPTION 'replenishment group required' USING ERRCODE = 'P0001';
    END IF;

    IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
      v_exclude := false;
    END IF;

    INSERT INTO public.inventory_items (
      id, sku, category, sub_type, brand, model, name, spec, vendor, condition, status,
      qty_on_hand, price_list, price_floor, inbound_date, last_moved_at, reorder_point,
      location, notes, replenishment_group_id, is_archived, archived_at,
      exclude_from_inventory_value, extra, created_at, updated_at
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
      v_exclude,
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

-- M2_FUNCTIONS END
*/


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀驗證。
-- ============================================================
/*

SELECT 10 AS seq, 'col.exclude_from_inventory_value'::text AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
           AND data_type = 'boolean'
           AND is_nullable = 'NO'
       ))::text AS actual,
       'true'::text AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
           AND data_type = 'boolean'
           AND is_nullable = 'NO'
       ) THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 11, 'col.exclude_default_false',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
           AND column_default ILIKE '%false%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
           AND column_default ILIKE '%false%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'table.monthly_profit_distributions',
       (to_regclass('public.monthly_profit_distributions') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'unique.period_month',
       (EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'monthly_profit_distributions'
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) ILIKE '%period_month%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'monthly_profit_distributions'
           AND c.contype = 'u'
           AND pg_get_constraintdef(c.oid) ILIKE '%period_month%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'rls.enabled',
       (COALESCE((SELECT c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'monthly_profit_distributions'), false))::text, 'true',
       CASE WHEN COALESCE((SELECT c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'monthly_profit_distributions'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'grant.no_insert_authenticated',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'INSERT'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'INSERT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'grant.no_update_authenticated',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'grant.no_delete_authenticated',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'DELETE'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'monthly_profit_distributions'
           AND grantee = 'authenticated' AND privilege_type = 'DELETE'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'rpc.settle',
       (to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'rpc.preview_month',
       (to_regprocedure('public.backoffice_preview_monthly_profit(date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_preview_monthly_profit(date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'rpc.preview_range',
       (to_regprocedure('public.backoffice_preview_profit_range(date,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_preview_profit_range(date,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'rpc.preview_year',
       (to_regprocedure('public.backoffice_preview_year_profit(integer)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_preview_year_profit(integer)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'fn.settle_security_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_monthly_profit'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_monthly_profit'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'policy.select_admin_only',
       (COALESCE((
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'monthly_profit_distributions'
       ), '0')), '1',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'monthly_profit_distributions'
       ) = 1
       AND EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'monthly_profit_distributions'
           AND policyname = 'monthly_profit_distributions_admin_select'
           AND cmd = 'SELECT'
           AND roles::text ILIKE '%authenticated%'
           AND COALESCE(qual, '') ILIKE '%is_admin%'
           AND with_check IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'monthly_profit_distributions'
           AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'constraint.formula_version',
       (EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'monthly_profit_distributions'
           AND c.conname = 'monthly_profit_distributions_formula_chk'
           AND pg_get_constraintdef(c.oid) ILIKE '%v1_gross_minus_non_cogs%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'monthly_profit_distributions'
           AND c.conname = 'monthly_profit_distributions_formula_chk'
           AND pg_get_constraintdef(c.oid) ILIKE '%v1_gross_minus_non_cogs%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'fn.compute_security_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_compute_profit_for_range'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_compute_profit_for_range'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'fn.settle_search_path',
       (COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_monthly_profit'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_monthly_profit'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'exec.helper_compute_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_compute_profit_for_range(date,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_compute_profit_for_range(date,date)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'exec.helper_compute_anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.dk_compute_profit_for_range(date,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.dk_compute_profit_for_range(date,date)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'exec.helper_inventory_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_current_inventory_asset_value()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_current_inventory_asset_value()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39.1, 'exec.helper_retained_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_company_retained_cumulative()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_company_retained_cumulative()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39.2, 'exec.preview_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_preview_monthly_profit(date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_preview_monthly_profit(date)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39.3, 'exec.settle_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_settle_monthly_profit(date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_settle_monthly_profit(date)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39.4, 'exec.settle_anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_settle_monthly_profit(date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_settle_monthly_profit(date)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39.5, 'fn.compute_has_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_profit_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_compute_profit_for_range'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_profit_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_compute_profit_for_range'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'no_auto_settlement_rows',
       (COALESCE((SELECT COUNT(*)::text FROM public.monthly_profit_distributions), 'missing')), '0',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NULL THEN 'FAIL'
            WHEN (SELECT COUNT(*) FROM public.monthly_profit_distributions) = 0 THEN 'PASS'
            ELSE 'FAIL' END
UNION ALL SELECT 41, 'no_auto_exclude_true',
       (COALESCE((
         SELECT COUNT(*)::text FROM public.inventory_items WHERE exclude_from_inventory_value = true
       ), 'missing')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ) THEN 'FAIL'
            WHEN (SELECT COUNT(*) FROM public.inventory_items WHERE exclude_from_inventory_value = true) = 0
              THEN 'PASS'
            ELSE 'INFO_HAS_TRUE' END
ORDER BY 1;

-- M3_VERIFY END
*/
