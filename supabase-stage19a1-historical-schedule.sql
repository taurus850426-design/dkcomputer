-- ============================================================
-- DK Computer｜Stage 19A.1 Admin 歷史班表補建
-- 針對系統上線前、resolver 為 NO_SCHEDULE 的過去日期，
-- Admin 批次補建 employee_schedules（WORK / REST_DAY / REGULAR_HOLIDAY）。
-- 不改 default shift period、不改 punch、不改 leave overlay、不改 Payroll / Settlement。
-- 不建立 NATIONAL_HOLIDAY（仍走 attendance_calendar_days）。
--
-- 必須在 Stage 18 CLOSED + Stage 18.1 之後執行。
--
-- PREFLIGHT → M0_SCHEMA → M1_RLS（NONE）→ M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.employee_schedules' AS check_name,
       (to_regclass('public.employee_schedules') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.employee_schedules') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.attendance_shift_templates',
       (to_regclass('public.attendance_shift_templates') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_shift_templates') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.employee_default_shift_periods',
       (to_regclass('public.employee_default_shift_periods') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_default_shift_periods') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.payroll_settlements',
       (to_regclass('public.payroll_settlements') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.payroll_settlements') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'col.sched.day_type',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'day_type'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'day_type'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'rpc.resolve_schedule',
       (to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_resolve_schedule(uuid,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rpc.require_admin',
       (to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_schedule_require_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'rpc.taiwan_today',
       (to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_taiwan_today()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'fn.protect_history',
       (to_regprocedure('public.dk_employee_schedules_protect_history()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_employee_schedules_protect_history()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- 最小擴充 employee_schedules audit 欄位。
-- 允許歷史補建 INSERT 過去日期（僅 entry_source = ADMIN_HISTORICAL）。
-- 今天／過去的 UPDATE／DELETE 仍凍結。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.employee_schedules') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: employee_schedules missing.';
  END IF;
  IF to_regprocedure('public.dk_employee_schedules_protect_history()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: protect_history trigger function missing.';
  END IF;
END
$$;

ALTER TABLE public.employee_schedules
  ADD COLUMN IF NOT EXISTS entry_source text NOT NULL DEFAULT 'NORMAL';

ALTER TABLE public.employee_schedules
  ADD COLUMN IF NOT EXISTS historical_entry_reason text NULL;

ALTER TABLE public.employee_schedules
  DROP CONSTRAINT IF EXISTS employee_schedules_entry_source_ck;
ALTER TABLE public.employee_schedules
  ADD CONSTRAINT employee_schedules_entry_source_ck
  CHECK (entry_source IN ('NORMAL', 'ADMIN_HISTORICAL'));

ALTER TABLE public.employee_schedules
  DROP CONSTRAINT IF EXISTS employee_schedules_hist_reason_ck;
ALTER TABLE public.employee_schedules
  ADD CONSTRAINT employee_schedules_hist_reason_ck
  CHECK (
    (
      entry_source = 'ADMIN_HISTORICAL'
      AND historical_entry_reason IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(historical_entry_reason)) >= 1
      AND pg_catalog.length(historical_entry_reason) <= 200
    )
    OR (
      entry_source = 'NORMAL'
      AND historical_entry_reason IS NULL
    )
  );

COMMENT ON COLUMN public.employee_schedules.entry_source IS
  'NORMAL = 既有排班寫入。ADMIN_HISTORICAL = Admin 事後補建的歷史班表。';
COMMENT ON COLUMN public.employee_schedules.historical_entry_reason IS
  'Admin 歷史補建原因。僅 ADMIN_HISTORICAL 必填。created_at 仍為補建當下，不偽造歷史時間。';

CREATE OR REPLACE FUNCTION public.dk_employee_schedules_protect_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_today date;
BEGIN
  v_today := public.dk_attendance_taiwan_today();
  IF TG_OP = 'INSERT' THEN
    IF NEW.work_date < v_today
       AND COALESCE(NEW.entry_source, 'NORMAL') IS DISTINCT FROM 'ADMIN_HISTORICAL' THEN
      RAISE EXCEPTION 'cannot create past schedule';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.work_date <= v_today THEN
      RAISE EXCEPTION 'today or past schedule is frozen';
    END IF;
    IF NEW.work_date <= v_today THEN
      RAISE EXCEPTION 'cannot move schedule onto today or past';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.work_date <= v_today THEN
      RAISE EXCEPTION 'today or past schedule is frozen';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- NONE
-- 不新增 employee_schedules INSERT/UPDATE/DELETE grant。
-- 不改既有 SELECT policy。
-- ============================================================
/*

SELECT 'M1_RLS' AS section, 'NONE' AS change;

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
  IF to_regclass('public.employee_schedules') IS NULL
     OR to_regclass('public.attendance_shift_templates') IS NULL
     OR to_regclass('public.payroll_settlements') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: schedule or settlement table missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'entry_source'
  ) THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: employee_schedules.entry_source missing. Run M0_SCHEMA first.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_create_historical_schedules(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_user uuid;
  v_mode text;
  v_hist text;
  v_template_id uuid;
  v_day text;
  v_tpl public.attendance_shift_templates%ROWTYPE;
  v_today date;
  v_raw_n integer;
  v_elem text;
  v_d date;
  v_dates date[] := ARRAY[]::date[];
  v_month date;
  v_seen_month date;
  v_existing uuid;
  v_resolved jsonb;
  v_source text;
  v_id uuid;
  v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  v_uid := public.dk_schedule_require_admin();
  v_today := public.dk_attendance_taiwan_today();

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'shift_name_snapshot'
     OR p_payload ? 'scheduled_start_time'
     OR p_payload ? 'scheduled_end_time'
     OR p_payload ? 'scheduled_break_minutes'
     OR p_payload ? 'scheduled_cross_midnight'
     OR p_payload ? 'scheduled_late_grace_minutes'
     OR p_payload ? 'scheduled_early_leave_grace_minutes'
     OR p_payload ? 'entry_source' OR p_payload ? 'historical_entry_reason'
     OR p_payload ? 'schedule_type' OR p_payload ? 'leave_type'
     OR p_payload ? 'status' OR p_payload ? 'note'
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

  v_mode := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'mode', '')));
  IF v_mode NOT IN ('WORK', 'OFF') THEN
    RAISE EXCEPTION 'mode must be WORK or OFF';
  END IF;

  v_hist := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'historical_reason', '')), '');
  IF v_hist IS NULL THEN
    RAISE EXCEPTION 'historical_reason required';
  END IF;
  IF pg_catalog.length(v_hist) > 200 THEN
    RAISE EXCEPTION 'reason too long';
  END IF;

  IF v_mode = 'WORK' THEN
    IF p_payload ? 'day_type' AND NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'day_type', '')), '') IS NOT NULL THEN
      RAISE EXCEPTION 'WORK cannot have day_type';
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
  ELSE
    IF p_payload ? 'shift_template_id' AND NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'shift_template_id', '')), '') IS NOT NULL THEN
      RAISE EXCEPTION 'OFF cannot have shift_template_id';
    END IF;
    v_day := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'day_type', '')));
    IF v_day IS DISTINCT FROM 'REST_DAY' AND v_day IS DISTINCT FROM 'REGULAR_HOLIDAY' THEN
      RAISE EXCEPTION 'invalid day_type';
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(p_payload->'dates') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'dates required';
  END IF;
  v_raw_n := pg_catalog.jsonb_array_length(p_payload->'dates');
  IF v_raw_n IS NULL OR v_raw_n < 1 THEN
    RAISE EXCEPTION 'dates required';
  END IF;
  IF v_raw_n > 31 THEN
    RAISE EXCEPTION 'too many dates';
  END IF;

  FOR v_elem IN
    SELECT value FROM pg_catalog.jsonb_array_elements_text(p_payload->'dates') AS t(value)
  LOOP
    BEGIN
      v_d := NULLIF(pg_catalog.btrim(v_elem), '')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'work_date required';
    END;
    IF v_d IS NULL THEN
      RAISE EXCEPTION 'work_date required';
    END IF;
    IF v_d = ANY (v_dates) THEN
      RAISE EXCEPTION 'duplicate dates';
    END IF;
    IF v_d >= v_today THEN
      RAISE EXCEPTION 'work_date must be before today';
    END IF;
    v_dates := pg_catalog.array_append(v_dates, v_d);
  END LOOP;

  FOREACH v_d IN ARRAY v_dates LOOP
    v_month := pg_catalog.date_trunc('month', v_d::timestamp)::date;
    IF v_seen_month IS NOT DISTINCT FROM v_month THEN
      CONTINUE;
    END IF;
    v_seen_month := v_month;
    IF EXISTS (
      SELECT 1 FROM public.payroll_settlements s
      WHERE s.user_id = v_user
        AND s.payroll_month = v_month
        AND s.status = 'SETTLED'
    ) THEN
      RAISE EXCEPTION 'PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED';
    END IF;
  END LOOP;

  FOREACH v_d IN ARRAY v_dates LOOP
    SELECT s.id INTO v_existing
    FROM public.employee_schedules s
    WHERE s.user_id = v_user AND s.work_date = v_d
    FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'HISTORICAL_SCHEDULE_BATCH_CONFLICT:%', v_d
        USING DETAIL = 'HISTORICAL_SCHEDULE_ALREADY_EXISTS';
    END IF;

    v_resolved := public.dk_attendance_resolve_schedule(v_user, v_d);
    v_source := NULLIF(v_resolved->>'schedule_source', '');
    IF v_source IS NOT NULL AND v_source IS DISTINCT FROM 'NONE' THEN
      RAISE EXCEPTION 'HISTORICAL_SCHEDULE_BATCH_CONFLICT:%', v_d
        USING DETAIL = 'HISTORICAL_SCHEDULE_ALREADY_RESOLVED';
    END IF;

    IF v_mode = 'WORK' THEN
      INSERT INTO public.employee_schedules (
        user_id, work_date, shift_template_id, schedule_type, leave_type, day_type, note,
        shift_name_snapshot, scheduled_start_time, scheduled_end_time,
        scheduled_break_minutes, scheduled_cross_midnight,
        scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
        entry_source, historical_entry_reason, created_by, updated_by
      ) VALUES (
        v_user, v_d, v_tpl.id, 'WORK', NULL, 'WORKDAY', NULL,
        v_tpl.name, v_tpl.start_time, v_tpl.end_time,
        v_tpl.break_minutes, v_tpl.cross_midnight,
        v_tpl.late_grace_minutes, v_tpl.early_leave_grace_minutes,
        'ADMIN_HISTORICAL', v_hist, v_uid, v_uid
      )
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO public.employee_schedules (
        user_id, work_date, shift_template_id, schedule_type, leave_type, day_type, note,
        shift_name_snapshot, scheduled_start_time, scheduled_end_time,
        scheduled_break_minutes, scheduled_cross_midnight,
        scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
        entry_source, historical_entry_reason, created_by, updated_by
      ) VALUES (
        v_user, v_d, NULL, 'OFF', 'REST_DAY', v_day, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'ADMIN_HISTORICAL', v_hist, v_uid, v_uid
      )
      RETURNING id INTO v_id;
    END IF;
    v_ids := pg_catalog.array_append(v_ids, v_id);
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'count', pg_catalog.array_length(v_dates, 1),
    'mode', v_mode,
    'user_id', v_user,
    'entry_source', 'ADMIN_HISTORICAL'
  );
END;
$$;

COMMENT ON FUNCTION public.backoffice_create_historical_schedules(jsonb) IS
  'Admin-only atomic historical schedule backfill. Past dates only. Inserts employee_schedules when resolver is NO_SCHEDULE. Does not overwrite, change default periods, punches, leave overlays, or payroll settlements.';

REVOKE ALL ON FUNCTION public.backoffice_create_historical_schedules(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_historical_schedules(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'col.entry_source' AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'entry_source'
       ))::text AS actual, 'true' AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'entry_source'
       ) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'col.historical_entry_reason',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'historical_entry_reason'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules' AND column_name = 'historical_entry_reason'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.historical_sched_exists',
       (to_regprocedure('public.backoffice_create_historical_schedules(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_historical_schedules(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'rpc.historical_sched_guards',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_enabled_employee%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_BATCH_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_ALREADY_EXISTS%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_ALREADY_RESOLVED%'
            AND pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%work_date must be before today%'
            AND pg_get_functiondef(p.oid) ILIKE '%historical_reason required%'
            AND pg_get_functiondef(p.oid) ILIKE '%mode must be WORK or OFF%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_attendance_resolve_schedule%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.employee_schedules%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%DELETE FROM public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.payroll_settlements%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%NATIONAL_HOLIDAY%'
         FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.backoffice_create_historical_schedules(jsonb)')
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_enabled_employee%'
            AND pg_get_functiondef(p.oid) ILIKE '%PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_BATCH_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_ALREADY_EXISTS%'
            AND pg_get_functiondef(p.oid) ILIKE '%HISTORICAL_SCHEDULE_ALREADY_RESOLVED%'
            AND pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%work_date must be before today%'
            AND pg_get_functiondef(p.oid) ILIKE '%historical_reason required%'
            AND pg_get_functiondef(p.oid) ILIKE '%mode must be WORK or OFF%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_attendance_resolve_schedule%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.employee_schedules%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%DELETE FROM public.attendance_shifts%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%UPDATE public.payroll_settlements%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%NATIONAL_HOLIDAY%'
         FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.backoffice_create_historical_schedules(jsonb)')
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'trigger.protect_allows_historical',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%cannot create past schedule%'
            AND pg_get_functiondef(p.oid) ILIKE '%today or past schedule is frozen%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_employee_schedules_protect_history'
           AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%ADMIN_HISTORICAL%'
            AND pg_get_functiondef(p.oid) ILIKE '%cannot create past schedule%'
            AND pg_get_functiondef(p.oid) ILIKE '%today or past schedule is frozen%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_employee_schedules_protect_history'
           AND pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'grant.authenticated_exec',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_historical_schedules(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_historical_schedules(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'revoke.anon_exec',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_historical_schedules(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_historical_schedules(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'no.table_insert_grant',
       (NOT COALESCE(has_table_privilege('authenticated', 'public.employee_schedules', 'INSERT'), true)
        AND NOT COALESCE(has_table_privilege('anon', 'public.employee_schedules', 'INSERT'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_table_privilege('authenticated', 'public.employee_schedules', 'INSERT'), true)
             AND NOT COALESCE(has_table_privilege('anon', 'public.employee_schedules', 'INSERT'), true)
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
