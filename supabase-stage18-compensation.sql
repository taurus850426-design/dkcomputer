-- ============================================================
-- DK Computer｜Stage 18-5 試用期 / 正式薪資設定（Compensation Foundation）
-- 有效期間薪資：不塞 profiles、不覆蓋歷史、不做薪資計算 / Payroll。
--
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
-- 每一 SECTION 請單獨複製執行（含 /* */ 內全文）。
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.profiles' AS check_name,
       (to_regclass('public.profiles') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.profiles') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'helper.dk_schedule_require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'helper.dk_schedule_require_enabled_employee',
       (to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'helper.dk_attendance_set_updated_at',
       (to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: profiles missing.';
  END IF;
  IF to_regprocedure('public.dk_attendance_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: dk_attendance_set_updated_at missing.';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.employee_compensation_periods (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  employment_stage text NOT NULL,
  pay_type text NOT NULL,
  monthly_salary numeric(12,0) NULL,
  hourly_rate numeric(10,2) NULL,
  effective_from date NOT NULL,
  effective_to date NULL,
  note text NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT employee_compensation_periods_stage_ck
    CHECK (employment_stage IN ('PROBATION', 'REGULAR')),
  CONSTRAINT employee_compensation_periods_pay_type_ck
    CHECK (pay_type IN ('MONTHLY', 'HOURLY')),
  CONSTRAINT employee_compensation_periods_pay_shape_ck
    CHECK (
      (pay_type = 'MONTHLY' AND monthly_salary IS NOT NULL AND hourly_rate IS NULL
        AND monthly_salary >= 1 AND monthly_salary <= 99999999)
      OR
      (pay_type = 'HOURLY' AND hourly_rate IS NOT NULL AND monthly_salary IS NULL
        AND hourly_rate >= 1 AND hourly_rate <= 999999.99)
    ),
  CONSTRAINT employee_compensation_periods_range_ck
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT employee_compensation_periods_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_compensation_periods_open_uidx
  ON public.employee_compensation_periods (user_id)
  WHERE effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_compensation_periods_user_from_uidx
  ON public.employee_compensation_periods (user_id, effective_from);

CREATE INDEX IF NOT EXISTS employee_compensation_periods_user_idx
  ON public.employee_compensation_periods (user_id, effective_from);

COMMENT ON TABLE public.employee_compensation_periods IS
  'Stage 18-5 agreed compensation by effective period. History is append-only; do not overwrite past monthly_salary.';
COMMENT ON COLUMN public.employee_compensation_periods.effective_from IS
  'Inclusive Asia/Taipei business date. Client-supplied; not CURRENT_DATE.';
COMMENT ON COLUMN public.employee_compensation_periods.effective_to IS
  'Inclusive end. NULL = current open period.';

CREATE OR REPLACE FUNCTION public.dk_employee_compensation_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.employee_compensation_periods x
    WHERE x.user_id = NEW.user_id
      AND x.id IS DISTINCT FROM NEW.id
      AND daterange(x.effective_from, COALESCE(x.effective_to, 'infinity'::date), '[]')
          && daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'COMPENSATION_PERIOD_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_compensation_no_overlap ON public.employee_compensation_periods;
CREATE TRIGGER trg_employee_compensation_no_overlap
  BEFORE INSERT OR UPDATE ON public.employee_compensation_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_compensation_no_overlap();

CREATE OR REPLACE FUNCTION public.dk_employee_compensation_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'employee_compensation_periods cannot be hard deleted';
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_compensation_forbid_delete ON public.employee_compensation_periods;
CREATE TRIGGER trg_employee_compensation_forbid_delete
  BEFORE DELETE ON public.employee_compensation_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_compensation_forbid_delete();

DROP TRIGGER IF EXISTS trg_employee_compensation_set_updated_at ON public.employee_compensation_periods;
CREATE TRIGGER trg_employee_compensation_set_updated_at
  BEFORE UPDATE ON public.employee_compensation_periods
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

ALTER TABLE public.employee_compensation_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.employee_compensation_periods FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_compensation_no_overlap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_compensation_forbid_delete() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- Admin SELECT 全部。Staff / anon 不可讀。無表寫入 GRANT / policy。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_compensation_periods') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: employee_compensation_periods missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin missing.';
  END IF;
END
$$;

ALTER TABLE public.employee_compensation_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.employee_compensation_periods FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.employee_compensation_periods TO authenticated;

DROP POLICY IF EXISTS employee_compensation_periods_select_own ON public.employee_compensation_periods;
DROP POLICY IF EXISTS employee_compensation_periods_select_admin ON public.employee_compensation_periods;
CREATE POLICY employee_compensation_periods_select_admin
  ON public.employee_compensation_periods
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
  IF to_regclass('public.employee_compensation_periods') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: compensation table missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18 admin helpers missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_compensation_parse_monthly(p_raw text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v numeric(12,0);
BEGIN
  BEGIN
    v := NULLIF(pg_catalog.btrim(COALESCE(p_raw, '')), '')::numeric;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid monthly_salary';
  END;
  IF v IS NULL THEN
    RAISE EXCEPTION 'monthly_salary required';
  END IF;
  IF v <> trunc(v) OR v < 1 OR v > 99999999 THEN
    RAISE EXCEPTION 'invalid monthly_salary';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_compensation_insert_monthly(
  p_actor uuid,
  p_user uuid,
  p_stage text,
  p_from date,
  p_to date,
  p_salary numeric,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_note text;
BEGIN
  IF p_actor IS NULL OR p_user IS NULL OR p_from IS NULL OR p_salary IS NULL THEN
    RAISE EXCEPTION 'compensation insert arguments required';
  END IF;
  IF p_stage IS DISTINCT FROM 'PROBATION' AND p_stage IS DISTINCT FROM 'REGULAR' THEN
    RAISE EXCEPTION 'invalid employment_stage';
  END IF;
  IF p_to IS NOT NULL AND p_to < p_from THEN
    RAISE EXCEPTION 'invalid compensation period range';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), '');
  INSERT INTO public.employee_compensation_periods (
    user_id, employment_stage, pay_type, monthly_salary, hourly_rate,
    effective_from, effective_to, note, created_by, updated_by
  ) VALUES (
    p_user, p_stage, 'MONTHLY', p_salary, NULL,
    p_from, p_to, v_note, p_actor, p_actor
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_employee_compensation_plan(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_has_prob boolean := false;
  v_prob_from date;
  v_prob_to date;
  v_prob_pay numeric(12,0);
  v_reg_from date;
  v_reg_pay numeric(12,0);
  v_note text;
  v_prob_id uuid;
  v_reg_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'hourly_rate' OR p_payload ? 'id'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'pay_type' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'pay_type', ''))) IS DISTINCT FROM 'MONTHLY' THEN
    RAISE EXCEPTION 'invalid pay_type';
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

  v_has_prob := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_payload->>'has_probation', 'false'))) IN ('1', 'true', 'yes');
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');

  BEGIN
    v_reg_from := (p_payload->>'regular_from')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'regular_from required';
  END;
  IF v_reg_from IS NULL THEN
    RAISE EXCEPTION 'regular_from required';
  END IF;
  v_reg_pay := public.dk_compensation_parse_monthly(p_payload->>'regular_monthly_salary');

  IF v_has_prob THEN
    BEGIN
      v_prob_from := (p_payload->>'probation_from')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'probation_from required';
    END;
    BEGIN
      v_prob_to := (p_payload->>'probation_to')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'probation_to required';
    END;
    IF v_prob_from IS NULL THEN
      RAISE EXCEPTION 'probation_from required';
    END IF;
    IF v_prob_to IS NULL THEN
      RAISE EXCEPTION 'probation_to required';
    END IF;
    IF v_prob_to < v_prob_from THEN
      RAISE EXCEPTION 'invalid compensation period range';
    END IF;
    IF v_reg_from <= v_prob_to THEN
      RAISE EXCEPTION 'COMPENSATION_PERIOD_OVERLAP';
    END IF;
    v_prob_pay := public.dk_compensation_parse_monthly(p_payload->>'probation_monthly_salary');
  END IF;

  PERFORM 1
  FROM public.employee_compensation_periods p
  WHERE p.user_id = v_user
  FOR UPDATE;

  IF v_has_prob THEN
    v_prob_id := public.dk_compensation_insert_monthly(
      v_uid, v_user, 'PROBATION', v_prob_from, v_prob_to, v_prob_pay, v_note
    );
  END IF;
  v_reg_id := public.dk_compensation_insert_monthly(
    v_uid, v_user, 'REGULAR', v_reg_from, NULL, v_reg_pay, v_note
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'probation_id', v_prob_id,
    'regular_id', v_reg_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_employee_compensation_raise(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_from date;
  v_stage text;
  v_pay numeric(12,0);
  v_note text;
  v_prev public.employee_compensation_periods%ROWTYPE;
  v_prev_end date;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'hourly_rate' OR p_payload ? 'id' OR p_payload ? 'effective_to'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'pay_type' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'pay_type', ''))) IS DISTINCT FROM 'MONTHLY' THEN
    RAISE EXCEPTION 'invalid pay_type';
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
  v_pay := public.dk_compensation_parse_monthly(
    COALESCE(p_payload->>'monthly_salary', p_payload->>'regular_monthly_salary')
  );
  v_stage := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'employment_stage', 'REGULAR')));
  IF v_stage IS DISTINCT FROM 'PROBATION' AND v_stage IS DISTINCT FROM 'REGULAR' THEN
    RAISE EXCEPTION 'invalid employment_stage';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');

  PERFORM 1
  FROM public.employee_compensation_periods p
  WHERE p.user_id = v_user
  FOR UPDATE;

  SELECT * INTO v_prev
  FROM public.employee_compensation_periods p
  WHERE p.user_id = v_user
    AND p.effective_to IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_from <= v_prev.effective_from THEN
      RAISE EXCEPTION 'COMPENSATION_PERIOD_OVERLAP';
    END IF;
    v_prev_end := v_from - 1;
    IF v_prev_end < v_prev.effective_from THEN
      RAISE EXCEPTION 'COMPENSATION_PERIOD_OVERLAP';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.employee_compensation_periods x
    WHERE x.user_id = v_user
      AND (v_prev.id IS NULL OR x.id IS DISTINCT FROM v_prev.id)
      AND daterange(x.effective_from, COALESCE(x.effective_to, 'infinity'::date), '[]')
          && daterange(v_from, 'infinity'::date, '[]')
  ) THEN
    RAISE EXCEPTION 'COMPENSATION_PERIOD_OVERLAP';
  END IF;

  IF v_prev.id IS NOT NULL THEN
    UPDATE public.employee_compensation_periods
    SET effective_to = v_prev_end,
        updated_by = v_uid
    WHERE id = v_prev.id;
  END IF;

  v_id := public.dk_compensation_insert_monthly(
    v_uid, v_user, v_stage, v_from, NULL, v_pay, v_note
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'closed_previous_to', v_prev_end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_compensation_parse_monthly(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_compensation_insert_monthly(uuid, uuid, text, date, date, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_employee_compensation_plan(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_compensation_plan(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_employee_compensation_raise(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_employee_compensation_raise(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'table.employee_compensation_periods' AS check_name,
       (to_regclass('public.employee_compensation_periods') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.employee_compensation_periods') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rls.enabled',
       (COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'employee_compensation_periods'), false))::text, 'true',
       CASE WHEN COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'employee_compensation_periods'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'grant.anon_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee IN ('PUBLIC','anon')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee IN ('PUBLIC','anon')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'grant.authenticated_write_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'grant.authenticated_select',
       (EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'employee_compensation_periods'
           AND grantee = 'authenticated' AND privilege_type = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'policy.admin_select_only',
       ((
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods' AND cmd = 'SELECT'
       ) = 1
       AND EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods'
           AND cmd = 'SELECT' AND policyname = 'employee_compensation_periods_select_admin'
           AND qual ILIKE '%is_admin%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods'
           AND (cmd IN ('INSERT','UPDATE','DELETE','ALL') OR policyname ILIKE '%own%')
       ))::text, 'true',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods' AND cmd = 'SELECT'
       ) = 1
       AND EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods'
           AND cmd = 'SELECT' AND policyname = 'employee_compensation_periods_select_admin'
           AND qual ILIKE '%is_admin%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_compensation_periods'
           AND (cmd IN ('INSERT','UPDATE','DELETE','ALL') OR policyname ILIKE '%own%')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rpc.plan_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_plan'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_plan'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'exec.plan_authenticated',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_set_employee_compensation_plan(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_set_employee_compensation_plan(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'exec.anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_employee_compensation_plan(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_set_employee_compensation_plan(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'exec.helper_insert_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_compensation_insert_monthly(uuid,uuid,text,date,date,numeric,text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_compensation_insert_monthly(uuid,uuid,text,date,date,numeric,text)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'rpc.plan_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_enabled_employee%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_plan'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_enabled_employee%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_plan'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'rpc.raise_closes_open',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%effective_to%'
            AND pg_get_functiondef(p.oid) ILIKE '%COMPENSATION_PERIOD_OVERLAP%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_raise'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%effective_to%'
            AND pg_get_functiondef(p.oid) ILIKE '%COMPENSATION_PERIOD_OVERLAP%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_set_employee_compensation_raise'
       ), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
