-- ============================================================
-- DK Computer｜Stage 18.1 Admin 歷史請假補登
-- Admin 補登過去的病假 / 事假 / 特休（FULL_DAY APPROVED overlay）。
-- 不改班表、不改 punch、不改 Payroll formula、不碰 Settlement snapshot。
--
-- 必須在 Stage 18 CLOSED 之後執行（leave-types + payroll-settlement 已部署）。
--
-- PREFLIGHT → M0_SCHEMA → M1_RLS（NONE）→ M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_leave_requests' AS check_name,
       (to_regclass('public.attendance_leave_requests') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_leave_requests') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'col.leave_unit',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'leave_unit'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.payroll_settlements',
       (to_regclass('public.payroll_settlements') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.payroll_settlements') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.resolve_schedule',
       (to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'rpc.taiwan_today',
       (to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
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
    RAISE EXCEPTION 'M0_SCHEMA blocked: attendance_leave_requests missing.';
  END IF;
  IF to_regclass('public.payroll_settlements') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: payroll_settlements missing. Stage 18 settlement required.';
  END IF;
END
$$;

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'STAFF_REQUEST';

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS historical_entry_reason text NULL;

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_entry_source_ck;
ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_entry_source_ck
  CHECK (entry_source IN ('STAFF_REQUEST', 'ADMIN_DIRECT', 'ADMIN_HISTORICAL'));

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_hist_reason_len_ck;
ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_hist_reason_len_ck
  CHECK (historical_entry_reason IS NULL OR pg_catalog.length(historical_entry_reason) <= 200);

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_hist_reason_required_ck;
ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_hist_reason_required_ck
  CHECK (
    entry_source IS DISTINCT FROM 'ADMIN_HISTORICAL'
    OR (
      historical_entry_reason IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(historical_entry_reason)) > 0
    )
  );

COMMENT ON COLUMN public.attendance_leave_requests.entry_source IS
  'STAFF_REQUEST = employee application. ADMIN_DIRECT = admin rest-day set. ADMIN_HISTORICAL = admin backfill of past workday leave.';
COMMENT ON COLUMN public.attendance_leave_requests.historical_entry_reason IS
  'Required when entry_source = ADMIN_HISTORICAL. Explains why Admin backfilled after the leave date.';
COMMENT ON COLUMN public.attendance_leave_requests.created_by IS
  'Actor who created the row. Historical backfill sets this to Admin auth.uid(); not a forged leave_date timestamp.';

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

-- NONE：不新增 table write GRANT，不改 RLS。寫入只走 SECURITY DEFINER RPC。

SELECT 'M1_RLS' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.dk_schedule_require_admin()') IS NULL
     OR to_regprocedure('public.dk_schedule_require_enabled_employee(uuid)') IS NULL
     OR to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NULL
     OR to_regprocedure('public.dk_attendance_taiwan_today()') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18 admin/schedule helpers missing.';
  END IF;
  IF to_regclass('public.attendance_leave_requests') IS NULL
     OR to_regclass('public.payroll_settlements') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: leave or settlement table missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_create_historical_leave(p_payload jsonb)
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
  v_reason text;
  v_hist text;
  v_month date;
  v_resolved jsonb;
  v_sched_type text;
  v_day text;
  v_work boolean;
  v_source text;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'approved_by' OR p_payload ? 'approved_at'
     OR p_payload ? 'rejected_by' OR p_payload ? 'rejected_at'
     OR p_payload ? 'cancelled_by' OR p_payload ? 'cancelled_at'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'created_by' OR p_payload ? 'entry_source'
     OR p_payload ? 'day_type' OR p_payload ? 'schedule_type'
     OR p_payload ? 'payroll_ready' OR p_payload ? 'settled'
     OR p_payload ? 'settlement' OR p_payload ? 'payroll_month'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'leave_unit' AND pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_unit', ''))) IS DISTINCT FROM 'FULL_DAY' THEN
    RAISE EXCEPTION 'invalid leave_unit';
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
  IF v_date >= public.dk_attendance_taiwan_today() THEN
    RAISE EXCEPTION 'leave_date must be before today';
  END IF;

  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', '')));
  IF v_type NOT IN ('SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE') THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'reason', '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 200 THEN
    RAISE EXCEPTION 'reason too long';
  END IF;

  v_hist := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'historical_reason', '')), '');
  IF v_hist IS NULL THEN
    RAISE EXCEPTION 'historical_reason required';
  END IF;
  IF pg_catalog.length(v_hist) > 200 THEN
    RAISE EXCEPTION 'reason too long';
  END IF;

  v_month := pg_catalog.date_trunc('month', v_date::timestamp)::date;
  IF EXISTS (
    SELECT 1 FROM public.payroll_settlements s
    WHERE s.user_id = v_user
      AND s.payroll_month = v_month
      AND s.status = 'SETTLED'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_leave_requests r
    WHERE r.user_id = v_user AND r.leave_date = v_date
      AND r.status IN ('PENDING', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'LEAVE_CONFLICT';
  END IF;

  v_resolved := public.dk_attendance_resolve_schedule(v_user, v_date);
  v_sched_type := NULLIF(v_resolved->>'schedule_type', '');
  v_day := NULLIF(v_resolved->>'day_type', '');
  v_work := COALESCE((v_resolved->>'scheduled_work')::boolean, false);
  v_source := NULLIF(v_resolved->>'schedule_source', '');

  IF v_source IS NULL OR v_source = 'NONE'
     OR v_sched_type = 'OFF'
     OR v_sched_type IS DISTINCT FROM 'WORK'
     OR v_work IS NOT TRUE
     OR v_day IS DISTINCT FROM 'WORKDAY'
     OR v_day IN ('REST_DAY', 'REGULAR_HOLIDAY', 'NATIONAL_HOLIDAY')
  THEN
    RAISE EXCEPTION 'HISTORICAL_LEAVE_REQUIRES_WORKDAY';
  END IF;

  INSERT INTO public.attendance_leave_requests (
    user_id, leave_date, leave_type, leave_unit, status, reason,
    entry_source, historical_entry_reason, created_by, approved_by, approved_at
  ) VALUES (
    v_user, v_date, v_type, 'FULL_DAY', 'APPROVED', v_reason,
    'ADMIN_HISTORICAL', v_hist, v_uid, v_uid, pg_catalog.now()
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'status', 'APPROVED',
    'leave_type', v_type,
    'leave_date', v_date,
    'entry_source', 'ADMIN_HISTORICAL',
    'schedule_unchanged', true
  );
END;
$$;

COMMENT ON FUNCTION public.backoffice_create_historical_leave(jsonb) IS
  'Admin-only historical workday leave backfill. Inserts APPROVED SICK/PERSONAL/ANNUAL overlay. Does not change schedules, punches, or payroll settlements.';

REVOKE ALL ON FUNCTION public.backoffice_create_historical_leave(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_historical_leave(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'col.entry_source' AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'entry_source'
       ))::text AS actual, 'true' AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'entry_source'
       ) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'col.historical_entry_reason',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'historical_entry_reason'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'historical_entry_reason'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'col.created_by',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'created_by'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_leave_requests' AND column_name = 'created_by'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.historical_exists',
       (to_regprocedure('public.backoffice_create_historical_leave(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_historical_leave(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.historical_guards',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_LEAVE_REQUIRES_WORKDAY%'
            AND pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%leave_date must be before today%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.employee_schedules%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%DELETE FROM public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_historical_leave'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_LEAVE_REQUIRES_WORKDAY%'
            AND pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%leave_date must be before today%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.employee_schedules%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%DELETE FROM public.attendance_shifts%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_historical_leave'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'grant.authenticated_historical',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_historical_leave(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_historical_leave(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'grant.anon_no_historical',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_historical_leave(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_historical_leave(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'rpc.eval_untouched_name',
       (to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_eval_day(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
