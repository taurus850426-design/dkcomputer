-- ============================================================
-- DK Computer｜Stage 18-3 員工排休申請 + Admin 核准／直接排休
-- V1：REST_DAY only。不做病假／事假／特休薪資、月休 8 天、Payroll。
-- 核准後寫入 employee_schedules OFF，蓋過 default shift；不改 default period。
-- WORK ↔ OFF 不得靜默覆蓋 → SCHEDULE_CONFLICT。
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
UNION ALL SELECT 2, 'helper.dk_attendance_taiwan_today',
       (to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'helper.dk_attendance_set_updated_at',
       (to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'helper.dk_schedule_require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'helper.dk_schedule_require_enabled_employee',
       (to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.dk_require_backoffice',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
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
    RAISE EXCEPTION 'M0_SCHEMA blocked: employee_schedules missing. Run Stage 18 scheduling first.';
  END IF;
  IF to_regprocedure('public.dk_attendance_set_updated_at()') IS NULL
     OR to_regprocedure('public.dk_attendance_taiwan_today()') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: attendance date/updated_at helpers missing.';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.attendance_leave_requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  leave_date date NOT NULL,
  leave_type text NOT NULL,
  status text NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  approved_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz NULL,
  rejected_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  rejected_at timestamptz NULL,
  cancelled_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at timestamptz NULL,
  CONSTRAINT attendance_leave_requests_type_ck
    CHECK (leave_type IN (
      'REST_DAY', 'REGULAR_LEAVE', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'PERSONAL_LEAVE', 'PUBLIC_HOLIDAY'
    )),
  CONSTRAINT attendance_leave_requests_status_ck
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT attendance_leave_requests_reason_ck
    CHECK (reason IS NULL OR pg_catalog.length(reason) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_leave_requests_active_uidx
  ON public.attendance_leave_requests (user_id, leave_date)
  WHERE status IN ('PENDING', 'APPROVED');

CREATE INDEX IF NOT EXISTS attendance_leave_requests_user_date_idx
  ON public.attendance_leave_requests (user_id, leave_date);

CREATE INDEX IF NOT EXISTS attendance_leave_requests_status_idx
  ON public.attendance_leave_requests (status, leave_date);

COMMENT ON TABLE public.attendance_leave_requests IS
  'Stage 18-3 leave requests. V1 writes REST_DAY only. APPROVED materializes employee_schedules OFF.';

CREATE OR REPLACE FUNCTION public.dk_attendance_leave_requests_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'attendance_leave_requests cannot be hard deleted';
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_leave_requests_forbid_delete ON public.attendance_leave_requests;
CREATE TRIGGER trg_attendance_leave_requests_forbid_delete
  BEFORE DELETE ON public.attendance_leave_requests
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_leave_requests_forbid_delete();

DROP TRIGGER IF EXISTS trg_attendance_leave_requests_set_updated_at ON public.attendance_leave_requests;
CREATE TRIGGER trg_attendance_leave_requests_set_updated_at
  BEFORE UPDATE ON public.attendance_leave_requests
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

CREATE OR REPLACE FUNCTION public.dk_employee_schedules_forbid_type_switch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.schedule_type IS DISTINCT FROM NEW.schedule_type THEN
    RAISE EXCEPTION 'SCHEDULE_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_schedules_forbid_type_switch ON public.employee_schedules;
CREATE TRIGGER trg_employee_schedules_forbid_type_switch
  BEFORE UPDATE ON public.employee_schedules
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_schedules_forbid_type_switch();

ALTER TABLE public.attendance_leave_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_leave_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_leave_requests_forbid_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_schedules_forbid_type_switch() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_leave_requests') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: attendance_leave_requests missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

ALTER TABLE public.attendance_leave_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_leave_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.attendance_leave_requests TO authenticated;

DROP POLICY IF EXISTS attendance_leave_requests_select_own ON public.attendance_leave_requests;
DROP POLICY IF EXISTS attendance_leave_requests_select_admin ON public.attendance_leave_requests;
CREATE POLICY attendance_leave_requests_select_own
  ON public.attendance_leave_requests
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.is_enabled_backoffice_user()
  );
CREATE POLICY attendance_leave_requests_select_admin
  ON public.attendance_leave_requests
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
  IF to_regclass('public.attendance_leave_requests') IS NULL
     OR to_regclass('public.employee_schedules') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: leave/schedule tables missing.';
  END IF;
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NULL
     OR to_regprocedure('public.dk_attendance_taiwan_today()') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18 helpers missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_leave_apply_off(
  p_actor uuid,
  p_user uuid,
  p_date date,
  p_leave text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.employee_schedules%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_actor IS NULL OR p_user IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'leave apply arguments required';
  END IF;
  IF p_leave IS DISTINCT FROM 'REST_DAY' THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  SELECT * INTO v_row
  FROM public.employee_schedules s
  WHERE s.user_id = p_user AND s.work_date = p_date
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_CONFLICT';
  END IF;

  INSERT INTO public.employee_schedules (
    user_id, work_date, shift_template_id, schedule_type, leave_type, note,
    shift_name_snapshot, scheduled_start_time, scheduled_end_time,
    scheduled_break_minutes, scheduled_cross_midnight,
    scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
    created_by, updated_by
  ) VALUES (
    p_user, p_date, NULL, 'OFF', p_leave, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    p_actor, p_actor
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_leave_apply_off(uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_request_leave(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_date date;
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
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
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

  IF p_payload ? 'leave_type' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', ''))) IS DISTINCT FROM 'REST_DAY' THEN
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
    user_id, leave_date, leave_type, status, reason
  ) VALUES (
    v_uid, v_date, 'REST_DAY', 'PENDING', v_reason
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'status', 'PENDING');
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_cancel_leave_request(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.attendance_leave_requests%ROWTYPE;
BEGIN
  PERFORM public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
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
  IF v_row.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'cannot cancel another employee leave';
  END IF;
  IF v_row.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'only PENDING leave can be cancelled by staff';
  END IF;

  UPDATE public.attendance_leave_requests
  SET status = 'CANCELLED',
      cancelled_by = v_uid,
      cancelled_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'CANCELLED');
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_approve_leave_request(p_id uuid)
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
  v_sched := public.dk_leave_apply_off(v_uid, v_row.user_id, v_row.leave_date, 'REST_DAY');

  UPDATE public.attendance_leave_requests
  SET status = 'APPROVED',
      approved_by = v_uid,
      approved_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', p_id, 'status', 'APPROVED', 'schedule_id', v_sched
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_reject_leave_request(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.attendance_leave_requests%ROWTYPE;
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

  UPDATE public.attendance_leave_requests
  SET status = 'REJECTED',
      rejected_by = v_uid,
      rejected_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'REJECTED');
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

  SELECT * INTO v_sched
  FROM public.employee_schedules s
  WHERE s.user_id = v_row.user_id AND s.work_date = v_row.leave_date
  FOR UPDATE;
  IF FOUND THEN
    IF v_sched.schedule_type IS DISTINCT FROM 'OFF' THEN
      RAISE EXCEPTION 'SCHEDULE_CONFLICT';
    END IF;
    DELETE FROM public.employee_schedules WHERE id = v_sched.id;
  END IF;

  UPDATE public.attendance_leave_requests
  SET status = 'CANCELLED',
      cancelled_by = v_uid,
      cancelled_at = pg_catalog.now()
  WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'CANCELLED');
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

  IF EXISTS (
    SELECT 1 FROM public.attendance_leave_requests r
    WHERE r.user_id = v_user AND r.leave_date = v_date
      AND r.status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'duplicate leave request';
  END IF;

  v_sched := public.dk_leave_apply_off(v_uid, v_user, v_date, 'REST_DAY');

  INSERT INTO public.attendance_leave_requests (
    user_id, leave_date, leave_type, status,
    approved_by, approved_at
  ) VALUES (
    v_user, v_date, 'REST_DAY', 'APPROVED',
    v_uid, pg_catalog.now()
  )
  RETURNING id INTO v_req;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', v_req, 'status', 'APPROVED', 'schedule_id', v_sched
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_request_leave(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_request_leave(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_cancel_leave_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_cancel_leave_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_approve_leave_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_approve_leave_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_reject_leave_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_reject_leave_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_revoke_leave_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_revoke_leave_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_rest_day(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_leave_requests' AS check_name,
       (to_regclass('public.attendance_leave_requests') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_leave_requests') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rls.enabled',
       (COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_leave_requests'), false))::text, 'true',
       CASE WHEN COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_leave_requests'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'grant.anon_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee IN ('PUBLIC','anon')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee IN ('PUBLIC','anon')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'grant.authenticated_write_none',
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
UNION ALL SELECT 5, 'grant.authenticated_select',
       (EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'policy.write_none',
       (NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_leave_requests'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_leave_requests'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rpc.request',
       (to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'rpc.approve_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'exec.request_authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'exec.helper_apply_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_leave_apply_off(uuid,uuid,date,text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_leave_apply_off(uuid,uuid,date,text)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'index.active_unique',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'attendance_leave_requests'
           AND indexname = 'attendance_leave_requests_active_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'attendance_leave_requests'
           AND indexname = 'attendance_leave_requests_active_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'rpc.approve_writes_off',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_leave_apply_off%'
            AND pg_get_functiondef(p.oid) ILIKE '%APPROVED%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_leave_apply_off%'
            AND pg_get_functiondef(p.oid) ILIKE '%APPROVED%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_approve_leave_request'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
