-- ============================================================
-- DK Computer｜Stage 18-8 Payroll 法規計算 Engine（Preview only）
-- Taiwan Labor Standards payroll rules — V1 baseline: 2026
-- 倍率與除數集中在 dk_payroll_rule。法規若修正，只改該處，勿散落。
-- 本檔不是永遠不變的商業真理。
--
-- Preview：不算 Settlement、不發薪、不寫 punch、不做勞健保／所得稅／津貼。
-- 只支援 pay_type = MONTHLY。HOURLY → HOURLY_PAYROLL_NOT_IMPLEMENTED。
--
-- 必須在以下全部之後執行：
--   scheduling → default-shift → leave-requests
--   → attendance-evaluation → compensation
--   → day-classification → leave-types
--
-- PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.compensation' AS check_name,
       (to_regclass('public.employee_compensation_periods') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.employee_compensation_periods') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.leave_requests',
       (to_regclass('public.attendance_leave_requests') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_leave_requests') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.eval_day',
       (to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.resolve_schedule',
       (to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'col.leave_unit',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

-- NONE：不新增 table。Preview 不落地結算資料。

SELECT 'M0_SCHEMA' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

-- NONE：無新 table。不新增 compensation / attendance table write GRANT。

SELECT 'M1_RLS' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_compensation_periods') IS NULL
     OR to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: run Stage 18 dependencies through leave-types first.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Rule constants (Taiwan LSA payroll, V1 baseline 2026)
-- MONTHLY_DAYS=30；時薪 = 月薪/30/8 = 月薪/240。勿改用當月 28/29/31 日。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dk_payroll_rule(p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE pg_catalog.upper(pg_catalog.btrim(COALESCE(p_key, '')))
    WHEN 'MONTHLY_DAYS' THEN 30::numeric
    WHEN 'NORMAL_DAILY_HOURS' THEN 8::numeric
    WHEN 'OT_TIER1_MINUTES' THEN 120::numeric
    WHEN 'WEEKDAY_OT_SAFE_MINUTES' THEN 240::numeric
    WHEN 'REST_DAY_SAFE_MINUTES' THEN 480::numeric
    WHEN 'OT_MULT_TIER1' THEN (4::numeric / 3::numeric)
    WHEN 'OT_MULT_TIER2' THEN (5::numeric / 3::numeric)
    WHEN 'SICK_LEAVE_DEDUCTION_FRACTION' THEN 0.5::numeric
    WHEN 'SICK_LEAVE_HALF_PAY_MAX_DAYS' THEN 30::numeric
    WHEN 'PERSONAL_LEAVE_REVIEW_DAYS' THEN 14::numeric
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION public.dk_payroll_rule(text) IS
  'Taiwan Labor Standards payroll constants. V1 baseline: 2026. Change here when the law changes; not immutable business truth.';

CREATE OR REPLACE FUNCTION public.dk_payroll_round_ntd(p_amount numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT pg_catalog.round(COALESCE(p_amount, 0), 0);
$$;

COMMENT ON FUNCTION public.dk_payroll_round_ntd(numeric) IS
  'Single display rounding policy: nearest NT$ integer (half up), same as Stage 16 ROUND(x,0). Do not round per-day before monthly totals.';

CREATE OR REPLACE FUNCTION public.dk_payroll_pair(p_raw numeric)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'raw', COALESCE(p_raw, 0),
    'display', public.dk_payroll_round_ntd(p_raw)
  );
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_monthly_rates(p_monthly_salary numeric)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'monthly_salary', p_monthly_salary,
    'daily_wage', p_monthly_salary / public.dk_payroll_rule('MONTHLY_DAYS'),
    'hourly_wage', p_monthly_salary / public.dk_payroll_rule('MONTHLY_DAYS') / public.dk_payroll_rule('NORMAL_DAILY_HOURS'),
    'minute_wage', p_monthly_salary / public.dk_payroll_rule('MONTHLY_DAYS') / public.dk_payroll_rule('NORMAL_DAILY_HOURS') / 60::numeric
  );
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_span_minutes(p_start text, p_end text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_sh integer;
  v_sm integer;
  v_eh integer;
  v_em integer;
  v_a integer;
  v_b integer;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR pg_catalog.btrim(p_start) = '' OR pg_catalog.btrim(p_end) = '' THEN
    RETURN 0;
  END IF;
  BEGIN
    v_sh := pg_catalog.split_part(p_start, ':', 1)::integer;
    v_sm := pg_catalog.split_part(p_start, ':', 2)::integer;
    v_eh := pg_catalog.split_part(p_end, ':', 1)::integer;
    v_em := pg_catalog.split_part(p_end, ':', 2)::integer;
  EXCEPTION WHEN OTHERS THEN
    RETURN 0;
  END;
  IF v_sh IS NULL OR v_eh IS NULL THEN
    RETURN 0;
  END IF;
  v_a := v_sh * 60 + COALESCE(v_sm, 0);
  v_b := v_eh * 60 + COALESCE(v_em, 0);
  IF v_b <= v_a THEN
    v_b := v_b + 24 * 60;
  END IF;
  RETURN GREATEST(0, v_b - v_a);
END;
$$;

-- p_kind: WEEKDAY | REST_DAY
-- WEEKDAY：前2小時 4/3，再2小時 5/3；超過 4 小時 OT 不自動算。
-- REST_DAY：前2小時 4/3，2–8小時 5/3；超過 8 小時不自動算。
CREATE OR REPLACE FUNCTION public.dk_payroll_overtime_amount(p_hourly_wage numeric, p_minutes integer, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_left numeric;
  v_use numeric;
  v_amt numeric := 0;
  v_safe integer;
  v_t1 integer;
  v_m1 numeric;
  v_m2 numeric;
BEGIN
  v_kind := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_kind, '')));
  v_left := GREATEST(0, COALESCE(p_minutes, 0))::numeric;
  v_t1 := public.dk_payroll_rule('OT_TIER1_MINUTES')::integer;
  v_m1 := public.dk_payroll_rule('OT_MULT_TIER1');
  v_m2 := public.dk_payroll_rule('OT_MULT_TIER2');
  IF v_kind = 'WEEKDAY' THEN
    v_safe := public.dk_payroll_rule('WEEKDAY_OT_SAFE_MINUTES')::integer;
    v_use := LEAST(v_left, v_t1);
    v_amt := v_amt + COALESCE(p_hourly_wage, 0) * (v_use / 60::numeric) * v_m1;
    v_left := v_left - v_use;
    v_use := LEAST(v_left, (v_safe - v_t1)::numeric);
    v_amt := v_amt + COALESCE(p_hourly_wage, 0) * (v_use / 60::numeric) * v_m2;
    v_left := v_left - v_use;
  ELSIF v_kind = 'REST_DAY' THEN
    v_safe := public.dk_payroll_rule('REST_DAY_SAFE_MINUTES')::integer;
    v_use := LEAST(v_left, v_t1);
    v_amt := v_amt + COALESCE(p_hourly_wage, 0) * (v_use / 60::numeric) * v_m1;
    v_left := v_left - v_use;
    v_use := LEAST(v_left, (v_safe - v_t1)::numeric);
    v_amt := v_amt + COALESCE(p_hourly_wage, 0) * (v_use / 60::numeric) * v_m2;
    v_left := v_left - v_use;
  ELSE
    RETURN pg_catalog.jsonb_build_object(
      'amount', 0, 'computed_minutes', 0, 'limit_review', true, 'kind', v_kind
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'amount', v_amt,
    'computed_minutes', GREATEST(0, COALESCE(p_minutes, 0) - v_left::integer),
    'limit_review', (v_left > 0),
    'kind', v_kind
  );
END;
$$;

COMMENT ON FUNCTION public.dk_payroll_overtime_amount(numeric, integer, text) IS
  'Central OT multiplier helper. WEEKDAY 4/3 then 5/3 (safe 4h). REST_DAY 4/3 then 5/3 through 8h. Excess → limit_review, no auto amount.';

CREATE OR REPLACE FUNCTION public.dk_payroll_compensation_on(p_user_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.employee_compensation_periods%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_date IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_row
  FROM public.employee_compensation_periods c
  WHERE c.user_id = p_user_id
    AND c.effective_from <= p_date
    AND (c.effective_to IS NULL OR c.effective_to >= p_date)
  ORDER BY c.effective_from DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id,
    'employment_stage', v_row.employment_stage,
    'pay_type', v_row.pay_type,
    'monthly_salary', v_row.monthly_salary,
    'hourly_rate', v_row.hourly_rate,
    'effective_from', v_row.effective_from,
    'effective_to', v_row.effective_to
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_year_leave_count(
  p_user_id uuid,
  p_leave_type text,
  p_year_start date,
  p_before date
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_leave_type IS NULL OR p_year_start IS NULL OR p_before IS NULL THEN
    RETURN 0;
  END IF;
  SELECT COUNT(*)::integer INTO v_n
  FROM public.attendance_leave_requests r
  WHERE r.user_id = p_user_id
    AND r.status = 'APPROVED'
    AND r.leave_type = p_leave_type
    AND COALESCE(r.leave_unit, 'FULL_DAY') = 'FULL_DAY'
    AND r.leave_date >= p_year_start
    AND r.leave_date < p_before;
  RETURN COALESCE(v_n, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_payroll_preview_day(p_user_id uuid, p_date date, p_eval jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_eval jsonb;
  v_comp jsonb;
  v_rates jsonb;
  v_day_type text;
  v_sched_type text;
  v_status text;
  v_leave_type text;
  v_leave_status text;
  v_leave_unit text;
  v_anomaly text;
  v_pay_type text;
  v_salary numeric;
  v_daily numeric := 0;
  v_hourly numeric := 0;
  v_minute numeric := 0;
  v_sched_min integer := 0;
  v_work_min integer := 0;
  v_late integer := 0;
  v_early integer := 0;
  v_ot_cand integer := 0;
  v_full_leave boolean := false;
  v_year_start date;
  v_sick_prior integer := 0;
  v_personal_prior integer := 0;
  v_ded_sick numeric := 0;
  v_ded_personal numeric := 0;
  v_ded_late numeric := 0;
  v_ded_early numeric := 0;
  v_ded_absence numeric := 0;
  v_add_wd numeric := 0;
  v_add_rest numeric := 0;
  v_add_nat numeric := 0;
  v_ot jsonb;
  v_codes text[] := ARRAY[]::text[];
  v_flags text[] := ARRAY[]::text[];
  v_need_comp boolean := false;
BEGIN
  v_eval := COALESCE(p_eval, public.dk_attendance_eval_day(p_user_id, p_date));
  v_day_type := NULLIF(v_eval->>'day_type', '');
  v_sched_type := NULLIF(v_eval->>'schedule_type', '');
  v_status := NULLIF(v_eval->>'attendance_status', '');
  v_leave_type := NULLIF(v_eval->>'leave_type', '');
  v_leave_status := NULLIF(v_eval->>'leave_status', '');
  v_anomaly := NULLIF(v_eval->>'anomaly', '');
  v_work_min := COALESCE((v_eval->>'work_minutes')::integer, 0);
  v_late := COALESCE((v_eval->>'late_minutes')::integer, 0);
  v_early := COALESCE((v_eval->>'early_leave_minutes')::integer, 0);
  v_ot_cand := COALESCE((v_eval->>'potential_overtime_minutes')::integer, 0);
  v_sched_min := public.dk_payroll_span_minutes(v_eval->>'scheduled_start', v_eval->>'scheduled_end');

  SELECT COALESCE(NULLIF(r.leave_unit, ''), 'FULL_DAY')
    INTO v_leave_unit
  FROM public.attendance_leave_requests r
  WHERE r.user_id = p_user_id
    AND r.leave_date = p_date
    AND r.status = 'APPROVED'
    AND r.leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE')
  LIMIT 1;

  v_full_leave := (
    v_leave_status = 'APPROVED'
    AND v_leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE')
    AND COALESCE(v_leave_unit, 'FULL_DAY') = 'FULL_DAY'
  );

  v_need_comp := (
    v_sched_type = 'WORK'
    OR v_status IN ('LEAVE', 'ABSENT', 'NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'INCOMPLETE')
    OR v_work_min > 0
    OR v_full_leave
    OR v_day_type IN ('NATIONAL_HOLIDAY', 'REGULAR_HOLIDAY', 'REST_DAY', 'WORKDAY')
  );

  v_comp := public.dk_payroll_compensation_on(p_user_id, p_date);
  IF v_comp IS NULL THEN
    IF v_need_comp THEN
      v_flags := v_flags || ARRAY['COMPENSATION_MISSING'];
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'work_date', p_date,
      'day_type', v_day_type,
      'schedule_type', v_sched_type,
      'attendance_status', v_status,
      'leave_type', v_leave_type,
      'leave_status', v_leave_status,
      'compensation', NULL,
      'scheduled_minutes', v_sched_min,
      'actual_work_minutes', v_work_min,
      'late_minutes', v_late,
      'early_leave_minutes', v_early,
      'deductions', pg_catalog.jsonb_build_object(
        'sick_leave', 0, 'personal_leave', 0, 'late', 0, 'early_leave', 0, 'absence', 0
      ),
      'additional_pay', pg_catalog.jsonb_build_object(
        'weekday_overtime', 0, 'rest_day_work', 0, 'national_holiday_work', 0
      ),
      'codes', to_jsonb(v_codes),
      'review_flags', to_jsonb(v_flags)
    );
  END IF;

  v_pay_type := v_comp->>'pay_type';
  IF v_pay_type IS DISTINCT FROM 'MONTHLY' THEN
    RAISE EXCEPTION 'HOURLY_PAYROLL_NOT_IMPLEMENTED';
  END IF;

  v_salary := (v_comp->>'monthly_salary')::numeric;
  v_rates := public.dk_payroll_monthly_rates(v_salary);
  v_daily := (v_rates->>'daily_wage')::numeric;
  v_hourly := (v_rates->>'hourly_wage')::numeric;
  v_minute := (v_rates->>'minute_wage')::numeric;

  IF v_leave_unit = 'HOURS' THEN
    v_flags := v_flags || ARRAY['HOURS_LEAVE_NOT_IMPLEMENTED'];
    v_full_leave := false;
  END IF;

  v_year_start := pg_catalog.date_trunc('year', p_date::timestamp)::date;

  IF v_day_type = 'NATIONAL_HOLIDAY' THEN
    v_flags := v_flags || ARRAY['holiday_transfer_not_modeled'];
    IF v_work_min > 0 THEN
      v_add_nat := v_daily;
      v_flags := v_flags || ARRAY['holiday_work_review_required'];
      v_codes := v_codes || ARRAY['NATIONAL_HOLIDAY_WORK'];
      IF v_work_min > public.dk_payroll_rule('NORMAL_DAILY_HOURS')::integer * 60 THEN
        v_ot := public.dk_payroll_overtime_amount(
          v_hourly,
          v_work_min - (public.dk_payroll_rule('NORMAL_DAILY_HOURS')::integer * 60),
          'WEEKDAY'
        );
        v_add_wd := COALESCE((v_ot->>'amount')::numeric, 0);
        v_flags := v_flags || ARRAY['overtime_review_required'];
        IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
          v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
        END IF;
      END IF;
    END IF;
    IF v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    END IF;

  ELSIF v_day_type = 'REGULAR_HOLIDAY' THEN
    IF v_work_min > 0 OR v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['REGULAR_HOLIDAY_WORK_REVIEW_REQUIRED'];
      v_codes := v_codes || ARRAY['REGULAR_HOLIDAY_WORK'];
    END IF;

  ELSIF v_day_type = 'REST_DAY' THEN
    IF v_work_min > 0 THEN
      v_ot := public.dk_payroll_overtime_amount(v_hourly, v_work_min, 'REST_DAY');
      v_add_rest := COALESCE((v_ot->>'amount')::numeric, 0);
      v_flags := v_flags || ARRAY['overtime_review_required'];
      v_codes := v_codes || ARRAY['REST_DAY_WORK'];
      IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
        v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
      END IF;
    END IF;
    IF v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    END IF;

  ELSIF v_sched_type = 'OFF' THEN
    IF v_work_min > 0 OR v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['overtime_review_required'];
      v_codes := v_codes || ARRAY['UNCLASSIFIED_OFF_WORK'];
    END IF;

  ELSIF v_sched_type = 'WORK' OR v_day_type = 'WORKDAY' THEN
    IF v_full_leave THEN
      IF v_anomaly = 'LEAVE_WITH_ATTENDANCE' THEN
        v_flags := v_flags || ARRAY['LEAVE_WITH_ATTENDANCE'];
      END IF;
      IF v_leave_type = 'SICK_LEAVE' THEN
        v_sick_prior := public.dk_payroll_year_leave_count(p_user_id, 'SICK_LEAVE', v_year_start, p_date);
        IF v_sick_prior >= public.dk_payroll_rule('SICK_LEAVE_HALF_PAY_MAX_DAYS')::integer THEN
          v_flags := v_flags || ARRAY['SICK_LEAVE_OVER_30_REVIEW_REQUIRED'];
          v_codes := v_codes || ARRAY['SICK_LEAVE_OVER_30_REVIEW_REQUIRED'];
        ELSE
          v_ded_sick := v_daily * public.dk_payroll_rule('SICK_LEAVE_DEDUCTION_FRACTION');
          v_codes := v_codes || ARRAY['SICK_LEAVE_HALF_PAY'];
        END IF;
      ELSIF v_leave_type = 'PERSONAL_LEAVE' THEN
        v_personal_prior := public.dk_payroll_year_leave_count(p_user_id, 'PERSONAL_LEAVE', v_year_start, p_date);
        IF v_sched_min <= 0 THEN
          v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
        ELSE
          v_ded_personal := LEAST(v_sched_min::numeric * v_minute, v_daily);
          v_codes := v_codes || ARRAY['PERSONAL_LEAVE_UNPAID'];
        END IF;
        IF v_personal_prior >= public.dk_payroll_rule('PERSONAL_LEAVE_REVIEW_DAYS')::integer THEN
          v_flags := v_flags || ARRAY['PERSONAL_LEAVE_OVER_14_REVIEW_REQUIRED'];
        END IF;
      ELSIF v_leave_type = 'ANNUAL_LEAVE' THEN
        v_ded_sick := 0;
        v_flags := v_flags || ARRAY['annual_leave_entitlement_not_verified'];
        v_codes := v_codes || ARRAY['ANNUAL_LEAVE_PAID'];
      END IF;
    ELSIF v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    ELSIF v_status = 'ABSENT' THEN
      IF v_sched_min <= 0 THEN
        v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
      ELSE
        v_ded_absence := LEAST(v_sched_min::numeric * v_minute, v_daily);
        v_codes := v_codes || ARRAY['UNEXCUSED_ABSENCE'];
      END IF;
    ELSIF v_status IN ('NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY') THEN
      IF v_late > 0 THEN
        v_ded_late := v_late::numeric * v_minute;
        v_codes := v_codes || ARRAY['LATE_PRO_RATA'];
      END IF;
      IF v_early > 0 THEN
        v_ded_early := v_early::numeric * v_minute;
        v_codes := v_codes || ARRAY['EARLY_LEAVE_PRO_RATA'];
      END IF;
      IF v_ot_cand > 0 THEN
        v_ot := public.dk_payroll_overtime_amount(v_hourly, v_ot_cand, 'WEEKDAY');
        v_add_wd := COALESCE((v_ot->>'amount')::numeric, 0);
        v_flags := v_flags || ARRAY['overtime_review_required'];
        v_codes := v_codes || ARRAY['WEEKDAY_OT_CANDIDATE'];
        IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
          v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
        END IF;
      END IF;
    ELSIF v_status = 'NO_SCHEDULE' THEN
      IF v_work_min > 0 THEN
        v_flags := v_flags || ARRAY['overtime_review_required'];
      END IF;
    END IF;
  ELSE
    IF v_work_min > 0 OR v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'work_date', p_date,
    'day_type', v_day_type,
    'schedule_type', v_sched_type,
    'attendance_status', v_status,
    'leave_type', v_leave_type,
    'leave_status', v_leave_status,
    'compensation', pg_catalog.jsonb_build_object(
      'id', v_comp->>'id',
      'employment_stage', v_comp->>'employment_stage',
      'pay_type', v_pay_type,
      'monthly_salary', v_salary
    ),
    'rates', v_rates,
    'scheduled_minutes', v_sched_min,
    'actual_work_minutes', v_work_min,
    'late_minutes', v_late,
    'early_leave_minutes', v_early,
    'potential_overtime_minutes', v_ot_cand,
    'deductions', pg_catalog.jsonb_build_object(
      'sick_leave', v_ded_sick,
      'personal_leave', v_ded_personal,
      'late', v_ded_late,
      'early_leave', v_ded_early,
      'absence', v_ded_absence
    ),
    'additional_pay', pg_catalog.jsonb_build_object(
      'weekday_overtime', v_add_wd,
      'rest_day_work', v_add_rest,
      'national_holiday_work', v_add_nat
    ),
    'codes', to_jsonb(v_codes),
    'review_flags', to_jsonb(v_flags)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_payroll_preview_month(p_user_id uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from date;
  v_to date;
  v_d date;
  v_eval jsonb;
  v_day jsonb;
  v_days jsonb := '[]'::jsonb;
  v_segs jsonb := '[]'::jsonb;
  v_comp jsonb;
  v_full_cover boolean := false;
  v_period_n integer := 0;
  v_base numeric := 0;
  v_day_base numeric := 0;
  v_ded_sick numeric := 0;
  v_ded_personal numeric := 0;
  v_ded_late numeric := 0;
  v_ded_early numeric := 0;
  v_ded_absence numeric := 0;
  v_add_wd numeric := 0;
  v_add_rest numeric := 0;
  v_add_nat numeric := 0;
  v_n_sick integer := 0;
  v_n_personal integer := 0;
  v_n_annual integer := 0;
  v_n_rest integer := 0;
  v_n_rh integer := 0;
  v_n_nh integer := 0;
  v_late integer := 0;
  v_early integer := 0;
  v_flag_ot boolean := false;
  v_flag_sick30 boolean := false;
  v_flag_pers14 boolean := false;
  v_flag_rh boolean := false;
  v_flag_hol boolean := false;
  v_flag_comp boolean := false;
  v_flag_inc boolean := false;
  v_flag_al boolean := false;
  v_flag_xfer boolean := false;
  v_flag_otlim boolean := false;
  v_ready boolean := true;
  v_flags jsonb;
  v_ded_total numeric;
  v_add_total numeric;
  v_gross numeric;
  v_row public.employee_compensation_periods%ROWTYPE;
BEGIN
  PERFORM public.dk_schedule_require_admin();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'month required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN
    RAISE EXCEPTION 'employee not found';
  END IF;

  v_from := pg_catalog.date_trunc('month', p_month::timestamp)::date;
  v_to := ((v_from + interval '1 month')::date - 1);

  IF EXISTS (
    SELECT 1 FROM public.employee_compensation_periods c
    WHERE c.user_id = p_user_id
      AND c.pay_type = 'HOURLY'
      AND c.effective_from <= v_to
      AND (c.effective_to IS NULL OR c.effective_to >= v_from)
  ) THEN
    RAISE EXCEPTION 'HOURLY_PAYROLL_NOT_IMPLEMENTED';
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.employee_compensation_periods c
    WHERE c.user_id = p_user_id
      AND c.pay_type = 'MONTHLY'
      AND c.effective_from <= v_to
      AND (c.effective_to IS NULL OR c.effective_to >= v_from)
    ORDER BY c.effective_from ASC
  LOOP
    v_period_n := v_period_n + 1;
    v_segs := v_segs || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', v_row.id,
        'employment_stage', v_row.employment_stage,
        'pay_type', v_row.pay_type,
        'monthly_salary', v_row.monthly_salary,
        'effective_from', v_row.effective_from,
        'effective_to', v_row.effective_to,
        'rates', public.dk_payroll_monthly_rates(v_row.monthly_salary)
      )
    );
  END LOOP;

  SELECT COUNT(*) = 1
    AND BOOL_AND(c.effective_from <= v_from AND (c.effective_to IS NULL OR c.effective_to >= v_to))
    INTO v_full_cover
  FROM public.employee_compensation_periods c
  WHERE c.user_id = p_user_id
    AND c.pay_type = 'MONTHLY'
    AND c.effective_from <= v_to
    AND (c.effective_to IS NULL OR c.effective_to >= v_from);

  IF COALESCE(v_full_cover, false) AND v_period_n = 1 THEN
    v_base := (v_segs->0->>'monthly_salary')::numeric;
  END IF;

  v_d := v_from;
  WHILE v_d <= v_to LOOP
    v_eval := public.dk_attendance_eval_day(p_user_id, v_d);
    v_day := public.dk_payroll_preview_day(p_user_id, v_d, v_eval);
    v_days := v_days || pg_catalog.jsonb_build_array(v_day);

    v_comp := v_day->'compensation';
    IF v_comp IS NOT NULL AND pg_catalog.jsonb_typeof(v_comp) = 'object' THEN
      IF NOT COALESCE(v_full_cover, false) THEN
        v_day_base := COALESCE((v_day->'rates'->>'daily_wage')::numeric, 0);
        v_base := v_base + v_day_base;
      END IF;
    END IF;

    v_ded_sick := v_ded_sick + COALESCE((v_day->'deductions'->>'sick_leave')::numeric, 0);
    v_ded_personal := v_ded_personal + COALESCE((v_day->'deductions'->>'personal_leave')::numeric, 0);
    v_ded_late := v_ded_late + COALESCE((v_day->'deductions'->>'late')::numeric, 0);
    v_ded_early := v_ded_early + COALESCE((v_day->'deductions'->>'early_leave')::numeric, 0);
    v_ded_absence := v_ded_absence + COALESCE((v_day->'deductions'->>'absence')::numeric, 0);
    v_add_wd := v_add_wd + COALESCE((v_day->'additional_pay'->>'weekday_overtime')::numeric, 0);
    v_add_rest := v_add_rest + COALESCE((v_day->'additional_pay'->>'rest_day_work')::numeric, 0);
    v_add_nat := v_add_nat + COALESCE((v_day->'additional_pay'->>'national_holiday_work')::numeric, 0);

    v_late := v_late + COALESCE((v_day->>'late_minutes')::integer, 0);
    v_early := v_early + COALESCE((v_day->>'early_leave_minutes')::integer, 0);

    IF v_day->>'leave_type' = 'SICK_LEAVE' AND v_day->>'leave_status' = 'APPROVED' THEN
      v_n_sick := v_n_sick + 1;
    END IF;
    IF v_day->>'leave_type' = 'PERSONAL_LEAVE' AND v_day->>'leave_status' = 'APPROVED' THEN
      v_n_personal := v_n_personal + 1;
    END IF;
    IF v_day->>'leave_type' = 'ANNUAL_LEAVE' AND v_day->>'leave_status' = 'APPROVED' THEN
      v_n_annual := v_n_annual + 1;
    END IF;
    IF v_day->>'day_type' = 'REST_DAY' THEN
      v_n_rest := v_n_rest + 1;
    END IF;
    IF v_day->>'day_type' = 'REGULAR_HOLIDAY' THEN
      v_n_rh := v_n_rh + 1;
    END IF;
    IF v_day->>'day_type' = 'NATIONAL_HOLIDAY' THEN
      v_n_nh := v_n_nh + 1;
    END IF;

    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["overtime_review_required"]'::jsonb THEN
      v_flag_ot := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["SICK_LEAVE_OVER_30_REVIEW_REQUIRED"]'::jsonb THEN
      v_flag_sick30 := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["PERSONAL_LEAVE_OVER_14_REVIEW_REQUIRED"]'::jsonb THEN
      v_flag_pers14 := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["REGULAR_HOLIDAY_WORK_REVIEW_REQUIRED"]'::jsonb THEN
      v_flag_rh := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["holiday_work_review_required"]'::jsonb THEN
      v_flag_hol := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["COMPENSATION_MISSING"]'::jsonb THEN
      v_flag_comp := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED"]'::jsonb
       OR COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["LEAVE_WITH_ATTENDANCE"]'::jsonb
       OR COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["HOURS_LEAVE_NOT_IMPLEMENTED"]'::jsonb
    THEN
      v_flag_inc := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["annual_leave_entitlement_not_verified"]'::jsonb THEN
      v_flag_al := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["holiday_transfer_not_modeled"]'::jsonb THEN
      v_flag_xfer := true;
    END IF;
    IF COALESCE(v_day->'review_flags', '[]'::jsonb) @> '["OVERTIME_LIMIT_REVIEW_REQUIRED"]'::jsonb THEN
      v_flag_otlim := true;
    END IF;

    v_d := v_d + 1;
  END LOOP;

  IF v_period_n = 0 THEN
    v_flag_comp := true;
    v_base := 0;
  END IF;

  v_ded_total := v_ded_sick + v_ded_personal + v_ded_late + v_ded_early + v_ded_absence;
  v_add_total := v_add_wd + v_add_rest + v_add_nat;
  v_gross := v_base - v_ded_total + v_add_total;

  v_ready := NOT (
    v_flag_ot OR v_flag_sick30 OR v_flag_pers14 OR v_flag_rh OR v_flag_hol
    OR v_flag_comp OR v_flag_inc OR v_flag_otlim
  );

  v_flags := pg_catalog.jsonb_build_object(
    'overtime_review_required', v_flag_ot,
    'sick_leave_over_30', v_flag_sick30,
    'personal_leave_over_14', v_flag_pers14,
    'regular_holiday_work', v_flag_rh,
    'holiday_work_review_required', v_flag_hol,
    'compensation_missing', v_flag_comp,
    'incomplete_attendance', v_flag_inc,
    'annual_leave_entitlement_not_verified', v_flag_al,
    'holiday_transfer_not_modeled', v_flag_xfer,
    'overtime_limit_review_required', v_flag_otlim
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'payroll_ready', v_ready,
    'preview_only', true,
    'employee', pg_catalog.jsonb_build_object('user_id', p_user_id),
    'month', v_from,
    'compensation_segments', v_segs,
    'base_salary', public.dk_payroll_pair(v_base),
    'deductions', pg_catalog.jsonb_build_object(
      'sick_leave', public.dk_payroll_pair(v_ded_sick),
      'personal_leave', public.dk_payroll_pair(v_ded_personal),
      'late', public.dk_payroll_pair(v_ded_late),
      'early_leave', public.dk_payroll_pair(v_ded_early),
      'absence', public.dk_payroll_pair(v_ded_absence)
    ),
    'additional_pay', pg_catalog.jsonb_build_object(
      'weekday_overtime', public.dk_payroll_pair(v_add_wd),
      'rest_day_work', public.dk_payroll_pair(v_add_rest),
      'national_holiday_work', public.dk_payroll_pair(v_add_nat)
    ),
    'totals', pg_catalog.jsonb_build_object(
      'total_deductions', public.dk_payroll_pair(v_ded_total),
      'total_additional_pay', public.dk_payroll_pair(v_add_total),
      'gross_pay_before_other_items', public.dk_payroll_pair(v_gross)
    ),
    'counters', pg_catalog.jsonb_build_object(
      'sick_leave_days', v_n_sick,
      'personal_leave_days', v_n_personal,
      'annual_leave_days', v_n_annual,
      'rest_days', v_n_rest,
      'regular_holidays', v_n_rh,
      'national_holidays', v_n_nh,
      'late_minutes', v_late,
      'early_leave_minutes', v_early
    ),
    'review_flags', v_flags,
    'daily_breakdown', v_days
  );
END;
$$;

COMMENT ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) IS
  'Stage 18-8 Admin-only MONTHLY payroll preview. Not settlement. Uses compensation-on-date, eval facts, and leave overlay. V1 LSA baseline 2026.';

REVOKE ALL ON FUNCTION public.dk_payroll_rule(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_round_ntd(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_pair(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_monthly_rates(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_span_minutes(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_overtime_amount(numeric, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_compensation_on(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_year_leave_count(uuid, text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_preview_day(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'rpc.preview_month' AS check_name,
       (to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.preview_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'exec.authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'exec.helper_day_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_preview_day(uuid,date,jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_preview_day(uuid,date,jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'exec.rule_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_rule(text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_rule(text)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'hourly_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%HOURLY_PAYROLL_NOT_IMPLEMENTED%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%HOURLY_PAYROLL_NOT_IMPLEMENTED%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'rules_centralized',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%MONTHLY_DAYS%'
            AND pg_get_functiondef(p.oid) ILIKE '%OT_MULT_TIER1%'
            AND pg_get_functiondef(p.oid) ILIKE '%SICK_LEAVE_DEDUCTION_FRACTION%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_rule'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%MONTHLY_DAYS%'
            AND pg_get_functiondef(p.oid) ILIKE '%OT_MULT_TIER1%'
            AND pg_get_functiondef(p.oid) ILIKE '%SICK_LEAVE_DEDUCTION_FRACTION%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_rule'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'no_punch_write',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_payroll_preview_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'no_new_table_write_grant',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('employee_compensation_periods', 'attendance_shifts', 'attendance_leave_requests')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('employee_compensation_periods', 'attendance_shifts', 'attendance_leave_requests')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
