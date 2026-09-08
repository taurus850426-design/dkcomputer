-- ============================================================
-- DK Computer｜Stage 18-7 請假種類 + 工作日 Leave Overlay
-- REST_DAY 仍物化為 employee_schedules OFF。
-- SICK/PERSONAL/ANNUAL 不改班表，只掛在 WORKDAY 上。
-- 不做薪資金額、特休額度、半天／小時假。
--
-- 必須在以下之後執行：
--   leave-requests → attendance-evaluation → day-classification
--
-- PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_leave_requests' AS check_name,
       (to_regclass('public.attendance_leave_requests') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_leave_requests') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.request_leave',
       (to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.approve_leave_daytype',
       (to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.resolve_schedule',
       (to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.eval_day',
       (to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_leave_requests') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: attendance_leave_requests missing. Run leave-requests first.';
  END IF;
END
$$;

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS leave_unit text NOT NULL DEFAULT 'FULL_DAY';

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_unit_ck;
ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_unit_ck
  CHECK (leave_unit IN ('FULL_DAY', 'HOURS'));

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_type_ck;
ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_type_ck
  CHECK (leave_type IN (
    'REST_DAY', 'SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE',
    'REGULAR_LEAVE', 'PUBLIC_HOLIDAY'
  ));

COMMENT ON COLUMN public.attendance_leave_requests.leave_unit IS
  'V1 writes FULL_DAY only. HOURS reserved; not used by UI.';
COMMENT ON TABLE public.attendance_leave_requests IS
  'Leave requests. REST_DAY may materialize OFF. SICK/PERSONAL/ANNUAL are WORKDAY overlays only.';

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

-- NONE：沿用 Stage 18-3 leave request RLS。不新增 table write GRANT。

SELECT 'M1_RLS' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_leave_apply_off(uuid,uuid,date,text,text)') IS NULL
     OR to_regprocedure('public.backoffice_approve_leave_request(uuid,text)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: run day-classification first.';
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
  v_sched_leave text := NULL;
  v_day text := NULL;
  v_work boolean := false;
  v_overlay text := NULL;
  v_overlay_status text := NULL;
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
    v_sched_leave := v_sched.leave_type;
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

  SELECT r.leave_type, r.status
    INTO v_overlay, v_overlay_status
  FROM public.attendance_leave_requests r
  WHERE r.user_id = p_user_id
    AND r.leave_date = p_date
    AND r.status = 'APPROVED'
    AND r.leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE')
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'schedule_source', v_source,
    'schedule_type', v_type,
    'leave_type', CASE WHEN v_overlay IS NOT NULL THEN v_overlay ELSE v_sched_leave END,
    'leave_status', v_overlay_status,
    'day_type', v_day,
    'scheduled_work', v_work,
    'overlay_leave_type', v_overlay,
    'overlay_leave_status', v_overlay_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_request_leave(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_date date;
  v_type text;
  v_reason text;
  v_id uuid;
BEGIN
  PERFORM public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'user_id' AND NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'user_id', '')), '') IS DISTINCT FROM v_uid::text THEN
    RAISE EXCEPTION 'cannot request leave for another employee';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'approved_by' OR p_payload ? 'approved_at'
     OR p_payload ? 'rejected_by' OR p_payload ? 'rejected_at'
     OR p_payload ? 'cancelled_by' OR p_payload ? 'cancelled_at'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'day_type' OR p_payload ? 'schedule_type'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'leave_unit' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_unit', ''))) IS DISTINCT FROM 'FULL_DAY' THEN
    RAISE EXCEPTION 'invalid leave_unit';
  END IF;

  BEGIN
    v_date := (p_payload->>'leave_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'leave_date required';
  END;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'leave_date required';
  END IF;
  IF v_date <= public.dk_attendance_taiwan_today() THEN
    RAISE EXCEPTION 'leave_date must be after today';
  END IF;

  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', 'REST_DAY')));
  IF v_type NOT IN ('REST_DAY', 'SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE') THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'reason', '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 200 THEN
    RAISE EXCEPTION 'reason too long';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_leave_requests r
    WHERE r.user_id = v_uid AND r.leave_date = v_date
      AND r.status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'duplicate leave request';
  END IF;

  INSERT INTO public.attendance_leave_requests (
    user_id, leave_date, leave_type, leave_unit, status, reason
  ) VALUES (
    v_uid, v_date, v_type, 'FULL_DAY', 'PENDING', v_reason
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'status', 'PENDING', 'leave_type', v_type);
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
  v_resolved jsonb;
  v_type text;
  v_day text;
  v_work boolean;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id required';
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
  v_resolved := public.dk_attendance_resolve_schedule(v_row.user_id, v_row.leave_date);
  v_type := NULLIF(v_resolved->>'schedule_type', '');
  v_day := NULLIF(v_resolved->>'day_type', '');
  v_work := COALESCE((v_resolved->>'scheduled_work')::boolean, false);

  IF v_row.leave_type = 'REST_DAY' THEN
    IF EXISTS (
      SELECT 1 FROM public.attendance_leave_requests x
      WHERE x.user_id = v_row.user_id AND x.leave_date = v_row.leave_date
        AND x.id IS DISTINCT FROM v_row.id
        AND x.status = 'APPROVED'
        AND x.leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE')
    ) THEN
      RAISE EXCEPTION 'LEAVE_CONFLICT';
    END IF;
    IF pg_catalog.btrim(COALESCE(p_day_type, '')) = '' THEN
      RAISE EXCEPTION 'day_type required';
    END IF;
    v_sched := public.dk_leave_apply_off(v_uid, v_row.user_id, v_row.leave_date, 'REST_DAY', p_day_type);
  ELSIF v_row.leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE') THEN
    IF pg_catalog.btrim(COALESCE(p_day_type, '')) <> '' THEN
      RAISE EXCEPTION 'invalid day_type';
    END IF;
    IF v_type = 'OFF' OR v_day IN ('REST_DAY', 'REGULAR_HOLIDAY', 'NATIONAL_HOLIDAY')
       OR v_work IS NOT TRUE OR v_day IS DISTINCT FROM 'WORKDAY'
    THEN
      RAISE EXCEPTION 'LEAVE_REQUIRES_SCHEDULED_WORKDAY';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.attendance_leave_requests x
      WHERE x.user_id = v_row.user_id AND x.leave_date = v_row.leave_date
        AND x.id IS DISTINCT FROM v_row.id
        AND x.status = 'APPROVED'
        AND x.leave_type = 'REST_DAY'
    ) THEN
      RAISE EXCEPTION 'LEAVE_CONFLICT';
    END IF;
    v_sched := NULL;
  ELSE
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  UPDATE public.attendance_leave_requests
  SET status = 'APPROVED',
      approved_by = v_uid,
      approved_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_id,
    'status', 'APPROVED',
    'leave_type', v_row.leave_type,
    'schedule_id', v_sched
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
      AND r.status = 'APPROVED'
      AND r.leave_type IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE')
  ) THEN
    RAISE EXCEPTION 'LEAVE_CONFLICT';
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
    user_id, leave_date, leave_type, leave_unit, status,
    approved_by, approved_at
  ) VALUES (
    v_user, v_date, 'REST_DAY', 'FULL_DAY', 'APPROVED',
    v_uid, pg_catalog.now()
  )
  RETURNING id INTO v_req;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', v_req, 'status', 'APPROVED', 'schedule_id', v_sched, 'day_type', v_day
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_revoke_leave_request(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.attendance_leave_requests%ROWTYPE;
  v_sched public.employee_schedules%ROWTYPE;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id required';
  END IF;

  SELECT * INTO v_row
  FROM public.attendance_leave_requests r
  WHERE r.id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'leave request not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'only APPROVED leave can be revoked';
  END IF;
  IF v_row.leave_date <= public.dk_attendance_taiwan_today() THEN
    RAISE EXCEPTION 'today or past schedule is frozen';
  END IF;

  IF v_row.leave_type = 'REST_DAY' THEN
    SELECT * INTO v_sched
    FROM public.employee_schedules s
    WHERE s.user_id = v_row.user_id AND s.work_date = v_row.leave_date
    FOR UPDATE;
    IF FOUND THEN
      IF v_sched.schedule_type IS DISTINCT FROM 'OFF' THEN
        RAISE EXCEPTION 'LEAVE_CONFLICT';
      END IF;
      DELETE FROM public.employee_schedules WHERE id = v_sched.id;
    END IF;
  ELSE
    SELECT * INTO v_sched
    FROM public.employee_schedules s
    WHERE s.user_id = v_row.user_id AND s.work_date = v_row.leave_date
    FOR UPDATE;
    IF FOUND AND v_sched.schedule_type = 'OFF' THEN
      RAISE EXCEPTION 'LEAVE_CONFLICT';
    END IF;
  END IF;

  UPDATE public.attendance_leave_requests
  SET status = 'CANCELLED',
      cancelled_by = v_uid,
      cancelled_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'CANCELLED');
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
  v_day text := NULL;
  v_overlay text := NULL;
  v_overlay_status text := NULL;
  v_anomaly text := NULL;
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
  v_day := NULLIF(v_resolved->>'day_type', '');
  v_overlay := NULLIF(v_resolved->>'overlay_leave_type', '');
  v_overlay_status := NULLIF(v_resolved->>'overlay_leave_status', '');
  IF v_type IS DISTINCT FROM 'WORK' THEN
    v_overlay := NULL;
    v_overlay_status := NULL;
  END IF;

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
  ELSIF v_overlay IS NOT NULL AND v_first_in IS NULL THEN
    v_status := 'LEAVE';
  ELSE
    v_sched_start := ((p_date::timestamp + v_start) AT TIME ZONE 'Asia/Taipei');
    v_sched_end := ((p_date::timestamp + v_end) AT TIME ZONE 'Asia/Taipei');
    IF v_cross THEN
      v_sched_end := v_sched_end + interval '1 day';
    END IF;
    IF v_first_in IS NULL THEN
      v_status := 'ABSENT';
    ELSE
      IF v_overlay IS NOT NULL THEN
        v_anomaly := 'LEAVE_WITH_ATTENDANCE';
      END IF;
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
    'leave_type', v_overlay,
    'leave_status', v_overlay_status,
    'day_type', v_day,
    'anomaly', v_anomaly,
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

REVOKE ALL ON FUNCTION public.dk_attendance_resolve_schedule(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_eval_day(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_request_leave(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_request_leave(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_approve_leave_request(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_approve_leave_request(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_revoke_leave_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_revoke_leave_request(uuid) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'col.leave_unit' AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ))::text AS actual, 'true' AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.request_allows_sick',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%SICK_LEAVE%'
            AND pg_get_functiondef(p.oid) ILIKE '%FULL_DAY%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_request_leave'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%SICK_LEAVE%'
            AND pg_get_functiondef(p.oid) ILIKE '%FULL_DAY%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_request_leave'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.approve_workday_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%LEAVE_REQUIRES_SCHEDULED_WORKDAY%'
            AND pg_get_functiondef(p.oid) ILIKE '%LEAVE_CONFLICT%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.employee_schedules%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%LEAVE_REQUIRES_SCHEDULED_WORKDAY%'
            AND pg_get_functiondef(p.oid) ILIKE '%LEAVE_CONFLICT%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%INSERT INTO public.employee_schedules%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'eval.leave_status',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%LEAVE_WITH_ATTENDANCE%'
            AND pg_get_functiondef(p.oid) ILIKE '%overlay_leave_type%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%LEAVE_WITH_ATTENDANCE%'
            AND pg_get_functiondef(p.oid) ILIKE '%overlay_leave_type%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_eval_day'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'grant.request_authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'exec.anon_request_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'no_table_write_grant',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
