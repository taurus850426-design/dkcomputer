-- ============================================================
-- DK Computer｜Stage 18-10 Payroll Settlement + 薪資單 Snapshot
-- Preview 是即時計算。Settlement 是凍結的月結快照。
-- 不做勞健保、所得稅、銀行轉帳、reopen、correction。
--
-- 正式部署順序（後面檔案會 REPLACE 前面函式，順序很重要）：
--   1. supabase-stage18-scheduling.sql
--   2. supabase-stage18-default-shift.sql
--   3. supabase-stage18-leave-requests.sql
--   4. supabase-stage18-attendance-evaluation.sql
--   5. supabase-stage18-compensation.sql
--   6. supabase-stage18-day-classification.sql
--   7. supabase-stage18-leave-types.sql
--   8. supabase-stage18-payroll-engine.sql
--   9. supabase-stage18-overtime-approval.sql
--  10. supabase-stage18-payroll-settlement.sql  ← 本檔，最後執行
--
-- PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'rpc.payroll_preview' AS check_name,
       (to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.ot_candidates',
       (to_regprocedure('public.backoffice_get_overtime_candidates(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_get_overtime_candidates(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'fn.pair',
       (to_regprocedure('public.dk_payroll_pair(numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_payroll_pair(numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

CREATE TABLE IF NOT EXISTS public.payroll_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  payroll_month date NOT NULL,
  status text NOT NULL DEFAULT 'SETTLED',
  employment_stage text NULL,
  pay_type text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  base_salary numeric(14,4) NOT NULL,
  total_deductions numeric(14,4) NOT NULL,
  total_additional_pay numeric(14,4) NOT NULL,
  gross_pay_before_other_items numeric(14,4) NOT NULL,
  display_base_salary numeric(12,0) NOT NULL,
  display_total_deductions numeric(12,0) NOT NULL,
  display_total_additional_pay numeric(12,0) NOT NULL,
  display_gross_pay_before_other_items numeric(12,0) NOT NULL,
  payroll_engine_version text NOT NULL,
  snapshot_json jsonb NOT NULL,
  settled_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  settled_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT payroll_settlements_status_ck CHECK (status = 'SETTLED'),
  CONSTRAINT payroll_settlements_pay_type_ck CHECK (pay_type IN ('MONTHLY', 'HOURLY')),
  CONSTRAINT payroll_settlements_stage_ck
    CHECK (employment_stage IS NULL OR employment_stage IN ('PROBATION', 'REGULAR')),
  CONSTRAINT payroll_settlements_month_ck
    CHECK (payroll_month = date_trunc('month', payroll_month::timestamp)::date),
  CONSTRAINT payroll_settlements_range_ck
    CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_settlements_user_month_uidx
  ON public.payroll_settlements (user_id, payroll_month);

CREATE INDEX IF NOT EXISTS payroll_settlements_month_idx
  ON public.payroll_settlements (payroll_month);

COMMENT ON TABLE public.payroll_settlements IS
  'Stage 18-10 frozen monthly payroll snapshot. V1 SETTLED only. No hard delete, no overwrite.';
COMMENT ON COLUMN public.payroll_settlements.snapshot_json IS
  'Full preview + overtime decisions + summaries at settle time. Needed to explain historical pay.';
COMMENT ON COLUMN public.payroll_settlements.payroll_engine_version IS
  'Formula version, e.g. TW_PAYROLL_V1_2026. Not the frontend cache version.';
COMMENT ON COLUMN public.payroll_settlements.gross_pay_before_other_items IS
  'System calculated gross before labor/health insurance, tax, and other withholdings. Not net take-home.';

CREATE OR REPLACE FUNCTION public.dk_payroll_settlements_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll_settlements cannot be hard deleted';
  END IF;
  RAISE EXCEPTION 'payroll_settlements are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_settlements_no_update ON public.payroll_settlements;
CREATE TRIGGER trg_payroll_settlements_no_update
  BEFORE UPDATE ON public.payroll_settlements
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_payroll_settlements_immutable();

DROP TRIGGER IF EXISTS trg_payroll_settlements_no_delete ON public.payroll_settlements;
CREATE TRIGGER trg_payroll_settlements_no_delete
  BEFORE DELETE ON public.payroll_settlements
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_payroll_settlements_immutable();

REVOKE ALL ON FUNCTION public.dk_payroll_settlements_immutable() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- Admin SELECT。Staff / anon 不可讀。無表寫入 GRANT / policy。
-- ============================================================
/*

ALTER TABLE public.payroll_settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payroll_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payroll_settlements TO authenticated;

DROP POLICY IF EXISTS payroll_settlements_select_admin ON public.payroll_settlements;
CREATE POLICY payroll_settlements_select_admin
  ON public.payroll_settlements
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.payroll_settlements') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: payroll_settlements missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NULL
     OR to_regprocedure('public.backoffice_get_overtime_candidates(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_payroll_pair(numeric)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: run overtime-approval / payroll-engine first.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_engine_version()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT 'TW_PAYROLL_V1_2026'::text;
$$;

COMMENT ON FUNCTION public.dk_payroll_engine_version() IS
  'Taiwan payroll formula version for settlements. V1 baseline 2026. Change when engine rules change.';

CREATE OR REPLACE FUNCTION public.dk_payroll_pair_num(p_pair jsonb, p_field text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(NULLIF(p_pair->>p_field, '')::numeric, 0);
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_preview_not_ready(p_preview jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT
    COALESCE((p_preview->>'payroll_ready')::boolean, false) IS NOT TRUE
    OR COALESCE((p_preview->'review_flags'->>'compensation_missing')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'incomplete_attendance')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'overtime_review_required')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'overtime_limit_review_required')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'holiday_work_review_required')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'regular_holiday_work')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'sick_leave_over_30')::boolean, false)
    OR COALESCE((p_preview->'review_flags'->>'personal_leave_over_14')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_build_snapshot(
  p_preview jsonb,
  p_overtime jsonb,
  p_engine text
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_days jsonb;
  v_work integer := 0;
  v_off integer := 0;
  v_leave integer := 0;
BEGIN
  v_days := COALESCE(p_preview->'daily_breakdown', '[]'::jsonb);
  SELECT
    COUNT(*) FILTER (
      WHERE d->>'attendance_status' IN ('NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'INCOMPLETE')
    )::integer,
    COUNT(*) FILTER (WHERE d->>'attendance_status' = 'OFF')::integer,
    COUNT(*) FILTER (WHERE d->>'attendance_status' = 'LEAVE')::integer
  INTO v_work, v_off, v_leave
  FROM pg_catalog.jsonb_array_elements(v_days) AS d;

  RETURN pg_catalog.jsonb_build_object(
    'engine_version', p_engine,
    'payroll_engine_version', p_engine,
    'payroll_ready', COALESCE((p_preview->>'payroll_ready')::boolean, false),
    'preview', p_preview,
    'employee', p_preview->'employee',
    'month', p_preview->'month',
    'compensation_segments', COALESCE(p_preview->'compensation_segments', '[]'::jsonb),
    'daily_breakdown', v_days,
    'deductions', COALESCE(p_preview->'deductions', '{}'::jsonb),
    'additional_pay', COALESCE(p_preview->'additional_pay', '{}'::jsonb),
    'totals', COALESCE(p_preview->'totals', '{}'::jsonb),
    'base_salary', p_preview->'base_salary',
    'counters', COALESCE(p_preview->'counters', '{}'::jsonb),
    'review_flags', COALESCE(p_preview->'review_flags', '{}'::jsonb),
    'overtime_approvals', COALESCE(p_overtime->'rows', '[]'::jsonb),
    'leave_summary', pg_catalog.jsonb_build_object(
      'sick_leave_days', COALESCE((p_preview->'counters'->>'sick_leave_days')::integer, 0),
      'personal_leave_days', COALESCE((p_preview->'counters'->>'personal_leave_days')::integer, 0),
      'annual_leave_days', COALESCE((p_preview->'counters'->>'annual_leave_days')::integer, 0)
    ),
    'attendance_summary', pg_catalog.jsonb_build_object(
      'work_days', v_work,
      'off_days', v_off,
      'leave_days', v_leave,
      'late_minutes', COALESCE((p_preview->'counters'->>'late_minutes')::integer, 0),
      'early_leave_minutes', COALESCE((p_preview->'counters'->>'early_leave_minutes')::integer, 0),
      'approved_weekday_overtime_minutes', COALESCE((p_preview->'counters'->>'approved_weekday_overtime_minutes')::integer, 0),
      'approved_rest_day_minutes', COALESCE((p_preview->'counters'->>'approved_rest_day_minutes')::integer, 0),
      'approved_national_holiday_days', COALESCE((p_preview->'counters'->>'approved_national_holiday_days')::integer, 0)
    ),
    'day_classifications', pg_catalog.jsonb_build_object(
      'rest_days', COALESCE((p_preview->'counters'->>'rest_days')::integer, 0),
      'regular_holidays', COALESCE((p_preview->'counters'->>'regular_holidays')::integer, 0),
      'national_holidays', COALESCE((p_preview->'counters'->>'national_holidays')::integer, 0)
    ),
    'rounding', pg_catalog.jsonb_build_object(
      'base_salary', p_preview->'base_salary',
      'total_deductions', p_preview->'totals'->'total_deductions',
      'total_additional_pay', p_preview->'totals'->'total_additional_pay',
      'gross_pay_before_other_items', p_preview->'totals'->'gross_pay_before_other_items'
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_get_payroll_settlement(p_user_id uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from date;
  v_row public.payroll_settlements%ROWTYPE;
BEGIN
  PERFORM public.dk_schedule_require_admin();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'month required';
  END IF;
  v_from := pg_catalog.date_trunc('month', p_month::timestamp)::date;

  SELECT * INTO v_row
  FROM public.payroll_settlements s
  WHERE s.user_id = p_user_id AND s.payroll_month = v_from;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'found', false, 'payroll_month', v_from);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'found', true,
    'id', v_row.id,
    'user_id', v_row.user_id,
    'payroll_month', v_row.payroll_month,
    'status', v_row.status,
    'employment_stage', v_row.employment_stage,
    'pay_type', v_row.pay_type,
    'period_start', v_row.period_start,
    'period_end', v_row.period_end,
    'base_salary', v_row.base_salary,
    'total_deductions', v_row.total_deductions,
    'total_additional_pay', v_row.total_additional_pay,
    'gross_pay_before_other_items', v_row.gross_pay_before_other_items,
    'display_base_salary', v_row.display_base_salary,
    'display_total_deductions', v_row.display_total_deductions,
    'display_total_additional_pay', v_row.display_total_additional_pay,
    'display_gross_pay_before_other_items', v_row.display_gross_pay_before_other_items,
    'payroll_engine_version', v_row.payroll_engine_version,
    'snapshot_json', v_row.snapshot_json,
    'settled_by', v_row.settled_by,
    'settled_at', v_row.settled_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_settle_payroll_month(p_user_id uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_from date;
  v_to date;
  v_preview jsonb;
  v_ot jsonb;
  v_engine text;
  v_snap jsonb;
  v_stage text;
  v_pay text;
  v_id uuid;
  v_seg jsonb;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'month required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN
    RAISE EXCEPTION 'employee not found';
  END IF;
  PERFORM public.dk_schedule_require_enabled_employee(p_user_id);

  v_from := pg_catalog.date_trunc('month', p_month::timestamp)::date;
  v_to := ((v_from + interval '1 month')::date - 1);
  v_engine := public.dk_payroll_engine_version();

  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.user_id = p_user_id AND s.payroll_month = v_from
  ) THEN
    RAISE EXCEPTION 'PAYROLL_ALREADY_SETTLED';
  END IF;

  v_preview := public.backoffice_payroll_preview_month(p_user_id, v_from);
  IF public.dk_payroll_preview_not_ready(v_preview) THEN
    RAISE EXCEPTION 'PAYROLL_NOT_READY'
      USING DETAIL = COALESCE(v_preview->'review_flags', '{}'::jsonb)::text;
  END IF;

  v_ot := public.backoffice_get_overtime_candidates(p_user_id, v_from);
  v_snap := public.dk_payroll_build_snapshot(v_preview, v_ot, v_engine);

  v_seg := COALESCE(v_preview->'compensation_segments', '[]'::jsonb);
  IF pg_catalog.jsonb_typeof(v_seg) = 'array' AND pg_catalog.jsonb_array_length(v_seg) = 1 THEN
    v_stage := NULLIF(v_seg->0->>'employment_stage', '');
    v_pay := COALESCE(NULLIF(v_seg->0->>'pay_type', ''), 'MONTHLY');
  ELSE
    v_stage := NULL;
    v_pay := COALESCE(NULLIF(v_seg->0->>'pay_type', ''), 'MONTHLY');
  END IF;

  BEGIN
    INSERT INTO public.payroll_settlements (
      user_id, payroll_month, status, employment_stage, pay_type,
      period_start, period_end,
      base_salary, total_deductions, total_additional_pay, gross_pay_before_other_items,
      display_base_salary, display_total_deductions, display_total_additional_pay,
      display_gross_pay_before_other_items,
      payroll_engine_version, snapshot_json, settled_by, settled_at
    ) VALUES (
      p_user_id, v_from, 'SETTLED', v_stage, v_pay,
      v_from, v_to,
      public.dk_payroll_pair_num(v_preview->'base_salary', 'raw'),
      public.dk_payroll_pair_num(v_preview->'totals'->'total_deductions', 'raw'),
      public.dk_payroll_pair_num(v_preview->'totals'->'total_additional_pay', 'raw'),
      public.dk_payroll_pair_num(v_preview->'totals'->'gross_pay_before_other_items', 'raw'),
      public.dk_payroll_pair_num(v_preview->'base_salary', 'display'),
      public.dk_payroll_pair_num(v_preview->'totals'->'total_deductions', 'display'),
      public.dk_payroll_pair_num(v_preview->'totals'->'total_additional_pay', 'display'),
      public.dk_payroll_pair_num(v_preview->'totals'->'gross_pay_before_other_items', 'display'),
      v_engine, v_snap, v_uid, pg_catalog.now()
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'PAYROLL_ALREADY_SETTLED';
  END;

  RETURN public.backoffice_get_payroll_settlement(p_user_id, v_from);
END;
$$;

COMMENT ON FUNCTION public.backoffice_settle_payroll_month(uuid, date) IS
  'Stage 18-10 Admin-only monthly settlement. Recomputes preview server-side. Client cannot supply amounts. Immutable after insert.';

REVOKE ALL ON FUNCTION public.dk_payroll_engine_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_pair_num(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_preview_not_ready(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_build_snapshot(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_get_payroll_settlement(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_settle_payroll_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_get_payroll_settlement(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_settle_payroll_month(uuid, date) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'table.payroll_settlements' AS check_name,
       (to_regclass('public.payroll_settlements') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.payroll_settlements') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'uidx.user_month',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'payroll_settlements_user_month_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'payroll_settlements_user_month_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.settle',
       (to_regprocedure('public.backoffice_settle_payroll_month(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_settle_payroll_month(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.get_settlement',
       (to_regprocedure('public.backoffice_get_payroll_settlement(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_get_payroll_settlement(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'settle_no_client_amounts',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%backoffice_payroll_preview_month%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_NOT_READY%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%p_base_salary%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_payroll_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%backoffice_payroll_preview_month%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_NOT_READY%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%p_base_salary%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_payroll_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'snapshot_complete',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%daily_breakdown%'
            AND pg_get_functiondef(p.oid) ILIKE '%overtime_approvals%'
            AND pg_get_functiondef(p.oid) ILIKE '%leave_summary%'
            AND pg_get_functiondef(p.oid) ILIKE '%attendance_summary%'
            AND pg_get_functiondef(p.oid) ILIKE '%engine_version%'
            AND pg_get_functiondef(p.oid) ILIKE '%rounding%'
            AND pg_get_functiondef(p.oid) ILIKE '%day_classifications%'
            AND pg_get_functiondef(p.oid) ILIKE '%compensation_segments%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_build_snapshot'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%daily_breakdown%'
            AND pg_get_functiondef(p.oid) ILIKE '%overtime_approvals%'
            AND pg_get_functiondef(p.oid) ILIKE '%leave_summary%'
            AND pg_get_functiondef(p.oid) ILIKE '%attendance_summary%'
            AND pg_get_functiondef(p.oid) ILIKE '%engine_version%'
            AND pg_get_functiondef(p.oid) ILIKE '%rounding%'
            AND pg_get_functiondef(p.oid) ILIKE '%day_classifications%'
            AND pg_get_functiondef(p.oid) ILIKE '%compensation_segments%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_build_snapshot'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'engine_version',
       (public.dk_payroll_engine_version() = 'TW_PAYROLL_V1_2026')::text, 'true',
       CASE WHEN public.dk_payroll_engine_version() = 'TW_PAYROLL_V1_2026' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_settle_payroll_month(uuid,date)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_get_payroll_settlement(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_settle_payroll_month(uuid,date)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_get_payroll_settlement(uuid,date)', 'EXECUTE'), true)
       THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'exec.helper_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_build_snapshot(jsonb,jsonb,text)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_engine_version()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_build_snapshot(jsonb,jsonb,text)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_engine_version()', 'EXECUTE'), true)
       THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rls.select_admin_only',
       ((
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'payroll_settlements' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'payroll_settlements'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'payroll_settlements' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'payroll_settlements'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'no_table_write_grant',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'payroll_settlements'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'payroll_settlements'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'no_punch_write',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_payroll_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_settle_payroll_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
