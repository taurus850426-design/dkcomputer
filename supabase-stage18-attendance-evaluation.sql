-- ============================================================
-- DK Computer｜Stage 18-4 出勤狀態判定（唯讀）
-- 整合成：employee_schedules > default shift period > NO_SCHEDULE
--        + 實際 attendance_shifts / attendance_breaks
-- 不做薪資、加班費、假別扣款、Payroll。不寫回 punch 資料。
-- 遲到／早退分鐘 = 相對預定時刻的實際分鐘；grace 只決定是否標記 LATE / EARLY_LEAVE。
--
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- 每一 SECTION 請單獨複製執行（含 /* */ 內全文）。
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
UNION ALL SELECT 3, 'table.attendance_shifts',
       (to_regclass('public.attendance_shifts') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_shifts') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.attendance_breaks',
       (to_regclass('public.attendance_breaks') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_breaks') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'helper.dk_schedule_require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.dk_attendance_taiwan_today',
       (to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

-- NONE
-- 本 Stage 不新增 table / column。判定結果不落地，每次 RPC 即時計算。

SELECT 'M0_SCHEMA' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

-- NONE
-- 無新 table。讀取走 SECURITY DEFINER RPC；不開放 client 寫判定結果。

SELECT 'M1_RLS' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_schedules') IS NULL
     OR to_regclass('public.employee_default_shift_periods') IS NULL
     OR to_regclass('public.attendance_shifts') IS NULL
     OR to_regclass('public.attendance_breaks') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: schedule/attendance tables missing.';
  END IF;
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: dk_schedule_require_admin missing.';
  END IF;
END
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
  v_source text := 'NONE';
  v_type text := NULL;
  v_leave text := NULL;
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

  SELECT * INTO v_sched
  FROM public.employee_schedules s
  WHERE s.user_id = p_user_id AND s.work_date = p_date;
  IF FOUND THEN
    v_source := 'EXCEPTION';
    v_type := v_sched.schedule_type;
    v_leave := v_sched.leave_type;
    v_name := v_sched.shift_name_snapshot;
    v_start := v_sched.scheduled_start_time;
    v_end := v_sched.scheduled_end_time;
    v_cross := COALESCE(v_sched.scheduled_cross_midnight, false);
    v_late_grace := COALESCE(v_sched.scheduled_late_grace_minutes, 0);
    v_early_grace := COALESCE(v_sched.scheduled_early_leave_grace_minutes, 0);
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

CREATE OR REPLACE FUNCTION public.backoffice_attendance_evaluate_month(p_user_id uuid, p_month date)
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
  v_days jsonb := '[]'::jsonb;
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
  v_d := v_from;
  WHILE v_d <= v_to LOOP
    v_days := v_days || pg_catalog.jsonb_build_array(public.dk_attendance_eval_day(p_user_id, v_d));
    v_d := v_d + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'month', v_from,
    'days', v_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_attendance_eval_day(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_attendance_evaluate_month(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_attendance_evaluate_month(uuid, date) TO authenticated;

COMMENT ON FUNCTION public.dk_attendance_eval_day(uuid, date) IS
  'Stage 18-4 internal day evaluator. late_minutes = actual minutes after scheduled_start; grace only gates LATE.';
COMMENT ON FUNCTION public.backoffice_attendance_evaluate_month(uuid, date) IS
  'Stage 18-4 Admin-only live monthly evaluation. Read-only; does not write attendance_shifts.';

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'rpc.evaluate_month' AS check_name,
       (to_regprocedure('public.backoffice_attendance_evaluate_month(uuid,date)') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regprocedure('public.backoffice_attendance_evaluate_month(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.evaluate_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'exec.evaluate_authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_attendance_evaluate_month(uuid,date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_attendance_evaluate_month(uuid,date)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_attendance_evaluate_month(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_attendance_evaluate_month(uuid,date)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'exec.helper_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_eval_day(uuid,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_eval_day(uuid,date)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'rpc.admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rpc.no_shift_writes',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_attendance_evaluate_month'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.has_status_set',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%NO_SCHEDULE%'
            AND pg_get_functiondef(p.oid) ILIKE '%ABSENT%'
            AND pg_get_functiondef(p.oid) ILIKE '%LATE_AND_EARLY%'
            AND pg_get_functiondef(p.oid) ILIKE '%potential_overtime_minutes%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%NO_SCHEDULE%'
            AND pg_get_functiondef(p.oid) ILIKE '%ABSENT%'
            AND pg_get_functiondef(p.oid) ILIKE '%LATE_AND_EARLY%'
            AND pg_get_functiondef(p.oid) ILIKE '%potential_overtime_minutes%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
