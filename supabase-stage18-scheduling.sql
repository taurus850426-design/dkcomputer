-- ============================================================
-- DK Computer Stage 18-1：班別 template + 員工每日排班 Foundation
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會建表、改 RLS、建 RPC。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_FUNCTIONS → M3_VERIFY
--
-- Additive only：
--   + public.attendance_shift_templates
--   + public.employee_schedules（含班別 snapshot）
--   + Admin-only write RPC
--   + Admin SELECT templates；Admin SELECT all schedules；Staff SELECT own schedules
--
-- 禁止：
--   改 attendance_shifts / attendance_breaks / attendance_audit_logs / attendance_settings
--   改 clock in/out/break RPC 與 *_company_network
--   改 GPS / network restriction / correction / audit
--   改 Stage 16 / 17、AP、PO、inventory、orders、profiles schema
--   建 employee_compensation / payroll_* / 薪資公式
--   班別 hard delete
--   每月 OFF=8 的 DB constraint
--   service_role 前端
--   信任 client employee_id / timestamp / snapshot / created_by
--
-- 模型：
--   attendance_shift_templates = 班別定義（不是打卡 session）
--   attendance_shifts          = 既有打卡 session（本 Stage 不碰）
--   employee_schedules.work_date = Admin 傳入的 Asia/Taipei 排班日
--   WORK 列寫入當下 template snapshot；之後改 template 不回寫歷史
--   schedule_type = WORK | OFF
--   leave_type 僅 OFF 可用（預留法規細分類，本 Stage 不扣款）
--
-- 凍結規則（尚無 payroll audit 前）：
--   work_date < 台北今天：禁止 INSERT/UPDATE/DELETE
--   work_date = 台北今天：允許首次 INSERT；禁止 UPDATE/DELETE
--   work_date > 台北今天：允許 upsert / hard delete
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 Stage 11/17 前置物件，且本 Stage 寫入 RPC 尚未誤建。
-- 請複製本 SECTION（從下一行到 PREFLIGHT END）單獨執行。
-- ============================================================
/*

SELECT 'profiles' AS obj,
       (to_regclass('public.profiles') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.profiles') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'attendance_shifts',
       (to_regclass('public.attendance_shifts') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_shifts') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'attendance_breaks',
       (to_regclass('public.attendance_breaks') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_breaks') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'attendance_audit_logs',
       (to_regclass('public.attendance_audit_logs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_audit_logs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'attendance_settings',
       (to_regclass('public.attendance_settings') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_settings') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_admin()',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_enabled_backoffice_user()',
       (to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_require_backoffice()',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_attendance_set_updated_at()',
       (to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_attendance_set_updated_at()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'clock_in_gps_signature',
       (to_regprocedure('public.attendance_clock_in(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'clock_out_gps_signature',
       (to_regprocedure('public.attendance_clock_out(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_out(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'break_start_gps_signature',
       (to_regprocedure('public.attendance_break_start(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_start(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'break_end_gps_signature',
       (to_regprocedure('public.attendance_break_end(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_end(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'clock_in_company_network',
       (to_regprocedure('public.attendance_clock_in_company_network(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in_company_network(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage16.monthly_profit_distributions',
       (to_regclass('public.monthly_profit_distributions') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage17.inventory_ledger',
       (to_regclass('public.inventory_ledger') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_ledger') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'salary_table_absent',
       (to_regclass('public.employee_compensation') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_compensation') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'payroll_runs_absent',
       (to_regclass('public.payroll_runs') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.payroll_runs') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'templates_absent_or_rerun',
       (to_regclass('public.attendance_shift_templates') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.attendance_shift_templates') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'schedules_absent_or_rerun',
       (to_regclass('public.employee_schedules') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.employee_schedules') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'create_template_rpc_absent_or_rerun',
       (to_regprocedure('public.backoffice_create_attendance_shift_template(jsonb)') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regprocedure('public.backoffice_create_attendance_shift_template(jsonb)') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- 建 2 表 + constraints + indexes + history/disable triggers。
-- ENABLE RLS + REVOKE client（fail-closed；policy 在 M1）。
-- 不建 write RPC。不碰 Stage 11 operational attendance 表。
-- 請複製本 SECTION（從下一行到 M0_SCHEMA END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.profiles missing.';
  END IF;
  IF to_regclass('public.attendance_shifts') IS NULL
     OR to_regclass('public.attendance_breaks') IS NULL
     OR to_regclass('public.attendance_audit_logs') IS NULL
     OR to_regclass('public.attendance_settings') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: Stage 11 attendance tables missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
     OR to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.dk_attendance_set_updated_at()') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: auth / attendance helpers missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_attendance_taiwan_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (pg_catalog.timezone('Asia/Taipei', pg_catalog.now()))::date;
$$;

COMMENT ON FUNCTION public.dk_attendance_taiwan_today() IS
  'Stage 18-1: Asia/Taipei calendar date of now(); never CURRENT_DATE.';

REVOKE ALL ON FUNCTION public.dk_attendance_taiwan_today() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.attendance_shift_templates (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0,
  cross_midnight boolean NOT NULL DEFAULT false,
  late_grace_minutes integer NOT NULL DEFAULT 0,
  early_leave_grace_minutes integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT attendance_shift_templates_name_ck
    CHECK (
      name = pg_catalog.btrim(name)
      AND pg_catalog.length(name) >= 1
      AND pg_catalog.length(name) <= 80
    ),
  CONSTRAINT attendance_shift_templates_break_ck
    CHECK (break_minutes >= 0 AND break_minutes <= 480),
  CONSTRAINT attendance_shift_templates_late_grace_ck
    CHECK (late_grace_minutes >= 0 AND late_grace_minutes <= 180),
  CONSTRAINT attendance_shift_templates_early_grace_ck
    CHECK (early_leave_grace_minutes >= 0 AND early_leave_grace_minutes <= 180),
  CONSTRAINT attendance_shift_templates_range_ck
    CHECK (
      start_time IS DISTINCT FROM end_time
      AND (
        (cross_midnight = false AND end_time > start_time)
        OR (cross_midnight = true AND end_time < start_time)
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_shift_templates_name_ci_uidx
  ON public.attendance_shift_templates (pg_catalog.lower(pg_catalog.btrim(name)));

CREATE INDEX IF NOT EXISTS attendance_shift_templates_enabled_idx
  ON public.attendance_shift_templates (enabled);

COMMENT ON TABLE public.attendance_shift_templates IS
  'Stage 18-1 shift definitions. Not attendance_shifts (clock sessions). Disable with enabled=false; no hard delete.';
COMMENT ON COLUMN public.attendance_shift_templates.cross_midnight IS
  'true => end_time < start_time (e.g. 22:00-06:00). false => end_time > start_time. Equal times forbidden.';

CREATE OR REPLACE FUNCTION public.dk_attendance_shift_templates_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'attendance_shift_templates cannot be hard deleted; set enabled=false';
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_shift_templates_forbid_delete ON public.attendance_shift_templates;
CREATE TRIGGER trg_attendance_shift_templates_forbid_delete
  BEFORE DELETE ON public.attendance_shift_templates
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_shift_templates_forbid_delete();

DROP TRIGGER IF EXISTS trg_attendance_shift_templates_set_updated_at ON public.attendance_shift_templates;
CREATE TRIGGER trg_attendance_shift_templates_set_updated_at
  BEFORE UPDATE ON public.attendance_shift_templates
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

CREATE TABLE IF NOT EXISTS public.employee_schedules (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  shift_template_id uuid NULL REFERENCES public.attendance_shift_templates(id) ON DELETE RESTRICT,
  schedule_type text NOT NULL,
  leave_type text NULL,
  note text NULL,
  shift_name_snapshot text NULL,
  scheduled_start_time time NULL,
  scheduled_end_time time NULL,
  scheduled_break_minutes integer NULL,
  scheduled_cross_midnight boolean NULL,
  scheduled_late_grace_minutes integer NULL,
  scheduled_early_leave_grace_minutes integer NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT employee_schedules_user_date_uidx UNIQUE (user_id, work_date),
  CONSTRAINT employee_schedules_type_ck
    CHECK (schedule_type IN ('WORK', 'OFF')),
  CONSTRAINT employee_schedules_leave_type_ck
    CHECK (
      leave_type IS NULL
      OR leave_type IN (
        'REST_DAY',
        'REGULAR_LEAVE',
        'ANNUAL_LEAVE',
        'SICK_LEAVE',
        'PERSONAL_LEAVE',
        'PUBLIC_HOLIDAY'
      )
    ),
  CONSTRAINT employee_schedules_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 500),
  CONSTRAINT employee_schedules_work_off_ck
    CHECK (
      (
        schedule_type = 'WORK'
        AND shift_template_id IS NOT NULL
        AND leave_type IS NULL
        AND shift_name_snapshot IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(shift_name_snapshot)) >= 1
        AND scheduled_start_time IS NOT NULL
        AND scheduled_end_time IS NOT NULL
        AND scheduled_break_minutes IS NOT NULL
        AND scheduled_cross_midnight IS NOT NULL
        AND scheduled_late_grace_minutes IS NOT NULL
        AND scheduled_early_leave_grace_minutes IS NOT NULL
      )
      OR (
        schedule_type = 'OFF'
        AND shift_template_id IS NULL
        AND shift_name_snapshot IS NULL
        AND scheduled_start_time IS NULL
        AND scheduled_end_time IS NULL
        AND scheduled_break_minutes IS NULL
        AND scheduled_cross_midnight IS NULL
        AND scheduled_late_grace_minutes IS NULL
        AND scheduled_early_leave_grace_minutes IS NULL
      )
    )
);

-- Recreate work/off check without the tautology above (rerun-safe).
ALTER TABLE public.employee_schedules
  DROP CONSTRAINT IF EXISTS employee_schedules_work_off_ck;
ALTER TABLE public.employee_schedules
  ADD CONSTRAINT employee_schedules_work_off_ck
  CHECK (
    (
      schedule_type = 'WORK'
      AND shift_template_id IS NOT NULL
      AND leave_type IS NULL
      AND shift_name_snapshot IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(shift_name_snapshot)) >= 1
      AND scheduled_start_time IS NOT NULL
      AND scheduled_end_time IS NOT NULL
      AND scheduled_break_minutes IS NOT NULL
      AND scheduled_cross_midnight IS NOT NULL
      AND scheduled_late_grace_minutes IS NOT NULL
      AND scheduled_early_leave_grace_minutes IS NOT NULL
    )
    OR (
      schedule_type = 'OFF'
      AND shift_template_id IS NULL
      AND shift_name_snapshot IS NULL
      AND scheduled_start_time IS NULL
      AND scheduled_end_time IS NULL
      AND scheduled_break_minutes IS NULL
      AND scheduled_cross_midnight IS NULL
      AND scheduled_late_grace_minutes IS NULL
      AND scheduled_early_leave_grace_minutes IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS employee_schedules_work_date_idx
  ON public.employee_schedules (work_date);
CREATE INDEX IF NOT EXISTS employee_schedules_user_id_idx
  ON public.employee_schedules (user_id);
CREATE INDEX IF NOT EXISTS employee_schedules_template_id_idx
  ON public.employee_schedules (shift_template_id);

COMMENT ON TABLE public.employee_schedules IS
  'Stage 18-1 one official schedule per employee per Taipei work_date. WORK rows store template snapshot.';
COMMENT ON COLUMN public.employee_schedules.work_date IS
  'Asia/Taipei calendar date supplied by Admin. Overnight shifts belong to start date.';
COMMENT ON COLUMN public.employee_schedules.shift_name_snapshot IS
  'Copied from template at WORK write time. Later template edits must not change this row.';

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
    IF NEW.work_date < v_today THEN
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

DROP TRIGGER IF EXISTS trg_employee_schedules_protect_history ON public.employee_schedules;
CREATE TRIGGER trg_employee_schedules_protect_history
  BEFORE INSERT OR UPDATE OR DELETE ON public.employee_schedules
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_employee_schedules_protect_history();

DROP TRIGGER IF EXISTS trg_employee_schedules_set_updated_at ON public.employee_schedules;
CREATE TRIGGER trg_employee_schedules_set_updated_at
  BEFORE UPDATE ON public.employee_schedules
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

ALTER TABLE public.attendance_shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_shift_templates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.employee_schedules FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.dk_attendance_shift_templates_forbid_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_employee_schedules_protect_history() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- GRANT SELECT + policies。
-- templates：僅 admin SELECT。
-- schedules：admin 全讀；staff 只讀 user_id = auth.uid()。
-- 無 INSERT/UPDATE/DELETE policy；authenticated 無表寫入 GRANT。
-- 請複製本 SECTION（從下一行到 M1_RLS END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_shift_templates') IS NULL
     OR to_regclass('public.employee_schedules') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: Stage 18 tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

ALTER TABLE public.attendance_shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_schedules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_shift_templates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.employee_schedules FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.attendance_shift_templates TO authenticated;
GRANT SELECT ON TABLE public.employee_schedules TO authenticated;

DROP POLICY IF EXISTS attendance_shift_templates_select_admin ON public.attendance_shift_templates;
CREATE POLICY attendance_shift_templates_select_admin
  ON public.attendance_shift_templates
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS employee_schedules_select_own ON public.employee_schedules;
DROP POLICY IF EXISTS employee_schedules_select_admin ON public.employee_schedules;
CREATE POLICY employee_schedules_select_own
  ON public.employee_schedules
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.is_enabled_backoffice_user()
  );
CREATE POLICY employee_schedules_select_admin
  ON public.employee_schedules
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- Admin-only write RPC。時間 / created_by / snapshot 由 server 決定。
-- SECURITY DEFINER + search_path=''。
-- 請複製本 SECTION（從下一行到 M2_FUNCTIONS END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_shift_templates') IS NULL
     OR to_regclass('public.employee_schedules') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 18 tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.dk_attendance_taiwan_today()') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: dk_attendance_taiwan_today missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: dk_require_backoffice / is_admin missing.';
  END IF;
  IF to_regprocedure('public.attendance_clock_in(double precision,double precision,double precision)') IS NULL
     OR to_regprocedure('public.attendance_clock_out(double precision,double precision,double precision)') IS NULL
     OR to_regprocedure('public.attendance_break_start(double precision,double precision,double precision)') IS NULL
     OR to_regprocedure('public.attendance_break_end(double precision,double precision,double precision)') IS NULL
  THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: Stage 11 GPS clock RPCs missing; refusing to continue.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_schedule_require_admin()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() OR v_uid IS NULL THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_schedule_require_enabled_employee(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_enabled boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  SELECT p.role, p.enabled
    INTO v_role, v_enabled
  FROM public.profiles p
  WHERE p.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee not found';
  END IF;
  IF v_enabled IS NOT TRUE OR v_role IS NULL OR v_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'employee disabled or not a backoffice user';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_schedule_parse_time(p_raw text)
RETURNS time
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text;
  v_time time;
BEGIN
  v := NULLIF(pg_catalog.btrim(COALESCE(p_raw, '')), '');
  IF v IS NULL THEN
    RAISE EXCEPTION 'time required';
  END IF;
  BEGIN
    v_time := v::time;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid time';
  END;
  RETURN v_time;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_schedule_validate_template_range(
  p_start time,
  p_end time,
  p_cross boolean
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_cross IS NULL THEN
    RAISE EXCEPTION 'shift times required';
  END IF;
  IF p_start IS NOT DISTINCT FROM p_end THEN
    RAISE EXCEPTION 'start_time and end_time cannot be equal';
  END IF;
  IF p_cross IS TRUE THEN
    IF p_end >= p_start THEN
      RAISE EXCEPTION 'cross_midnight requires end_time < start_time';
    END IF;
  ELSE
    IF p_end <= p_start THEN
      RAISE EXCEPTION 'same-day shift requires end_time > start_time';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_schedule_require_admin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_schedule_require_enabled_employee(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_schedule_parse_time(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_schedule_validate_template_range(time, time, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_create_attendance_shift_template(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_name text;
  v_start time;
  v_end time;
  v_break integer;
  v_cross boolean;
  v_late integer;
  v_early integer;
  v_enabled boolean;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by' OR p_payload ? 'created_at' OR p_payload ? 'updated_at' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  v_name := pg_catalog.btrim(COALESCE(p_payload->>'name', ''));
  IF v_name = '' OR pg_catalog.length(v_name) > 80 THEN
    RAISE EXCEPTION 'name required';
  END IF;

  v_start := public.dk_schedule_parse_time(p_payload->>'start_time');
  v_end := public.dk_schedule_parse_time(p_payload->>'end_time');
  v_cross := COALESCE((p_payload->>'cross_midnight')::boolean, false);
  PERFORM public.dk_schedule_validate_template_range(v_start, v_end, v_cross);

  BEGIN
    v_break := COALESCE((p_payload->>'break_minutes')::integer, 0);
    v_late := COALESCE((p_payload->>'late_grace_minutes')::integer, 0);
    v_early := COALESCE((p_payload->>'early_leave_grace_minutes')::integer, 0);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid minutes';
  END;
  IF v_break < 0 OR v_break > 480 OR v_late < 0 OR v_late > 180 OR v_early < 0 OR v_early > 180 THEN
    RAISE EXCEPTION 'invalid minutes';
  END IF;

  v_enabled := COALESCE((p_payload->>'enabled')::boolean, true);

  INSERT INTO public.attendance_shift_templates (
    name, start_time, end_time, break_minutes, cross_midnight,
    late_grace_minutes, early_leave_grace_minutes, enabled,
    created_by, updated_by
  ) VALUES (
    v_name, v_start, v_end, v_break, v_cross,
    v_late, v_early, v_enabled,
    v_uid, v_uid
  )
  RETURNING id INTO v_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_update_attendance_shift_template(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_id uuid;
  v_row public.attendance_shift_templates%ROWTYPE;
  v_name text;
  v_start time;
  v_end time;
  v_break integer;
  v_cross boolean;
  v_late integer;
  v_early integer;
  v_enabled boolean;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'updated_by' OR p_payload ? 'created_at' OR p_payload ? 'updated_at' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  BEGIN
    v_id := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'id', '')), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'id required';
  END;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'id required';
  END IF;

  SELECT * INTO v_row
  FROM public.attendance_shift_templates t
  WHERE t.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift template not found';
  END IF;

  IF p_payload ? 'name' THEN
    v_name := pg_catalog.btrim(COALESCE(p_payload->>'name', ''));
    IF v_name = '' OR pg_catalog.length(v_name) > 80 THEN
      RAISE EXCEPTION 'name required';
    END IF;
  ELSE
    v_name := v_row.name;
  END IF;

  IF p_payload ? 'start_time' THEN
    v_start := public.dk_schedule_parse_time(p_payload->>'start_time');
  ELSE
    v_start := v_row.start_time;
  END IF;
  IF p_payload ? 'end_time' THEN
    v_end := public.dk_schedule_parse_time(p_payload->>'end_time');
  ELSE
    v_end := v_row.end_time;
  END IF;
  IF p_payload ? 'cross_midnight' THEN
    BEGIN
      v_cross := (p_payload->>'cross_midnight')::boolean;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid cross_midnight';
    END;
    IF v_cross IS NULL THEN
      RAISE EXCEPTION 'invalid cross_midnight';
    END IF;
  ELSE
    v_cross := v_row.cross_midnight;
  END IF;
  PERFORM public.dk_schedule_validate_template_range(v_start, v_end, v_cross);

  BEGIN
    IF p_payload ? 'break_minutes' THEN
      v_break := (p_payload->>'break_minutes')::integer;
    ELSE
      v_break := v_row.break_minutes;
    END IF;
    IF p_payload ? 'late_grace_minutes' THEN
      v_late := (p_payload->>'late_grace_minutes')::integer;
    ELSE
      v_late := v_row.late_grace_minutes;
    END IF;
    IF p_payload ? 'early_leave_grace_minutes' THEN
      v_early := (p_payload->>'early_leave_grace_minutes')::integer;
    ELSE
      v_early := v_row.early_leave_grace_minutes;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid minutes';
  END;
  IF v_break IS NULL OR v_late IS NULL OR v_early IS NULL
     OR v_break < 0 OR v_break > 480 OR v_late < 0 OR v_late > 180 OR v_early < 0 OR v_early > 180 THEN
    RAISE EXCEPTION 'invalid minutes';
  END IF;

  IF p_payload ? 'enabled' THEN
    BEGIN
      v_enabled := (p_payload->>'enabled')::boolean;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid enabled';
    END;
    IF v_enabled IS NULL THEN
      RAISE EXCEPTION 'invalid enabled';
    END IF;
  ELSE
    v_enabled := v_row.enabled;
  END IF;

  UPDATE public.attendance_shift_templates
  SET name = v_name,
      start_time = v_start,
      end_time = v_end,
      break_minutes = v_break,
      cross_midnight = v_cross,
      late_grace_minutes = v_late,
      early_leave_grace_minutes = v_early,
      enabled = v_enabled,
      updated_by = v_uid
  WHERE id = v_id;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_upsert_employee_schedule(p_payload jsonb)
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
  v_leave text;
  v_note text;
  v_template_id uuid;
  v_tpl public.attendance_shift_templates%ROWTYPE;
  v_id uuid;
BEGIN
  v_uid := public.dk_schedule_require_admin();
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

  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'schedule_type', '')));
  IF v_type NOT IN ('WORK', 'OFF') THEN
    RAISE EXCEPTION 'schedule_type must be WORK or OFF';
  END IF;

  v_leave := NULLIF(pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', ''))), '');
  IF v_leave IS NOT NULL AND v_leave NOT IN (
    'REST_DAY', 'REGULAR_LEAVE', 'ANNUAL_LEAVE', 'SICK_LEAVE', 'PERSONAL_LEAVE', 'PUBLIC_HOLIDAY'
  ) THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 500 THEN
    RAISE EXCEPTION 'note too long';
  END IF;

  PERFORM 1
  FROM public.employee_schedules s
  WHERE s.user_id = v_user AND s.work_date = v_date
  FOR UPDATE;

  IF v_type = 'WORK' THEN
    IF v_leave IS NOT NULL THEN
      RAISE EXCEPTION 'WORK cannot have leave_type';
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

    INSERT INTO public.employee_schedules (
      user_id, work_date, shift_template_id, schedule_type, leave_type, note,
      shift_name_snapshot, scheduled_start_time, scheduled_end_time,
      scheduled_break_minutes, scheduled_cross_midnight,
      scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
      created_by, updated_by
    ) VALUES (
      v_user, v_date, v_tpl.id, 'WORK', NULL, v_note,
      v_tpl.name, v_tpl.start_time, v_tpl.end_time,
      v_tpl.break_minutes, v_tpl.cross_midnight,
      v_tpl.late_grace_minutes, v_tpl.early_leave_grace_minutes,
      v_uid, v_uid
    )
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      shift_template_id = EXCLUDED.shift_template_id,
      schedule_type = 'WORK',
      leave_type = NULL,
      note = EXCLUDED.note,
      shift_name_snapshot = EXCLUDED.shift_name_snapshot,
      scheduled_start_time = EXCLUDED.scheduled_start_time,
      scheduled_end_time = EXCLUDED.scheduled_end_time,
      scheduled_break_minutes = EXCLUDED.scheduled_break_minutes,
      scheduled_cross_midnight = EXCLUDED.scheduled_cross_midnight,
      scheduled_late_grace_minutes = EXCLUDED.scheduled_late_grace_minutes,
      scheduled_early_leave_grace_minutes = EXCLUDED.scheduled_early_leave_grace_minutes,
      updated_by = EXCLUDED.updated_by
    RETURNING id INTO v_id;
  ELSE
    IF p_payload ? 'shift_template_id' AND NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'shift_template_id', '')), '') IS NOT NULL THEN
      RAISE EXCEPTION 'OFF cannot have shift_template_id';
    END IF;
    INSERT INTO public.employee_schedules (
      user_id, work_date, shift_template_id, schedule_type, leave_type, note,
      shift_name_snapshot, scheduled_start_time, scheduled_end_time,
      scheduled_break_minutes, scheduled_cross_midnight,
      scheduled_late_grace_minutes, scheduled_early_leave_grace_minutes,
      created_by, updated_by
    ) VALUES (
      v_user, v_date, NULL, 'OFF', v_leave, v_note,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_uid, v_uid
    )
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      shift_template_id = NULL,
      schedule_type = 'OFF',
      leave_type = EXCLUDED.leave_type,
      note = EXCLUDED.note,
      shift_name_snapshot = NULL,
      scheduled_start_time = NULL,
      scheduled_end_time = NULL,
      scheduled_break_minutes = NULL,
      scheduled_cross_midnight = NULL,
      scheduled_late_grace_minutes = NULL,
      scheduled_early_leave_grace_minutes = NULL,
      updated_by = EXCLUDED.updated_by
    RETURNING id INTO v_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'user_id', v_user,
    'work_date', v_date,
    'schedule_type', v_type
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_delete_employee_schedule(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.employee_schedules%ROWTYPE;
BEGIN
  v_uid := public.dk_schedule_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id required';
  END IF;

  SELECT * INTO v_row
  FROM public.employee_schedules s
  WHERE s.id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schedule not found';
  END IF;

  DELETE FROM public.employee_schedules WHERE id = p_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'deleted_id', p_id,
    'user_id', v_row.user_id,
    'work_date', v_row.work_date,
    'deleted_by', v_uid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_create_attendance_shift_template(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_attendance_shift_template(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.backoffice_update_attendance_shift_template(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_attendance_shift_template(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.backoffice_upsert_employee_schedule(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_employee_schedule(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.backoffice_delete_employee_schedule(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_delete_employee_schedule(uuid) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀。不 INSERT / UPDATE / DELETE。
-- 請複製本 SECTION（從下一行到 M3_VERIFY END）單獨執行。
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_shift_templates' AS check_name,
       (to_regclass('public.attendance_shift_templates') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_shift_templates') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.employee_schedules',
       (to_regclass('public.employee_schedules') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_schedules') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'col.templates.core',
       (
         SELECT COUNT(*)::text FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_shift_templates'
           AND column_name IN (
             'id','name','start_time','end_time','break_minutes','cross_midnight',
             'late_grace_minutes','early_leave_grace_minutes','enabled',
             'created_by','updated_by','created_at','updated_at'
           )
       ), '13',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'attendance_shift_templates'
           AND column_name IN (
             'id','name','start_time','end_time','break_minutes','cross_midnight',
             'late_grace_minutes','early_leave_grace_minutes','enabled',
             'created_by','updated_by','created_at','updated_at'
           )
       ) = 13 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'col.schedules.snapshot',
       (
         SELECT COUNT(*)::text FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules'
           AND column_name IN (
             'shift_template_id','shift_name_snapshot','scheduled_start_time','scheduled_end_time',
             'scheduled_break_minutes','scheduled_cross_midnight',
             'scheduled_late_grace_minutes','scheduled_early_leave_grace_minutes'
           )
       ), '8',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'employee_schedules'
           AND column_name IN (
             'shift_template_id','shift_name_snapshot','scheduled_start_time','scheduled_end_time',
             'scheduled_break_minutes','scheduled_cross_midnight',
             'scheduled_late_grace_minutes','scheduled_early_leave_grace_minutes'
           )
       ) = 8 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'idx.templates.name_ci',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'attendance_shift_templates'
           AND indexname = 'attendance_shift_templates_name_ci_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'attendance_shift_templates'
           AND indexname = 'attendance_shift_templates_name_ci_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'uq.schedules.user_date',
       (EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'employee_schedules'
           AND c.conname = 'employee_schedules_user_date_uidx'
           AND c.contype = 'u'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND t.relname = 'employee_schedules'
           AND c.conname = 'employee_schedules_user_date_uidx'
           AND c.contype = 'u'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rls.enabled_both',
       (
         SELECT COUNT(*)::text FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('attendance_shift_templates','employee_schedules')
           AND c.relrowsecurity
       ), '2',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('attendance_shift_templates','employee_schedules')
           AND c.relrowsecurity
       ) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'grant.anon_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee IN ('PUBLIC','anon')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee IN ('PUBLIC','anon')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'grant.authenticated_write_none',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'grant.authenticated_select',
       (
         SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ), '2',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shift_templates','employee_schedules')
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'policy.write_none',
       (NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('attendance_shift_templates','employee_schedules')
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('attendance_shift_templates','employee_schedules')
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'policy.templates_admin_select',
       (EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shift_templates'
           AND policyname = 'attendance_shift_templates_select_admin'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%is_admin%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shift_templates'
           AND policyname = 'attendance_shift_templates_select_admin'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%is_admin%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'policy.schedules_staff_own',
       (EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_schedules'
           AND policyname = 'employee_schedules_select_own'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%auth.uid%'
           AND COALESCE(qual, '') ILIKE '%user_id%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_schedules'
           AND policyname = 'employee_schedules_select_own'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%auth.uid%'
           AND COALESCE(qual, '') ILIKE '%user_id%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'policy.schedules_admin_select',
       (EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_schedules'
           AND policyname = 'employee_schedules_select_admin'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%is_admin%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'employee_schedules'
           AND policyname = 'employee_schedules_select_admin'
           AND cmd = 'SELECT'
           AND COALESCE(qual, '') ILIKE '%is_admin%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'rpc.create_template',
       (to_regprocedure('public.backoffice_create_attendance_shift_template(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_attendance_shift_template(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'rpc.update_template',
       (to_regprocedure('public.backoffice_update_attendance_shift_template(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_attendance_shift_template(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'rpc.upsert_schedule',
       (to_regprocedure('public.backoffice_upsert_employee_schedule(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_upsert_employee_schedule(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'rpc.delete_schedule',
       (to_regprocedure('public.backoffice_delete_employee_schedule(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_delete_employee_schedule(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'rpc.create_security_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_attendance_shift_template'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_attendance_shift_template'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'rpc.upsert_search_path',
       (COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_employee_schedule'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_employee_schedule'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'exec.create_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_attendance_shift_template(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_create_attendance_shift_template(jsonb)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'exec.create_anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_attendance_shift_template(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_create_attendance_shift_template(jsonb)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'exec.helper_admin_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_schedule_require_admin()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_schedule_require_admin()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'exec.taiwan_today_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_taiwan_today()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_attendance_taiwan_today()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'rpc.create_has_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_attendance_shift_template'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_schedule_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_create_attendance_shift_template'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'rpc.upsert_copies_snapshot',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%shift_name_snapshot%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_tpl.start_time%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_employee_schedule'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%shift_name_snapshot%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_tpl.start_time%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_upsert_employee_schedule'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'clock_in_gps_unchanged_signature',
       (to_regprocedure('public.attendance_clock_in(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'clock_out_gps_unchanged_signature',
       (to_regprocedure('public.attendance_clock_out(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_out(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'break_start_gps_unchanged_signature',
       (to_regprocedure('public.attendance_break_start(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_start(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'break_end_gps_unchanged_signature',
       (to_regprocedure('public.attendance_break_end(double precision,double precision,double precision)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_end(double precision,double precision,double precision)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'clock_in_company_network_unchanged',
       (to_regprocedure('public.attendance_clock_in_company_network(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in_company_network(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'clock_out_company_network_unchanged',
       (to_regprocedure('public.attendance_clock_out_company_network(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_out_company_network(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'break_start_company_network_unchanged',
       (to_regprocedure('public.attendance_break_start_company_network(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_start_company_network(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'break_end_company_network_unchanged',
       (to_regprocedure('public.attendance_break_end_company_network(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_end_company_network(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'no_hard_delete_template_rpc',
       (to_regprocedure('public.backoffice_delete_attendance_shift_template(uuid)') IS NULL
        AND to_regprocedure('public.backoffice_delete_attendance_shift_template(jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_delete_attendance_shift_template(uuid)') IS NULL
            AND to_regprocedure('public.backoffice_delete_attendance_shift_template(jsonb)') IS NULL
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'no_salary_tables',
       (to_regclass('public.employee_compensation') IS NULL
        AND to_regclass('public.payroll_runs') IS NULL
        AND to_regclass('public.payroll_items') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.employee_compensation') IS NULL
            AND to_regclass('public.payroll_runs') IS NULL
            AND to_regclass('public.payroll_items') IS NULL
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'helper.taiwan_today_not_current_date',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%Asia/Taipei%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%CURRENT_DATE%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_taiwan_today'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%Asia/Taipei%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%CURRENT_DATE%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'dk_attendance_taiwan_today'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'exec.update_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_update_attendance_shift_template(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_update_attendance_shift_template(jsonb)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'exec.upsert_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_upsert_employee_schedule(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_upsert_employee_schedule(jsonb)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'exec.delete_schedule_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_delete_employee_schedule(uuid)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_delete_employee_schedule(uuid)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'exec.upsert_anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_upsert_employee_schedule(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_upsert_employee_schedule(jsonb)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
