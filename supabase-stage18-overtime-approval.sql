-- ============================================================
-- DK Computer｜Stage 18-9 加班確認 + Payroll Preview 整合
-- 晚打卡 ≠ 核准加班。Payroll 只認 APPROVED approved_minutes。
-- REJECTED：加給 0，不再因同一 candidate 保持 overtime_review_required。
-- 不刪 punch。不做 Settlement。
--
-- 必須在 payroll-engine 之後執行。
-- 本檔 REPLACE（最後執行版本）：
--   dk_payroll_preview_day
--   backoffice_payroll_preview_month
--
-- dependency：
--   scheduling → default-shift → leave-requests
--   → attendance-evaluation → compensation
--   → day-classification → leave-types → payroll-engine
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
UNION ALL SELECT 2, 'rpc.preview_day',
       (to_regprocedure('public.dk_payroll_preview_day(uuid,date,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_payroll_preview_day(uuid,date,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.eval_day',
       (to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.ot_helper',
       (to_regprocedure('public.dk_payroll_overtime_amount(numeric,integer,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_payroll_overtime_amount(numeric,integer,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

CREATE TABLE IF NOT EXISTS public.attendance_overtime_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  overtime_type text NOT NULL,
  candidate_minutes integer NOT NULL,
  approved_minutes integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  note text NULL,
  approved_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT attendance_overtime_approvals_type_ck
    CHECK (overtime_type IN ('WEEKDAY', 'REST_DAY', 'NATIONAL_HOLIDAY')),
  CONSTRAINT attendance_overtime_approvals_status_ck
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT attendance_overtime_approvals_candidate_ck
    CHECK (candidate_minutes >= 0),
  CONSTRAINT attendance_overtime_approvals_approved_ck
    CHECK (approved_minutes >= 0 AND approved_minutes <= candidate_minutes),
  CONSTRAINT attendance_overtime_approvals_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_overtime_approvals_user_date_type_uidx
  ON public.attendance_overtime_approvals (user_id, work_date, overtime_type);

CREATE INDEX IF NOT EXISTS attendance_overtime_approvals_user_month_idx
  ON public.attendance_overtime_approvals (user_id, work_date);

COMMENT ON TABLE public.attendance_overtime_approvals IS
  'Stage 18-9 Admin overtime decisions. One official row per user+date+type. REJECTED does not delete punch.';
COMMENT ON COLUMN public.attendance_overtime_approvals.candidate_minutes IS
  'Server-computed from attendance facts. Never trust client.';
COMMENT ON COLUMN public.attendance_overtime_approvals.approved_minutes IS
  'Minutes Payroll may pay. 0..candidate. REJECTED stores 0.';

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- Admin SELECT 全部。Staff / anon 不可讀。無表寫入 GRANT / policy。
-- ============================================================
/*

ALTER TABLE public.attendance_overtime_approvals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_overtime_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.attendance_overtime_approvals TO authenticated;

DROP POLICY IF EXISTS attendance_overtime_approvals_select_admin ON public.attendance_overtime_approvals;
CREATE POLICY attendance_overtime_approvals_select_admin
  ON public.attendance_overtime_approvals
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
  IF to_regclass('public.attendance_overtime_approvals') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: attendance_overtime_approvals missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.backoffice_payroll_preview_month(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_payroll_preview_day(uuid,date,jsonb)') IS NULL
     OR to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_schedule_require_admin()') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: run payroll-engine first.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_ot_compute_candidate(p_eval jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_day text;
  v_sched text;
  v_status text;
  v_work integer;
  v_ot integer;
BEGIN
  IF p_eval IS NULL THEN
    RETURN NULL;
  END IF;
  v_day := NULLIF(p_eval->>'day_type', '');
  v_sched := NULLIF(p_eval->>'schedule_type', '');
  v_status := NULLIF(p_eval->>'attendance_status', '');
  v_work := COALESCE((p_eval->>'work_minutes')::integer, 0);
  v_ot := COALESCE((p_eval->>'potential_overtime_minutes')::integer, 0);

  IF v_day = 'REGULAR_HOLIDAY' AND (v_work > 0 OR v_status = 'INCOMPLETE') THEN
    RETURN pg_catalog.jsonb_build_object(
      'overtime_type', 'REGULAR_HOLIDAY',
      'candidate_minutes', v_work,
      'actionable', false
    );
  END IF;
  IF v_day = 'NATIONAL_HOLIDAY' AND v_work > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'overtime_type', 'NATIONAL_HOLIDAY',
      'candidate_minutes', v_work,
      'actionable', true
    );
  END IF;
  IF v_day = 'REST_DAY' AND v_work > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'overtime_type', 'REST_DAY',
      'candidate_minutes', v_work,
      'actionable', true
    );
  END IF;
  IF (v_sched = 'WORK' OR v_day = 'WORKDAY')
     AND v_status IN ('NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY')
     AND v_ot > 0
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'overtime_type', 'WEEKDAY',
      'candidate_minutes', v_ot,
      'actionable', true
    );
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.dk_ot_compute_candidate(jsonb) IS
  'Server candidate minutes from eval facts. WEEKDAY uses potential_overtime; REST_DAY/NATIONAL_HOLIDAY use actual work_minutes.';

CREATE OR REPLACE FUNCTION public.dk_payroll_settle_overtime(
  p_user_id uuid,
  p_date date,
  p_eval jsonb,
  p_hourly numeric,
  p_daily numeric
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cand jsonb;
  v_type text;
  v_cand_min integer := 0;
  v_actionable boolean := false;
  v_appr public.attendance_overtime_approvals%ROWTYPE;
  v_status text := NULL;
  v_app_min integer := 0;
  v_add_wd numeric := 0;
  v_add_rest numeric := 0;
  v_add_nat numeric := 0;
  v_ot jsonb;
  v_flags text[] := ARRAY[]::text[];
  v_codes text[] := ARRAY[]::text[];
  v_safe integer;
BEGIN
  v_cand := public.dk_ot_compute_candidate(p_eval);
  IF v_cand IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'weekday_overtime', 0, 'rest_day_work', 0, 'national_holiday_work', 0,
      'overtime_type', NULL, 'candidate_minutes', 0, 'approved_minutes', 0,
      'status', NULL, 'actionable', false,
      'flags', '[]'::jsonb, 'codes', '[]'::jsonb
    );
  END IF;

  v_type := v_cand->>'overtime_type';
  v_cand_min := COALESCE((v_cand->>'candidate_minutes')::integer, 0);
  v_actionable := COALESCE((v_cand->>'actionable')::boolean, false);

  IF v_type = 'REGULAR_HOLIDAY' THEN
    RETURN pg_catalog.jsonb_build_object(
      'weekday_overtime', 0, 'rest_day_work', 0, 'national_holiday_work', 0,
      'overtime_type', v_type, 'candidate_minutes', v_cand_min, 'approved_minutes', 0,
      'status', NULL, 'actionable', false,
      'flags', '[]'::jsonb, 'codes', '[]'::jsonb
    );
  END IF;

  SELECT * INTO v_appr
  FROM public.attendance_overtime_approvals a
  WHERE a.user_id = p_user_id
    AND a.work_date = p_date
    AND a.overtime_type = v_type;
  IF FOUND THEN
    v_status := v_appr.status;
    v_app_min := COALESCE(v_appr.approved_minutes, 0);
  END IF;

  IF v_status IS NULL OR v_status = 'PENDING' THEN
    IF v_type = 'NATIONAL_HOLIDAY' THEN
      v_flags := v_flags || ARRAY['holiday_work_review_required'];
      v_codes := v_codes || ARRAY['NATIONAL_HOLIDAY_WORK_PENDING'];
    ELSE
      v_flags := v_flags || ARRAY['overtime_review_required'];
      v_codes := v_codes || ARRAY['OVERTIME_PENDING'];
    END IF;
  ELSIF v_status = 'REJECTED' THEN
    v_app_min := 0;
    v_codes := v_codes || ARRAY['OVERTIME_REJECTED'];
  ELSIF v_status = 'APPROVED' THEN
    v_app_min := LEAST(GREATEST(v_app_min, 0), v_cand_min);
    IF v_type = 'WEEKDAY' THEN
      v_ot := public.dk_payroll_overtime_amount(p_hourly, v_app_min, 'WEEKDAY');
      v_add_wd := COALESCE((v_ot->>'amount')::numeric, 0);
      v_codes := v_codes || ARRAY['WEEKDAY_OT_APPROVED'];
      IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
        v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
      END IF;
    ELSIF v_type = 'REST_DAY' THEN
      v_ot := public.dk_payroll_overtime_amount(p_hourly, v_app_min, 'REST_DAY');
      v_add_rest := COALESCE((v_ot->>'amount')::numeric, 0);
      v_codes := v_codes || ARRAY['REST_DAY_WORK_APPROVED'];
      IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
        v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
      END IF;
    ELSIF v_type = 'NATIONAL_HOLIDAY' THEN
      v_add_nat := COALESCE(p_daily, 0);
      v_codes := v_codes || ARRAY['NATIONAL_HOLIDAY_WORK_APPROVED'];
      v_safe := public.dk_payroll_rule('NORMAL_DAILY_HOURS')::integer * 60;
      IF v_app_min > v_safe THEN
        v_ot := public.dk_payroll_overtime_amount(p_hourly, v_app_min - v_safe, 'WEEKDAY');
        v_add_wd := COALESCE((v_ot->>'amount')::numeric, 0);
        IF COALESCE((v_ot->>'limit_review')::boolean, false) THEN
          v_flags := v_flags || ARRAY['OVERTIME_LIMIT_REVIEW_REQUIRED'];
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'weekday_overtime', v_add_wd,
    'rest_day_work', v_add_rest,
    'national_holiday_work', v_add_nat,
    'overtime_type', v_type,
    'candidate_minutes', v_cand_min,
    'approved_minutes', v_app_min,
    'status', v_status,
    'actionable', v_actionable,
    'flags', to_jsonb(v_flags),
    'codes', to_jsonb(v_codes)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_get_overtime_candidates(p_user_id uuid, p_month date)
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
  v_cand jsonb;
  v_appr public.attendance_overtime_approvals%ROWTYPE;
  v_rows jsonb := '[]'::jsonb;
  v_type text;
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
  v_d := v_from;
  WHILE v_d <= v_to LOOP
    v_eval := public.dk_attendance_eval_day(p_user_id, v_d);
    v_cand := public.dk_ot_compute_candidate(v_eval);
    IF v_cand IS NOT NULL THEN
      v_type := v_cand->>'overtime_type';
      SELECT * INTO v_appr
      FROM public.attendance_overtime_approvals a
      WHERE a.user_id = p_user_id AND a.work_date = v_d AND a.overtime_type = v_type;
      v_rows := v_rows || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'work_date', v_d,
          'day_type', v_eval->>'day_type',
          'overtime_type', v_type,
          'scheduled_end', v_eval->>'scheduled_end',
          'actual_clock_in', v_eval->>'actual_clock_in',
          'actual_clock_out', v_eval->>'actual_clock_out',
          'work_minutes', COALESCE((v_eval->>'work_minutes')::integer, 0),
          'candidate_minutes', COALESCE((v_cand->>'candidate_minutes')::integer, 0),
          'approved_minutes', CASE WHEN FOUND THEN v_appr.approved_minutes ELSE NULL END,
          'status', CASE WHEN FOUND THEN v_appr.status ELSE NULL END,
          'note', CASE WHEN FOUND THEN v_appr.note ELSE NULL END,
          'actionable', COALESCE((v_cand->>'actionable')::boolean, false)
        )
      );
    END IF;
    v_d := v_d + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'user_id', p_user_id, 'month', v_from, 'rows', v_rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_overtime_approval(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_date date;
  v_type text;
  v_status text;
  v_mins integer;
  v_note text;
  v_eval jsonb;
  v_cand jsonb;
  v_cand_min integer;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'id' OR p_payload ? 'candidate_minutes' OR p_payload ? 'approved_by'
     OR p_payload ? 'approved_at' OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  BEGIN
    v_user := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'user_id', '')), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'user_id required';
  END;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  PERFORM public.dk_schedule_require_enabled_employee(v_user);

  BEGIN
    v_date := (p_payload->>'work_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'work_date required';
  END;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'work_date required';
  END IF;

  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'overtime_type', '')));
  IF v_type = 'REGULAR_HOLIDAY' THEN
    RAISE EXCEPTION 'REGULAR_HOLIDAY_NOT_APPROVABLE';
  END IF;
  IF v_type NOT IN ('WEEKDAY', 'REST_DAY', 'NATIONAL_HOLIDAY') THEN
    RAISE EXCEPTION 'invalid overtime_type';
  END IF;

  v_status := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'status', '')));
  IF v_status NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'invalid overtime status';
  END IF;

  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 200 THEN
    RAISE EXCEPTION 'note too long';
  END IF;

  v_eval := public.dk_attendance_eval_day(v_user, v_date);
  v_cand := public.dk_ot_compute_candidate(v_eval);
  IF v_cand IS NULL OR COALESCE((v_cand->>'actionable')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'no overtime candidate';
  END IF;
  IF (v_cand->>'overtime_type') IS DISTINCT FROM v_type THEN
    RAISE EXCEPTION 'invalid overtime_type';
  END IF;
  v_cand_min := COALESCE((v_cand->>'candidate_minutes')::integer, 0);
  IF v_cand_min <= 0 THEN
    RAISE EXCEPTION 'no overtime candidate';
  END IF;

  IF v_status = 'REJECTED' THEN
    v_mins := 0;
  ELSE
    BEGIN
      v_mins := (p_payload->>'approved_minutes')::integer;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'approved_minutes required';
    END;
    IF v_mins IS NULL THEN
      RAISE EXCEPTION 'approved_minutes required';
    END IF;
    IF v_mins < 0 THEN
      RAISE EXCEPTION 'invalid approved_minutes';
    END IF;
    IF v_mins > v_cand_min THEN
      RAISE EXCEPTION 'approved_minutes exceeds candidate';
    END IF;
  END IF;

  INSERT INTO public.attendance_overtime_approvals (
    user_id, work_date, overtime_type, candidate_minutes, approved_minutes,
    status, note, approved_by, approved_at
  ) VALUES (
    v_user, v_date, v_type, v_cand_min, v_mins,
    v_status, v_note, v_uid, pg_catalog.now()
  )
  ON CONFLICT (user_id, work_date, overtime_type)
  DO UPDATE SET
    candidate_minutes = EXCLUDED.candidate_minutes,
    approved_minutes = EXCLUDED.approved_minutes,
    status = EXCLUDED.status,
    note = EXCLUDED.note,
    approved_by = EXCLUDED.approved_by,
    approved_at = EXCLUDED.approved_at,
    updated_at = pg_catalog.now()
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'user_id', v_user,
    'work_date', v_date,
    'overtime_type', v_type,
    'candidate_minutes', v_cand_min,
    'approved_minutes', v_mins,
    'status', v_status
  );
END;
$$;

-- Last version of dk_payroll_preview_day: additional pay only from APPROVED overtime.
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
  v_settle jsonb;
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
      'scheduled_start', v_eval->>'scheduled_start',
      'scheduled_end', v_eval->>'scheduled_end',
      'shift_name', v_eval->>'shift_name',
      'actual_clock_in', v_eval->>'actual_clock_in',
      'actual_clock_out', v_eval->>'actual_clock_out',
      'scheduled_minutes', v_sched_min,
      'actual_work_minutes', v_work_min,
      'late_minutes', v_late,
      'early_leave_minutes', v_early,
      'potential_overtime_minutes', v_ot_cand,
      'deductions', pg_catalog.jsonb_build_object(
        'sick_leave', 0, 'personal_leave', 0, 'late', 0, 'early_leave', 0, 'absence', 0
      ),
      'additional_pay', pg_catalog.jsonb_build_object(
        'weekday_overtime', 0, 'rest_day_work', 0, 'national_holiday_work', 0
      ),
      'overtime_approval', public.dk_ot_compute_candidate(v_eval),
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
    IF v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    END IF;
  ELSIF v_day_type = 'REGULAR_HOLIDAY' THEN
    IF v_work_min > 0 OR v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['REGULAR_HOLIDAY_WORK_REVIEW_REQUIRED'];
      v_codes := v_codes || ARRAY['REGULAR_HOLIDAY_WORK'];
    END IF;
  ELSIF v_day_type = 'REST_DAY' THEN
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
    ELSIF v_status = 'NO_SCHEDULE' THEN
      IF v_work_min > 0 THEN
        v_flags := v_flags || ARRAY['overtime_review_required'];
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
    END IF;
  ELSE
    IF v_work_min > 0 OR v_status = 'INCOMPLETE' THEN
      v_flags := v_flags || ARRAY['INCOMPLETE_ATTENDANCE_REVIEW_REQUIRED'];
    END IF;
  END IF;

  v_settle := public.dk_payroll_settle_overtime(p_user_id, p_date, v_eval, v_hourly, v_daily);
  v_add_wd := COALESCE((v_settle->>'weekday_overtime')::numeric, 0);
  v_add_rest := COALESCE((v_settle->>'rest_day_work')::numeric, 0);
  v_add_nat := COALESCE((v_settle->>'national_holiday_work')::numeric, 0);
  v_flags := v_flags || ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_settle->'flags', '[]'::jsonb)));
  v_codes := v_codes || ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_settle->'codes', '[]'::jsonb)));

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
    'scheduled_start', v_eval->>'scheduled_start',
    'scheduled_end', v_eval->>'scheduled_end',
    'shift_name', v_eval->>'shift_name',
    'actual_clock_in', v_eval->>'actual_clock_in',
    'actual_clock_out', v_eval->>'actual_clock_out',
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
    'overtime_approval', pg_catalog.jsonb_build_object(
      'overtime_type', v_settle->>'overtime_type',
      'candidate_minutes', COALESCE((v_settle->>'candidate_minutes')::integer, 0),
      'approved_minutes', COALESCE((v_settle->>'approved_minutes')::integer, 0),
      'status', v_settle->>'status',
      'actionable', COALESCE((v_settle->>'actionable')::boolean, false)
    ),
    'codes', to_jsonb(v_codes),
    'review_flags', to_jsonb(v_flags)
  );
END;
$$;

-- Last version of backoffice_payroll_preview_month: sums approval-aware daily additional pay.
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
  v_wd_app integer := 0;
  v_rest_app integer := 0;
  v_nat_app_days integer := 0;
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
  v_ot_stat text;
  v_ot_type text;
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

    v_ot_stat := NULLIF(v_day->'overtime_approval'->>'status', '');
    v_ot_type := NULLIF(v_day->'overtime_approval'->>'overtime_type', '');
    IF v_ot_stat = 'APPROVED' THEN
      IF v_ot_type = 'WEEKDAY' THEN
        v_wd_app := v_wd_app + COALESCE((v_day->'overtime_approval'->>'approved_minutes')::integer, 0);
      ELSIF v_ot_type = 'REST_DAY' THEN
        v_rest_app := v_rest_app + COALESCE((v_day->'overtime_approval'->>'approved_minutes')::integer, 0);
      ELSIF v_ot_type = 'NATIONAL_HOLIDAY' THEN
        v_nat_app_days := v_nat_app_days + 1;
      END IF;
    END IF;

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
      'early_leave_minutes', v_early,
      'approved_weekday_overtime_minutes', v_wd_app,
      'approved_rest_day_minutes', v_rest_app,
      'approved_national_holiday_days', v_nat_app_days
    ),
    'review_flags', v_flags,
    'daily_breakdown', v_days
  );
END;
$$;

COMMENT ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) IS
  'Stage 18-9 last version. MONTHLY payroll preview. OT additional pay uses APPROVED approved_minutes only. Not settlement.';

REVOKE ALL ON FUNCTION public.dk_ot_compute_candidate(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_settle_overtime(uuid, date, jsonb, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_payroll_preview_day(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_get_overtime_candidates(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_overtime_approval(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_get_overtime_candidates(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_overtime_approval(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_payroll_preview_month(uuid, date) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'table.ot_approvals' AS check_name,
       (to_regclass('public.attendance_overtime_approvals') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_overtime_approvals') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'uidx.user_date_type',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'attendance_overtime_approvals_user_date_type_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'attendance_overtime_approvals_user_date_type_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.get_candidates',
       (to_regprocedure('public.backoffice_get_overtime_candidates(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_get_overtime_candidates(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.set_approval',
       (to_regprocedure('public.backoffice_set_overtime_approval(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_set_overtime_approval(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_overtime_approval(jsonb)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_get_overtime_candidates(uuid,date)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_overtime_approval(jsonb)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_get_overtime_candidates(uuid,date)', 'EXECUTE'), true)
        AND NOT COALESCE(has_function_privilege('anon', 'public.backoffice_payroll_preview_month(uuid,date)', 'EXECUTE'), true)
       THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'exec.helper_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_settle_overtime(uuid,date,jsonb,numeric,numeric)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_payroll_settle_overtime(uuid,date,jsonb,numeric,numeric)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rpc.admin_guard_set',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%p_payload%candidate_minutes%as approved%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_overtime_approval'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_ot_compute_candidate%'
            AND pg_get_functiondef(p.oid) ILIKE '%server fields are not client-writable%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_overtime_approval'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'preview_uses_approval',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_payroll_settle_overtime%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_preview_day'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_payroll_settle_overtime%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_payroll_preview_day'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'rls.select_admin_only',
       ((
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_overtime_approvals' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_overtime_approvals'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_overtime_approvals' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_overtime_approvals'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'no_table_write_grant',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_overtime_approvals'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_overtime_approvals'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'no_punch_write',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_overtime_approval'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_overtime_approval'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
