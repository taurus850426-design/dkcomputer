-- DK Computer｜Stage 20：員工離職、最後薪資與整日漏打卡
-- 執行位置：Supabase Dashboard → SQL Editor
-- 依賴：Stage 11 attendance、Stage 18 scheduling/compensation/payroll settlement。
-- 可重複執行。此檔不會刪除員工、歷史出勤、請假或薪資快照。

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.attendance_shifts') IS NULL
     OR to_regclass('public.attendance_breaks') IS NULL
     OR to_regclass('public.attendance_audit_logs') IS NULL
     OR to_regclass('public.employee_default_shift_periods') IS NULL
     OR to_regclass('public.employee_compensation_periods') IS NULL
     OR to_regclass('public.employee_schedules') IS NULL
     OR to_regclass('public.attendance_leave_requests') IS NULL
     OR to_regclass('public.payroll_settlements') IS NULL
     OR to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_attendance_shift_snapshot(uuid)') IS NULL
     OR to_regprocedure('public.dk_attendance_write_audit(uuid,uuid,uuid,text,text,jsonb,jsonb,boolean,numeric,numeric)') IS NULL
  THEN
    RAISE EXCEPTION 'Stage 20 blocked: required attendance/payroll objects are missing';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.employee_offboardings (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  employee_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PREPARED',
  separation_type text NOT NULL,
  reason_category text NOT NULL,
  last_work_date date NOT NULL,
  payroll_month date NOT NULL,
  note text NULL,
  final_payroll_settlement_id uuid NULL REFERENCES public.payroll_settlements(id) ON DELETE RESTRICT,
  prepared_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  prepared_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finalized_by uuid NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  finalized_at timestamptz NULL,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT employee_offboardings_status_ck
    CHECK (status IN ('PREPARED', 'FINALIZED')),
  CONSTRAINT employee_offboardings_type_ck
    CHECK (separation_type IN ('VOLUNTARY_RESIGNATION', 'INVOLUNTARY_TERMINATION', 'FIXED_TERM_END', 'OTHER')),
  CONSTRAINT employee_offboardings_reason_ck
    CHECK (reason_category IN ('HEALTH', 'PERSONAL', 'CAREER', 'PERFORMANCE', 'BUSINESS', 'OTHER')),
  CONSTRAINT employee_offboardings_month_ck
    CHECK (payroll_month = pg_catalog.date_trunc('month', last_work_date::timestamp)::date),
  CONSTRAINT employee_offboardings_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 300),
  CONSTRAINT employee_offboardings_finalize_shape_ck
    CHECK (
      (status = 'PREPARED' AND final_payroll_settlement_id IS NULL AND finalized_by IS NULL AND finalized_at IS NULL)
      OR
      (status = 'FINALIZED' AND final_payroll_settlement_id IS NOT NULL AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL)
    ),
  CONSTRAINT employee_offboardings_snapshot_ck
    CHECK (pg_catalog.jsonb_typeof(snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS employee_offboardings_status_idx
  ON public.employee_offboardings (status, last_work_date);

CREATE OR REPLACE FUNCTION public.dk_employee_offboarding_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_employee_offboarding_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employee offboarding cannot be hard deleted';
  END IF;
  IF OLD.status = 'FINALIZED' THEN
    RAISE EXCEPTION 'finalized employee offboarding is immutable';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.last_work_date IS DISTINCT FROM OLD.last_work_date
     OR NEW.separation_type IS DISTINCT FROM OLD.separation_type
     OR NEW.reason_category IS DISTINCT FROM OLD.reason_category
     OR NEW.payroll_month IS DISTINCT FROM OLD.payroll_month
     OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
     OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
     OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
  THEN
    RAISE EXCEPTION 'prepared employee offboarding core fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_offboarding_updated_at ON public.employee_offboardings;
CREATE TRIGGER trg_employee_offboarding_updated_at
  BEFORE UPDATE ON public.employee_offboardings
  FOR EACH ROW EXECUTE PROCEDURE public.dk_employee_offboarding_set_updated_at();

DROP TRIGGER IF EXISTS trg_employee_offboarding_guard ON public.employee_offboardings;
CREATE TRIGGER trg_employee_offboarding_guard
  BEFORE UPDATE OR DELETE ON public.employee_offboardings
  FOR EACH ROW EXECUTE PROCEDURE public.dk_employee_offboarding_guard();

CREATE OR REPLACE FUNCTION public.dk_profiles_guard_finalized_offboarding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.enabled IS FALSE AND NEW.enabled IS TRUE
     AND EXISTS (
       SELECT 1 FROM public.employee_offboardings o
       WHERE o.employee_id = OLD.id AND o.status = 'FINALIZED'
     )
  THEN
    RAISE EXCEPTION 'FINALIZED_EMPLOYEE_CANNOT_BE_REENABLED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_finalized_offboarding ON public.profiles;
CREATE TRIGGER trg_profiles_guard_finalized_offboarding
  BEFORE UPDATE OF enabled ON public.profiles
  FOR EACH ROW EXECUTE PROCEDURE public.dk_profiles_guard_finalized_offboarding();

ALTER TABLE public.employee_offboardings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_offboardings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.employee_offboardings TO authenticated;

DROP POLICY IF EXISTS employee_offboardings_select_admin ON public.employee_offboardings;
CREATE POLICY employee_offboardings_select_admin
  ON public.employee_offboardings
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.backoffice_get_employee_offboarding(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.employee_offboardings%ROWTYPE;
BEGIN
  PERFORM public.dk_schedule_require_admin();
  IF p_employee_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  SELECT * INTO v_row
  FROM public.employee_offboardings o
  WHERE o.employee_id = p_employee_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', true, 'found', false, 'employee_id', p_employee_id);
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'found', true,
    'id', v_row.id,
    'employee_id', v_row.employee_id,
    'status', v_row.status,
    'separation_type', v_row.separation_type,
    'reason_category', v_row.reason_category,
    'last_work_date', v_row.last_work_date,
    'payroll_month', v_row.payroll_month,
    'note', v_row.note,
    'final_payroll_settlement_id', v_row.final_payroll_settlement_id,
    'prepared_by', v_row.prepared_by,
    'prepared_at', v_row.prepared_at,
    'finalized_by', v_row.finalized_by,
    'finalized_at', v_row.finalized_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_prepare_employee_offboarding(
  p_employee_id uuid,
  p_last_work_date date,
  p_separation_type text,
  p_reason_category text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_emp public.profiles%ROWTYPE;
  v_month date;
  v_snapshot jsonb;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_employee_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  IF p_last_work_date IS NULL THEN RAISE EXCEPTION 'last_work_date required'; END IF;
  IF p_separation_type NOT IN ('VOLUNTARY_RESIGNATION', 'INVOLUNTARY_TERMINATION', 'FIXED_TERM_END', 'OTHER') THEN
    RAISE EXCEPTION 'invalid separation_type';
  END IF;
  IF p_reason_category NOT IN ('HEALTH', 'PERSONAL', 'CAREER', 'PERFORMANCE', 'BUSINESS', 'OTHER') THEN
    RAISE EXCEPTION 'invalid reason_category';
  END IF;
  IF p_note IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(p_note)) > 300 THEN
    RAISE EXCEPTION 'offboarding note too long';
  END IF;

  SELECT * INTO v_emp FROM public.profiles p WHERE p.id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'employee not found'; END IF;
  IF v_emp.role IS DISTINCT FROM 'staff' THEN RAISE EXCEPTION 'only staff can be offboarded'; END IF;
  IF v_emp.enabled IS NOT TRUE THEN RAISE EXCEPTION 'employee already disabled'; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_offboardings o WHERE o.employee_id = p_employee_id) THEN
    RAISE EXCEPTION 'OFFBOARDING_ALREADY_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = p_employee_id AND s.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_OPEN_SHIFT_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = p_employee_id
      AND (s.clock_in_at AT TIME ZONE 'Asia/Taipei')::date > p_last_work_date
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_ATTENDANCE_AFTER_LAST_DAY';
  END IF;

  v_month := pg_catalog.date_trunc('month', p_last_work_date::timestamp)::date;
  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.user_id = p_employee_id AND s.payroll_month = v_month
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_PAYROLL_ALREADY_SETTLED';
  END IF;
  -- Future shift/compensation periods are preserved in snapshot_json for audit.
  -- They must not force a false last-work date. Active periods are closed below,
  -- and finalization disables the employee account before a future period can apply.
  IF EXISTS (
    SELECT 1 FROM public.attendance_leave_requests l
    WHERE l.user_id = p_employee_id
      AND l.leave_date > p_last_work_date
      AND l.status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_FUTURE_LEAVE_EXISTS';
  END IF;

  v_snapshot := pg_catalog.jsonb_build_object(
    'profile', pg_catalog.jsonb_build_object(
      'id', v_emp.id, 'username', v_emp.username, 'display_name', v_emp.display_name,
      'role', v_emp.role, 'enabled', v_emp.enabled
    ),
    'default_shift_periods', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.effective_from)
      FROM public.employee_default_shift_periods d WHERE d.user_id = p_employee_id
    ), '[]'::jsonb),
    'compensation_periods', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.effective_from)
      FROM public.employee_compensation_periods c WHERE c.user_id = p_employee_id
    ), '[]'::jsonb),
    'removed_future_schedules', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.work_date)
      FROM public.employee_schedules s
      WHERE s.user_id = p_employee_id AND s.work_date > p_last_work_date
    ), '[]'::jsonb)
  );

  UPDATE public.employee_default_shift_periods
  SET effective_to = p_last_work_date, updated_by = v_uid
  WHERE user_id = p_employee_id
    AND effective_from <= p_last_work_date
    AND (effective_to IS NULL OR effective_to > p_last_work_date);

  UPDATE public.employee_compensation_periods
  SET effective_to = p_last_work_date, updated_by = v_uid
  WHERE user_id = p_employee_id
    AND effective_from <= p_last_work_date
    AND (effective_to IS NULL OR effective_to > p_last_work_date);

  DELETE FROM public.employee_schedules
  WHERE user_id = p_employee_id AND work_date > p_last_work_date;

  INSERT INTO public.employee_offboardings (
    employee_id, status, separation_type, reason_category, last_work_date,
    payroll_month, note, prepared_by, snapshot_json
  ) VALUES (
    p_employee_id, 'PREPARED', p_separation_type, p_reason_category, p_last_work_date,
    v_month, NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), ''), v_uid, v_snapshot
  ) RETURNING id INTO v_id;

  RETURN public.backoffice_get_employee_offboarding(p_employee_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_finalize_employee_offboarding(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.employee_offboardings%ROWTYPE;
  v_settlement uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_employee_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  SELECT * INTO v_row
  FROM public.employee_offboardings o
  WHERE o.employee_id = p_employee_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OFFBOARDING_NOT_PREPARED'; END IF;
  IF v_row.status = 'FINALIZED' THEN RAISE EXCEPTION 'OFFBOARDING_ALREADY_FINALIZED'; END IF;
  IF v_row.last_work_date > (pg_catalog.now() AT TIME ZONE 'Asia/Taipei')::date THEN
    RAISE EXCEPTION 'OFFBOARDING_LAST_DAY_IN_FUTURE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = p_employee_id AND s.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_OPEN_SHIFT_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = p_employee_id
      AND (s.clock_in_at AT TIME ZONE 'Asia/Taipei')::date > v_row.last_work_date
  ) THEN
    RAISE EXCEPTION 'OFFBOARDING_ATTENDANCE_AFTER_LAST_DAY';
  END IF;
  SELECT s.id INTO v_settlement
  FROM public.payroll_settlements s
  WHERE s.user_id = p_employee_id AND s.payroll_month = v_row.payroll_month;
  IF v_settlement IS NULL THEN RAISE EXCEPTION 'OFFBOARDING_PAYROLL_NOT_SETTLED'; END IF;

  UPDATE public.profiles SET enabled = false WHERE id = p_employee_id AND role = 'staff';
  IF NOT FOUND THEN RAISE EXCEPTION 'employee not found'; END IF;

  UPDATE public.employee_offboardings
  SET status = 'FINALIZED', final_payroll_settlement_id = v_settlement,
      finalized_by = v_uid, finalized_at = pg_catalog.now()
  WHERE id = v_row.id;

  RETURN public.backoffice_get_employee_offboarding(p_employee_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_admin_add_shift(
  p_employee_id uuid,
  p_clock_in_at timestamptz,
  p_clock_out_at timestamptz,
  p_reason text,
  p_manager_confirmed boolean,
  p_break_start_at timestamptz DEFAULT NULL,
  p_break_end_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_role text;
  v_enabled boolean;
  v_shift_id uuid;
  v_work_date date;
  v_after jsonb;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_employee_id IS NULL THEN RAISE EXCEPTION 'user_id required'; END IF;
  IF p_clock_in_at IS NULL OR p_clock_out_at IS NULL THEN RAISE EXCEPTION 'clock times required'; END IF;
  IF p_clock_out_at <= p_clock_in_at OR p_clock_out_at > p_clock_in_at + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid clock range';
  END IF;
  IF p_clock_out_at > pg_catalog.now() THEN RAISE EXCEPTION 'manual shift cannot be future'; END IF;
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  IF p_manager_confirmed IS NOT TRUE THEN RAISE EXCEPTION 'manager confirmation required'; END IF;
  IF pg_catalog.length(pg_catalog.btrim(p_reason)) > 200 THEN RAISE EXCEPTION 'reason too long'; END IF;
  IF (p_break_start_at IS NULL) <> (p_break_end_at IS NULL) THEN
    RAISE EXCEPTION 'both break times required';
  END IF;
  IF p_break_start_at IS NOT NULL AND (
    p_break_end_at <= p_break_start_at OR p_break_start_at < p_clock_in_at OR p_break_end_at > p_clock_out_at
  ) THEN
    RAISE EXCEPTION 'invalid break range';
  END IF;

  SELECT p.role, p.enabled INTO v_role, v_enabled
  FROM public.profiles p WHERE p.id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'employee not found'; END IF;
  IF v_role IS DISTINCT FROM 'staff' THEN RAISE EXCEPTION 'manual shift staff only'; END IF;
  v_work_date := (p_clock_in_at AT TIME ZONE 'Asia/Taipei')::date;
  IF EXISTS (
    SELECT 1 FROM public.employee_offboardings o
    WHERE o.employee_id = p_employee_id AND v_work_date > o.last_work_date
  ) THEN
    RAISE EXCEPTION 'manual shift after last work date';
  END IF;
  IF v_enabled IS NOT TRUE AND NOT EXISTS (
    SELECT 1 FROM public.employee_offboardings o
    WHERE o.employee_id = p_employee_id AND o.status = 'FINALIZED' AND v_work_date <= o.last_work_date
  ) THEN
    RAISE EXCEPTION 'employee disabled or not a backoffice user';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.user_id = p_employee_id
      AND s.payroll_month = pg_catalog.date_trunc('month', v_work_date::timestamp)::date
  ) THEN
    RAISE EXCEPTION 'PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = p_employee_id
      AND s.clock_in_at < p_clock_out_at
      AND COALESCE(s.clock_out_at, 'infinity'::timestamptz) > p_clock_in_at
  ) THEN
    RAISE EXCEPTION 'ATTENDANCE_SHIFT_OVERLAP';
  END IF;

  INSERT INTO public.attendance_shifts (
    employee_id, clock_in_at, clock_out_at, status, source, created_by, updated_by, extra
  ) VALUES (
    p_employee_id, p_clock_in_at, p_clock_out_at, 'closed', 'admin_correction', v_uid, v_uid,
    pg_catalog.jsonb_build_object('manual_add', true, 'manager_confirmed', true)
  ) RETURNING id INTO v_shift_id;

  IF p_break_start_at IS NOT NULL THEN
    INSERT INTO public.attendance_breaks (
      shift_id, employee_id, break_start_at, break_end_at, extra
    ) VALUES (
      v_shift_id, p_employee_id, p_break_start_at, p_break_end_at,
      pg_catalog.jsonb_build_object('manual_add', true, 'manager_confirmed', true)
    );
  END IF;

  v_after := public.dk_attendance_shift_snapshot(v_shift_id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, p_employee_id, v_shift_id, 'ADMIN_CORRECTION', pg_catalog.btrim(p_reason), NULL, v_after
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_shift_id, 'status', 'closed');
END;
$$;

REVOKE ALL ON FUNCTION public.dk_employee_offboarding_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_offboarding_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_profiles_guard_finalized_offboarding() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_get_employee_offboarding(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_prepare_employee_offboarding(uuid,date,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_finalize_employee_offboarding(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attendance_admin_add_shift(uuid,timestamptz,timestamptz,text,boolean,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backoffice_get_employee_offboarding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_prepare_employee_offboarding(uuid,date,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_finalize_employee_offboarding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_admin_add_shift(uuid,timestamptz,timestamptz,text,boolean,timestamptz,timestamptz) TO authenticated;

COMMIT;

-- 驗證：下列查詢應全部為 true / t。
SELECT
  to_regclass('public.employee_offboardings') IS NOT NULL AS table_ready,
  to_regprocedure('public.backoffice_prepare_employee_offboarding(uuid,date,text,text,text)') IS NOT NULL AS prepare_ready,
  to_regprocedure('public.backoffice_finalize_employee_offboarding(uuid)') IS NOT NULL AS finalize_ready,
  to_regprocedure('public.attendance_admin_add_shift(uuid,timestamptz,timestamptz,text,boolean,timestamptz,timestamptz)') IS NOT NULL AS manual_shift_ready,
  pg_catalog.pg_get_functiondef(
    to_regprocedure('public.backoffice_prepare_employee_offboarding(uuid,date,text,text,text)')
  ) NOT LIKE '%OFFBOARDING_FUTURE_PERIOD_EXISTS%' AS future_period_fix_ready;
