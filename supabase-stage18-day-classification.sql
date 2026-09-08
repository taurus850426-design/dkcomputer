-- ============================================================
-- DK Computer｜Stage 18-6 法定日別分類 + 排班合規基礎（STANDARD_WEEK）
-- 申請 REST_DAY ≠ 勞基法休息日。legal day_type 由 Admin / calendar 決定。
-- 不做薪資計算、不阻擋打卡、不宣稱「符合勞基法」。
--
-- 部署順序（尚未執行的 Stage 18 SQL 請一併依序執行）：
--   scheduling → default-shift → leave-requests → attendance-evaluation
--   → compensation（可平行於本檔，無硬依賴）
--   → 本檔 day-classification
--
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.employee_schedules' AS check_name,
       (to_regclass('public.employee_schedules') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.employee_schedules') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.employee_default_shift_periods',
       (to_regclass('public.employee_default_shift_periods') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_default_shift_periods') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.leave_apply_off',
       (to_regprocedure('public.dk_leave_apply_off(uuid,uuid,date,text)') IS NOT NULL
        OR to_regprocedure('public.dk_leave_apply_off(uuid,uuid,date,text,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_leave_apply_off(uuid,uuid,date,text)') IS NOT NULL
             OR to_regprocedure('public.dk_leave_apply_off(uuid,uuid,date,text,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.approve_leave',
       (to_regprocedure('public.backoffice_approve_leave_request(uuid)') IS NOT NULL
        OR to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_approve_leave_request(uuid)') IS NOT NULL
             OR to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.evaluate_day',
       (to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.dk_schedule_require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_schedules') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: employee_schedules missing.';
  END IF;
END
$$;

ALTER TABLE public.employee_schedules
  ADD COLUMN IF NOT EXISTS day_type text NULL;

ALTER TABLE public.employee_schedules
  DROP CONSTRAINT IF EXISTS employee_schedules_day_type_ck;
ALTER TABLE public.employee_schedules
  ADD CONSTRAINT employee_schedules_day_type_ck
  CHECK (
    day_type IS NULL
    OR day_type IN ('WORKDAY', 'REST_DAY', 'REGULAR_HOLIDAY', 'NATIONAL_HOLIDAY')
  );

ALTER TABLE public.employee_schedules
  DROP CONSTRAINT IF EXISTS employee_schedules_day_type_match_ck;
ALTER TABLE public.employee_schedules
  ADD CONSTRAINT employee_schedules_day_type_match_ck
  CHECK (
    (
      schedule_type = 'WORK'
      AND (day_type IS NULL OR day_type = 'WORKDAY')
    )
    OR (
      schedule_type = 'OFF'
      AND (day_type IS NULL OR day_type IN ('REST_DAY', 'REGULAR_HOLIDAY', 'NATIONAL_HOLIDAY'))
    )
  );

COMMENT ON COLUMN public.employee_schedules.day_type IS
  'Legal day class. Distinct from attendance_leave_requests.leave_type=REST_DAY (staff request). NULL OFF = unclassified.';

CREATE TABLE IF NOT EXISTS public.attendance_calendar_days (
  calendar_date date PRIMARY KEY,
  day_type text NOT NULL,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'MANUAL',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT attendance_calendar_days_type_ck
    CHECK (day_type IN ('NATIONAL_HOLIDAY')),
  CONSTRAINT attendance_calendar_days_name_ck
    CHECK (
      name = pg_catalog.btrim(name)
      AND pg_catalog.length(name) >= 1
      AND pg_catalog.length(name) <= 80
    ),
  CONSTRAINT attendance_calendar_days_source_ck
    CHECK (source IN ('MANUAL'))
);

COMMENT ON TABLE public.attendance_calendar_days IS
  'Company calendar legal days. V1 NATIONAL_HOLIDAY only. Do not hardcode holidays in JS.';

DROP TRIGGER IF EXISTS trg_attendance_calendar_set_updated_at ON public.attendance_calendar_days;
CREATE TRIGGER trg_attendance_calendar_set_updated_at
  BEFORE UPDATE ON public.attendance_calendar_days
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

ALTER TABLE public.attendance_calendar_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_calendar_days FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- Calendar：Admin SELECT。Staff / anon 不可讀（評價 RPC 為 DEFINER）。
-- employee_schedules 既有 RLS 不變；day_type 隨 SELECT 走既有 Admin/own 政策。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_calendar_days') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: attendance_calendar_days missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin missing.';
  END IF;
END
$$;

ALTER TABLE public.attendance_calendar_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_calendar_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.attendance_calendar_days TO authenticated;

DROP POLICY IF EXISTS attendance_calendar_days_select_admin ON public.attendance_calendar_days;
CREATE POLICY attendance_calendar_days_select_admin
  ON public.attendance_calendar_days
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
  IF to_regclass('public.employee_schedules') IS NULL
     OR to_regclass('public.attendance_calendar_days') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: schedule/calendar tables missing.';
  END IF;
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18-4 eval / admin helper missing. Run leave-requests + attendance-evaluation first.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_attendance_resolve_schedule(p_user_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched public.employee_schedules%ROWTYPE;
  v_def public.employee_default_shift_periods%ROWTYPE;
  v_cal text := NULL;
  v_source text := 'NONE';
  v_type text := NULL;
  v_leave text := NULL;
  v_day text := NULL;
  v_work boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'eval arguments required';
  END IF;

  SELECT c.day_type INTO v_cal
  FROM public.attendance_calendar_days c
  WHERE c.calendar_date = p_date;

  SELECT * INTO v_sched
  FROM public.employee_schedules s
  WHERE s.user_id = p_user_id AND s.work_date = p_date;
  IF FOUND THEN
    v_source := 'EXCEPTION';
    v_type := v_sched.schedule_type;
    v_leave := v_sched.leave_type;
    v_work := (v_type = 'WORK');
  ELSE
    SELECT * INTO v_def
    FROM public.employee_default_shift_periods d
    WHERE d.user_id = p_user_id
      AND d.effective_from <= p_date
      AND (d.effective_to IS NULL OR d.effective_to >= p_date)
    ORDER BY d.effective_from DESC
    LIMIT 1;
    IF FOUND THEN
      v_source := 'DEFAULT';
      v_type := 'WORK';
      v_work := true;
    END IF;
  END IF;

  IF v_cal IS NOT DISTINCT FROM 'NATIONAL_HOLIDAY' THEN
    v_day := 'NATIONAL_HOLIDAY';
  ELSIF v_type = 'OFF' THEN
    v_day := v_sched.day_type;
  ELSIF v_type = 'WORK' THEN
    v_day := COALESCE(v_sched.day_type, 'WORKDAY');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schedule_source', v_source,
    'schedule_type', v_type,
    'leave_type', v_leave,
    'day_type', v_day,
    'scheduled_work', v_work
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_leave_apply_off(
  p_actor uuid,
  p_user uuid,
  p_date date,
  p_leave text,
  p_day_type text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.employee_schedules%ROWTYPE;
  v_id uuid;
  v_day text;
BEGIN
  IF p_actor IS NULL OR p_user IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'leave apply arguments required';
  END IF;
  IF p_leave IS DISTINCT FROM 'REST_DAY' THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;
  v_day := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_day_type, '')));
  IF v_day IS DISTINCT FROM 'REST_DAY' AND v_day IS DISTINCT FROM 'REGULAR_HOLIDAY' THEN
    RAISE EXCEPTION 'invalid day_type';
  END IF;

  SELECT * INTO v_row
  FROM public.employee_schedules s
  WHERE s.user_id = p_user AND s.work_date = p_date
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_CONFLICT';
  END IF;

  INSERT INTO public.employee_schedules (
    user_id, work_date, shift_template_id, schedule_type, leave_type, day_type, note,
    shift_name_snapshot, scheduled_start_time, scheduled_end_time,
    scheduled_break_minutes, scheduled_cross_midnight,
    scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
    created_by, updated_by
  ) VALUES (
    p_user, p_date, NULL, 'OFF', p_leave, v_day, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    p_actor, p_actor
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_approve_leave_request(p_id uuid, p_day_type text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.attendance_leave_requests%ROWTYPE;
  v_sched uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id required';
  END IF;
  IF pg_catalog.btrim(COALESCE(p_day_type, '')) = '' THEN
    RAISE EXCEPTION 'day_type required';
  END IF;

  SELECT * INTO v_row
  FROM public.attendance_leave_requests r
  WHERE r.id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'leave request is not PENDING';
  END IF;

  PERFORM public.dk_schedule_require_enabled_employee(v_row.user_id);
  v_sched := public.dk_leave_apply_off(v_uid, v_row.user_id, v_row.leave_date, 'REST_DAY', p_day_type);

  UPDATE public.attendance_leave_requests
  SET status = 'APPROVED',
      approved_by = v_uid,
      approved_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', p_id, 'status', 'APPROVED', 'schedule_id', v_sched, 'day_type', pg_catalog.upper(pg_catalog.btrim(p_day_type))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_employee_rest_day(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_date date;
  v_day text;
  v_sched uuid;
  v_req uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'status' OR p_payload ? 'approved_by' OR p_payload ? 'approved_at'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'leave_type' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', ''))) IS DISTINCT FROM 'REST_DAY' THEN
    RAISE EXCEPTION 'invalid leave_type';
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
    v_date := (p_payload->>'leave_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'leave_date required';
  END;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'leave_date required';
  END IF;
  v_day := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'day_type', '')));
  IF v_day = '' THEN
    RAISE EXCEPTION 'day_type required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_leave_requests r
    WHERE r.user_id = v_user AND r.leave_date = v_date
      AND r.status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'duplicate leave request';
  END IF;

  v_sched := public.dk_leave_apply_off(v_uid, v_user, v_date, 'REST_DAY', v_day);

  INSERT INTO public.attendance_leave_requests (
    user_id, leave_date, leave_type, status,
    approved_by, approved_at
  ) VALUES (
    v_user, v_date, 'REST_DAY', 'APPROVED',
    v_uid, pg_catalog.now()
  )
  RETURNING id INTO v_req;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', v_req, 'status', 'APPROVED', 'schedule_id', v_sched, 'day_type', v_day
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_attendance_eval_day(p_user_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sched public.employee_schedules%ROWTYPE;
  v_def public.employee_default_shift_periods%ROWTYPE;
  v_resolved jsonb;
  v_source text := 'NONE';
  v_type text := NULL;
  v_leave text := NULL;
  v_day text := NULL;
  v_name text := NULL;
  v_start time := NULL;
  v_end time := NULL;
  v_cross boolean := false;
  v_late_grace integer := 0;
  v_early_grace integer := 0;
  v_sched_start timestamptz := NULL;
  v_sched_end timestamptz := NULL;
  v_first_in timestamptz := NULL;
  v_last_out timestamptz := NULL;
  v_open_shift boolean := false;
  v_open_break boolean := false;
  v_work_min integer := 0;
  v_break_min integer := 0;
  v_late_min integer := 0;
  v_early_min integer := 0;
  v_ot_min integer := 0;
  v_status text := 'NO_SCHEDULE';
  r record;
  v_shift_break numeric := 0;
  v_shift_work numeric := 0;
BEGIN
  IF p_user_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'eval arguments required';
  END IF;

  v_resolved := public.dk_attendance_resolve_schedule(p_user_id, p_date);
  v_source := v_resolved->>'schedule_source';
  v_type := NULLIF(v_resolved->>'schedule_type', '');
  v_leave := NULLIF(v_resolved->>'leave_type', '');
  v_day := NULLIF(v_resolved->>'day_type', '');

  SELECT * INTO v_sched
  FROM public.employee_schedules s
  WHERE s.user_id = p_user_id AND s.work_date = p_date;
  IF FOUND THEN
    v_name := v_sched.shift_name_snapshot;
    v_start := v_sched.scheduled_start_time;
    v_end := v_sched.scheduled_end_time;
    v_cross := COALESCE(v_sched.scheduled_cross_midnight, false);
    v_late_grace := COALESCE(v_sched.scheduled_late_grace_minutes, 0);
    v_early_grace := COALESCE(v_sched.scheduled_early_leave_grace_minutes, 0);
  ELSIF v_type = 'WORK' THEN
    SELECT * INTO v_def
    FROM public.employee_default_shift_periods d
    WHERE d.user_id = p_user_id
      AND d.effective_from <= p_date
      AND (d.effective_to IS NULL OR d.effective_to >= p_date)
    ORDER BY d.effective_from DESC
    LIMIT 1;
    IF FOUND THEN
      v_name := v_def.shift_name_snapshot;
      v_start := v_def.scheduled_start_time;
      v_end := v_def.scheduled_end_time;
      v_cross := COALESCE(v_def.scheduled_cross_midnight, false);
      v_late_grace := COALESCE(v_def.scheduled_late_grace_minutes, 0);
      v_early_grace := COALESCE(v_def.scheduled_early_leave_grace_minutes, 0);
    END IF;
  END IF;

  FOR r IN
    SELECT s.id, s.clock_in_at, s.clock_out_at, s.status
    FROM public.attendance_shifts s
    WHERE s.employee_id = p_user_id
      AND ((s.clock_in_at AT TIME ZONE 'Asia/Taipei')::date = p_date)
    ORDER BY s.clock_in_at ASC
  LOOP
    IF v_first_in IS NULL THEN
      v_first_in := r.clock_in_at;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.attendance_breaks b
      WHERE b.shift_id = r.id AND b.break_end_at IS NULL
    ) THEN
      v_open_break := true;
    END IF;
    IF r.clock_out_at IS NULL OR r.status IS DISTINCT FROM 'closed' THEN
      v_open_shift := true;
    ELSE
      IF v_last_out IS NULL OR r.clock_out_at > v_last_out THEN
        v_last_out := r.clock_out_at;
      END IF;
      SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (b.break_end_at - b.break_start_at))), 0)
        INTO v_shift_break
      FROM public.attendance_breaks b
      WHERE b.shift_id = r.id AND b.break_end_at IS NOT NULL;
      v_shift_work := EXTRACT(EPOCH FROM (r.clock_out_at - r.clock_in_at)) - COALESCE(v_shift_break, 0);
      v_work_min := v_work_min + GREATEST(0, FLOOR(v_shift_work / 60.0))::integer;
      v_break_min := v_break_min + GREATEST(0, FLOOR(COALESCE(v_shift_break, 0) / 60.0))::integer;
    END IF;
  END LOOP;

  IF v_type = 'OFF' THEN
    v_status := 'OFF';
  ELSIF v_type IS DISTINCT FROM 'WORK' THEN
    v_status := 'NO_SCHEDULE';
  ELSE
    v_sched_start := ((p_date::timestamp + v_start) AT TIME ZONE 'Asia/Taipei');
    v_sched_end := ((p_date::timestamp + v_end) AT TIME ZONE 'Asia/Taipei');
    IF v_cross THEN
      v_sched_end := v_sched_end + interval '1 day';
    END IF;
    IF v_first_in IS NULL THEN
      v_status := 'ABSENT';
    ELSE
      IF v_first_in > (v_sched_start + (v_late_grace * interval '1 minute')) THEN
        v_late_min := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_first_in - v_sched_start)) / 60.0))::integer;
      END IF;
      IF v_open_shift OR v_open_break THEN
        v_status := 'INCOMPLETE';
      ELSE
        IF v_last_out IS NOT NULL AND v_last_out < (v_sched_end - (v_early_grace * interval '1 minute')) THEN
          v_early_min := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_sched_end - v_last_out)) / 60.0))::integer;
        END IF;
        IF v_last_out IS NOT NULL AND v_last_out > v_sched_end THEN
          v_ot_min := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_last_out - v_sched_end)) / 60.0))::integer;
        END IF;
        IF v_late_min > 0 AND v_early_min > 0 THEN
          v_status := 'LATE_AND_EARLY';
        ELSIF v_late_min > 0 THEN
          v_status := 'LATE';
        ELSIF v_early_min > 0 THEN
          v_status := 'EARLY_LEAVE';
        ELSE
          v_status := 'NORMAL';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'work_date', p_date,
    'schedule_source', v_source,
    'schedule_type', v_type,
    'leave_type', v_leave,
    'day_type', v_day,
    'shift_name', v_name,
    'scheduled_start', CASE WHEN v_start IS NULL THEN NULL ELSE to_char(v_start, 'HH24:MI') END,
    'scheduled_end', CASE WHEN v_end IS NULL THEN NULL ELSE to_char(v_end, 'HH24:MI') END,
    'actual_clock_in', v_first_in,
    'actual_clock_out', v_last_out,
    'work_minutes', v_work_min,
    'break_minutes', v_break_min,
    'late_minutes', v_late_min,
    'early_leave_minutes', v_early_min,
    'potential_overtime_minutes', v_ot_min,
    'attendance_status', v_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_attendance_schedule_compliance(p_user_id uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from date;
  v_to date;
  v_scan_from date;
  v_scan_to date;
  v_d date;
  v_w date;
  v_end date;
  v_resolved jsonb;
  v_day text;
  v_work boolean;
  v_type text;
  v_streak integer := 0;
  v_rest integer := 0;
  v_holiday integer := 0;
  v_off integer := 0;
  v_unclass integer := 0;
  v_nat integer := 0;
  v_win_rest integer;
  v_win_reg integer;
  v_alerts jsonb := '[]'::jsonb;
  v_has_unclass boolean;
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

  v_from := date_trunc('month', p_month::timestamp)::date;
  v_to := ((v_from + interval '1 month')::date - 1);
  v_scan_from := v_from - 6;
  v_scan_to := v_to + 6;

  v_d := v_from;
  WHILE v_d <= v_to LOOP
    v_resolved := public.dk_attendance_resolve_schedule(p_user_id, v_d);
    v_day := NULLIF(v_resolved->>'day_type', '');
    v_type := NULLIF(v_resolved->>'schedule_type', '');
    IF v_type = 'OFF' THEN
      v_off := v_off + 1;
      IF v_day IS NULL THEN
        v_unclass := v_unclass + 1;
      END IF;
    END IF;
    IF v_day = 'REST_DAY' THEN
      v_rest := v_rest + 1;
    ELSIF v_day = 'REGULAR_HOLIDAY' THEN
      v_holiday := v_holiday + 1;
    ELSIF v_day = 'NATIONAL_HOLIDAY' THEN
      v_nat := v_nat + 1;
    END IF;
    v_d := v_d + 1;
  END LOOP;

  IF v_unclass > 0 THEN
    v_alerts := v_alerts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'code', 'UNCLASSIFIED_DAY_TYPE',
      'message', '尚有 ' || v_unclass || ' 日 OFF 未完成日別分類（休息日／例假）'
    ));
  END IF;

  v_d := v_scan_from;
  v_streak := 0;
  WHILE v_d <= v_scan_to LOOP
    v_resolved := public.dk_attendance_resolve_schedule(p_user_id, v_d);
    v_work := COALESCE((v_resolved->>'scheduled_work')::boolean, false);
    IF v_work THEN
      v_streak := v_streak + 1;
      IF v_streak >= 7 AND v_d >= v_from AND v_d <= v_to THEN
        v_alerts := v_alerts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'code', 'CONSECUTIVE_WORK_7',
          'window_end', v_d,
          'message', '連續工作 7 日（截至 ' || to_char(v_d, 'YYYY/MM/DD') || '）'
        ));
        v_streak := 0;
      END IF;
    ELSE
      v_streak := 0;
    END IF;
    v_d := v_d + 1;
  END LOOP;

  v_w := v_scan_from;
  WHILE v_w <= v_to LOOP
    v_end := v_w + 6;
    IF v_end >= v_from THEN
      v_win_rest := 0;
      v_win_reg := 0;
      v_has_unclass := false;
      v_d := v_w;
      WHILE v_d <= v_end LOOP
        v_resolved := public.dk_attendance_resolve_schedule(p_user_id, v_d);
        v_day := NULLIF(v_resolved->>'day_type', '');
        v_type := NULLIF(v_resolved->>'schedule_type', '');
        IF v_type = 'OFF' AND v_day IS NULL THEN
          v_has_unclass := true;
        END IF;
        IF v_day = 'REST_DAY' THEN
          v_win_rest := v_win_rest + 1;
        ELSIF v_day = 'REGULAR_HOLIDAY' THEN
          v_win_reg := v_win_reg + 1;
        END IF;
        v_d := v_d + 1;
      END LOOP;
      IF NOT v_has_unclass THEN
        IF v_win_reg < 1 THEN
          v_alerts := v_alerts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'code', 'MISSING_REGULAR_HOLIDAY',
            'window_start', v_w,
            'window_end', v_end,
            'message', to_char(v_w, 'YYYY/MM/DD') || '～' || to_char(v_end, 'YYYY/MM/DD') || '：未找到例假'
          ));
        END IF;
        IF v_win_rest < 1 THEN
          v_alerts := v_alerts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'code', 'MISSING_REST_DAY',
            'window_start', v_w,
            'window_end', v_end,
            'message', to_char(v_w, 'YYYY/MM/DD') || '～' || to_char(v_end, 'YYYY/MM/DD') || '：未找到休息日'
          ));
        END IF;
      END IF;
    END IF;
    v_w := v_w + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'work_rule', 'STANDARD_WEEK',
    'user_id', p_user_id,
    'month', v_from,
    'off_days', v_off,
    'rest_day_count', v_rest,
    'regular_holiday_count', v_holiday,
    'national_holiday_count', v_nat,
    'unclassified_off_count', v_unclass,
    'company_month_rest_target', 8,
    'alerts', v_alerts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_upsert_attendance_calendar_day(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_date date;
  v_type text;
  v_name text;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_at' OR p_payload ? 'updated_at' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  BEGIN
    v_date := (p_payload->>'calendar_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'calendar_date required';
  END;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'calendar_date required';
  END IF;
  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'day_type', 'NATIONAL_HOLIDAY')));
  IF v_type IS DISTINCT FROM 'NATIONAL_HOLIDAY' THEN
    RAISE EXCEPTION 'invalid day_type';
  END IF;
  v_name := pg_catalog.btrim(COALESCE(p_payload->>'name', ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'name required';
  END IF;

  INSERT INTO public.attendance_calendar_days (calendar_date, day_type, name, source)
  VALUES (v_date, v_type, v_name, 'MANUAL')
  ON CONFLICT (calendar_date) DO UPDATE
    SET day_type = EXCLUDED.day_type,
        name = EXCLUDED.name,
        source = 'MANUAL';

  RETURN pg_catalog.jsonb_build_object('ok', true, 'calendar_date', v_date, 'day_type', v_type);
END;
$$;

DROP FUNCTION IF EXISTS public.dk_leave_apply_off(uuid, uuid, date, text);
DROP FUNCTION IF EXISTS public.backoffice_approve_leave_request(uuid);

REVOKE ALL ON FUNCTION public.dk_attendance_resolve_schedule(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_leave_apply_off(uuid, uuid, date, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_eval_day(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_approve_leave_request(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_approve_leave_request(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_attendance_schedule_compliance(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_attendance_schedule_compliance(uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_upsert_attendance_calendar_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_attendance_calendar_day(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_attendance_evaluate_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_attendance_evaluate_month(uuid, date) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'col.day_type' AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'day_type'
       ))::text AS actual, 'true' AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'day_type'
       ) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.calendar',
       (to_regclass('public.attendance_calendar_days') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_calendar_days') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'calendar.admin_select_only',
       ((
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_calendar_days' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_calendar_days'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_calendar_days' AND cmd = 'SELECT'
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_calendar_days'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.approve_two_arg',
       (to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.old_approve_dropped',
       (to_regprocedure('public.backoffice_approve_leave_request(uuid)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_approve_leave_request(uuid)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'exec.compliance_authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_attendance_schedule_compliance(uuid,date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_attendance_schedule_compliance(uuid,date)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'exec.anon_compliance_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_attendance_schedule_compliance(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_attendance_schedule_compliance(uuid,date)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'exec.resolve_helper_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_resolve_schedule(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_resolve_schedule(uuid,date)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'eval.has_day_type',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%day_type%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%day_type%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'calendar.write_rpc_admin',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_attendance_calendar_day'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_attendance_calendar_day'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
