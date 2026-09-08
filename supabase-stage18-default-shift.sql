-- ============================================================
-- DK Computer｜Stage 18 員工預設班別
-- 目標：Admin 設定一次員工平常上班班別；employee_schedules 改為單日例外。
-- 不做：OFF／休假、遲到早退、加班、薪資、Payroll、clock/GPS/Network。
--
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- 每一 SECTION 請單獨複製執行（含 /* */ 內全文）。
-- 本檔不執行 Production；由使用者手動執行。
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。不 CREATE / ALTER / GRANT。
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_shift_templates' AS check_name,
       (to_regclass('public.attendance_shift_templates') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_shift_templates') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.employee_schedules',
       (to_regclass('public.employee_schedules') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_schedules') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'helper.dk_attendance_taiwan_today',
       (to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'helper.dk_attendance_set_updated_at',
       (to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'helper.dk_schedule_require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.dk_schedule_require_enabled_employee',
       (to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.is_enabled_backoffice_user',
       (to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- 新表 employee_default_shift_periods + overlap / forbid-delete triggers。
-- 請複製本 SECTION（從下一行到 M0_SCHEMA END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_shift_templates') IS NULL
     OR to_regclass('public.employee_schedules') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: Stage 18 scheduling tables missing.';
  END IF;
  IF to_regprocedure('public.dk_attendance_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: dk_attendance_set_updated_at missing.';
  END IF;
  IF to_regprocedure('public.dk_attendance_taiwan_today()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: dk_attendance_taiwan_today missing.';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.employee_default_shift_periods (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  shift_template_id uuid NOT NULL REFERENCES public.attendance_shift_templates(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  effective_to date NULL,
  shift_name_snapshot text NOT NULL,
  scheduled_start_time time NOT NULL,
  scheduled_end_time time NOT NULL,
  scheduled_break_minutes integer NOT NULL,
  scheduled_cross_midnight boolean NOT NULL,
  scheduled_late_grace_minutes integer NOT NULL,
  scheduled_early_leave_grace_minutes integer NOT NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT employee_default_shift_periods_range_ck
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employee_default_shift_periods_name_ck
    CHECK (pg_catalog.length(pg_catalog.btrim(shift_name_snapshot)) >= 1),
  CONSTRAINT employee_default_shift_periods_break_ck
    CHECK (scheduled_break_minutes >= 0 AND scheduled_break_minutes <= 480),
  CONSTRAINT employee_default_shift_periods_late_ck
    CHECK (scheduled_late_grace_minutes >= 0 AND scheduled_late_grace_minutes <= 180),
  CONSTRAINT employee_default_shift_periods_early_ck
    CHECK (scheduled_early_leave_grace_minutes >= 0 AND scheduled_early_leave_grace_minutes <= 180)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_default_shift_periods_open_uidx
  ON public.employee_default_shift_periods (user_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS employee_default_shift_periods_user_from_idx
  ON public.employee_default_shift_periods (user_id, effective_from);

COMMENT ON TABLE public.employee_default_shift_periods IS
  'Stage 18 default WORK shift by period. Snapshot copied from template. employee_schedules is same-day exception.';
COMMENT ON COLUMN public.employee_default_shift_periods.effective_from IS
  'Inclusive Asia/Taipei business date. Client-supplied; not CURRENT_DATE.';
COMMENT ON COLUMN public.employee_default_shift_periods.effective_to IS
  'Inclusive end date. NULL = open-ended current period.';

CREATE OR REPLACE FUNCTION public.dk_employee_default_shift_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.employee_default_shift_periods x
    WHERE x.user_id = NEW.user_id
      AND x.id IS DISTINCT FROM NEW.id
      AND daterange(x.effective_from, COALESCE(x.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'default shift period overlap';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_default_shift_no_overlap ON public.employee_default_shift_periods;
CREATE TRIGGER trg_employee_default_shift_no_overlap
  BEFORE INSERT OR UPDATE ON public.employee_default_shift_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_default_shift_no_overlap();

CREATE OR REPLACE FUNCTION public.dk_employee_default_shift_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'employee_default_shift_periods cannot be hard deleted';
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_default_shift_forbid_delete ON public.employee_default_shift_periods;
CREATE TRIGGER trg_employee_default_shift_forbid_delete
  BEFORE DELETE ON public.employee_default_shift_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_default_shift_forbid_delete();

DROP TRIGGER IF EXISTS trg_employee_default_shift_set_updated_at ON public.employee_default_shift_periods;
CREATE TRIGGER trg_employee_default_shift_set_updated_at
  BEFORE UPDATE ON public.employee_default_shift_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

ALTER TABLE public.employee_default_shift_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.employee_default_shift_periods FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_default_shift_no_overlap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_default_shift_forbid_delete() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- GRANT SELECT + policies。無表寫入 GRANT / policy。
-- Admin 全讀；Staff 只讀 user_id = auth.uid()；anon 無 SELECT。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_default_shift_periods') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: employee_default_shift_periods missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

ALTER TABLE public.employee_default_shift_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.employee_default_shift_periods FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.employee_default_shift_periods TO authenticated;

DROP POLICY IF EXISTS employee_default_shift_periods_select_own ON public.employee_default_shift_periods;
DROP POLICY IF EXISTS employee_default_shift_periods_select_admin ON public.employee_default_shift_periods;
CREATE POLICY employee_default_shift_periods_select_own
  ON public.employee_default_shift_periods
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.is_enabled_backoffice_user()
  );
CREATE POLICY employee_default_shift_periods_select_admin
  ON public.employee_default_shift_periods
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- Admin-only write RPC。snapshot / created_by 由 server 決定。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_default_shift_periods') IS NULL
     OR to_regclass('public.attendance_shift_templates') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: default shift table missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18 admin helpers missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_employee_default_shift(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_from date;
  v_prev_end date;
  v_template_id uuid;
  v_tpl public.attendance_shift_templates%ROWTYPE;
  v_prev public.employee_default_shift_periods%ROWTYPE;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'effective_to'
     OR p_payload ? 'shift_name_snapshot'
     OR p_payload ? 'scheduled_start_time'
     OR p_payload ? 'scheduled_end_time'
     OR p_payload ? 'scheduled_break_minutes'
     OR p_payload ? 'scheduled_cross_midnight'
     OR p_payload ? 'scheduled_late_grace_minutes'
     OR p_payload ? 'scheduled_early_leave_grace_minutes'
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
    v_from := (p_payload->>'effective_from')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'effective_from required';
  END;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'effective_from required';
  END IF;

  BEGIN
    v_template_id := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'shift_template_id', '')), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'shift_template_id required';
  END;
  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'shift_template_id required';
  END IF;

  SELECT * INTO v_tpl
  FROM public.attendance_shift_templates t
  WHERE t.id = v_template_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift template not found';
  END IF;
  IF v_tpl.enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'shift template disabled';
  END IF;

  PERFORM 1
  FROM public.employee_default_shift_periods p
  WHERE p.user_id = v_user
  FOR UPDATE;

  SELECT * INTO v_prev
  FROM public.employee_default_shift_periods p
  WHERE p.user_id = v_user
    AND p.effective_to IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_from <= v_prev.effective_from THEN
      RAISE EXCEPTION 'default shift period overlap';
    END IF;
    v_prev_end := v_from - 1;
    IF v_prev_end < v_prev.effective_from THEN
      RAISE EXCEPTION 'default shift period overlap';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.employee_default_shift_periods x
    WHERE x.user_id = v_user
      AND (v_prev.id IS NULL OR x.id IS DISTINCT FROM v_prev.id)
      AND daterange(x.effective_from, COALESCE(x.effective_to, 'infinity'::date), '[]')
          && daterange(v_from, 'infinity'::date, '[]')
  ) THEN
    RAISE EXCEPTION 'default shift period overlap';
  END IF;

  IF v_prev.id IS NOT NULL THEN
    UPDATE public.employee_default_shift_periods
    SET effective_to = v_prev_end,
        updated_by = v_uid
    WHERE id = v_prev.id;
  END IF;

  INSERT INTO public.employee_default_shift_periods (
    user_id, shift_template_id, effective_from, effective_to,
    shift_name_snapshot, scheduled_start_time, scheduled_end_time,
    scheduled_break_minutes, scheduled_cross_midnight,
    scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
    created_by, updated_by
  ) VALUES (
    v_user, v_tpl.id, v_from, NULL,
    v_tpl.name, v_tpl.start_time, v_tpl.end_time,
    v_tpl.break_minutes, v_tpl.cross_midnight,
    v_tpl.late_grace_minutes, v_tpl.early_leave_grace_minutes,
    v_uid, v_uid
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'user_id', v_user,
    'effective_from', v_from,
    'previous_id', v_prev.id,
    'previous_effective_to', v_prev_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_set_employee_default_shift(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_default_shift(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀。不 INSERT / UPDATE / DELETE。
-- ============================================================
/*

SELECT 1 AS seq, 'table.employee_default_shift_periods' AS check_name,
       (to_regclass('public.employee_default_shift_periods') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.employee_default_shift_periods') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rls.enabled',
       (COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'employee_default_shift_periods'), false))::text, 'true',
       CASE WHEN COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'employee_default_shift_periods'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'grant.anon_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee IN ('PUBLIC','anon')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee IN ('PUBLIC','anon')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'grant.authenticated_write_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'grant.authenticated_select',
       (EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_default_shift_periods'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'policy.write_none',
       (NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'policy.select_own',
       (EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND policyname = 'employee_default_shift_periods_select_own' AND cmd = 'SELECT'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND policyname = 'employee_default_shift_periods_select_own' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'policy.select_admin',
       (EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND policyname = 'employee_default_shift_periods_select_admin' AND cmd = 'SELECT'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND policyname = 'employee_default_shift_periods_select_admin' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'rpc.set_default',
       (to_regprocedure('public.backoffice_set_employee_default_shift(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_set_employee_default_shift(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rpc.security_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'rpc.search_path',
       (COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'exec.authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_set_employee_default_shift(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_set_employee_default_shift(jsonb)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_employee_default_shift(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_employee_default_shift(jsonb)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'rpc.has_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%shift_name_snapshot%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_tpl.start_time%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%shift_name_snapshot%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_tpl.start_time%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_default_shift'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'index.open_unique',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND indexname = 'employee_default_shift_periods_open_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'employee_default_shift_periods'
           AND indexname = 'employee_default_shift_periods_open_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
