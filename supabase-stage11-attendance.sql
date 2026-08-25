-- ============================================================
-- DK Computer Stage 11-1：Employee Attendance Foundation
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解語句；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會建表、改 RLS、建 RPC。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_RLS → M2_RPC → M3_VERIFY
-- ROLLBACK 僅在需要撤 Stage 11 時使用。
--
-- 禁止：
--   改 profiles / auth schema
--   改 is_admin() / is_enabled_backoffice_user() / dk_require_backoffice() 語意
--   碰 inventory* / orders* / v2_data / site_config / Storage
--   改 Stage 7 RPC
--   信任 client employee_id / client timestamp / client role
--   把 +08:00 寫死進資料模型
--   新增可被 client 修改的 worked_hours 欄位
--
-- employee 模型（既有，不改）：
--   public.profiles.id UUID PK = auth.users.id
--   role TEXT CHECK IN ('admin','staff')
--   enabled BOOLEAN
--   public.is_admin()：auth.uid() 且 role=admin 且 enabled=true
--   public.is_enabled_backoffice_user()：auth.uid() 且 enabled 且 role IN admin/staff
--   public.dk_require_backoffice()：回傳 role；未登入／停用／非後台 → exception
--
-- 工時（推導，不落地）：
--   worked = (COALESCE(clock_out_at, now()) - clock_in_at)
--            - SUM(completed breaks: break_end_at - break_start_at)
--   open break 不計入扣減，直到 BREAK_END。
--   UI 顯示時區：Asia/Taipei（應用層 AT TIME ZONE，不寫進 schema）。
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 profiles / 既有 helper / Stage 7 表仍在，且 Stage 11 物件尚未誤建。
-- 請複製本 SECTION（從下一行到 PREFLIGHT END）單獨執行。
-- ============================================================
/*

SELECT 'profiles' AS obj,
       (to_regclass('public.profiles') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.profiles') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'is_admin()',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_enabled_backoffice_user()',
       (to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_require_backoffice()',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage7.inventory_items',
       (to_regclass('public.inventory_items') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_items') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage7.orders',
       (to_regclass('public.orders') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.orders') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage7.v2_data_archive',
       (to_regclass('public.v2_data') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.v2_data') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'attendance_shifts_absent_before_m0',
       (to_regclass('public.attendance_shifts') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_shifts') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'attendance_breaks_absent_before_m0',
       (to_regclass('public.attendance_breaks') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_breaks') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'attendance_audit_logs_absent_before_m0',
       (to_regclass('public.attendance_audit_logs') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_audit_logs') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'attendance_clock_in_absent_before_m2',
       (to_regprocedure('public.attendance_clock_in()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in()') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
ORDER BY 1;

-- profiles 欄位（確認 employee_id 應對 profiles.id = auth.users.id）
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
  AND column_name IN ('id', 'role', 'enabled')
ORDER BY column_name;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- 建 3 表 + constraints + indexes + integrity triggers。
-- ENABLE RLS + REVOKE client（fail-closed；policy 在 M1）。
-- 不建 RPC。不碰 Stage 7 / profiles schema。
-- 請複製本 SECTION（從下一行到 M0_SCHEMA END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.profiles missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
     OR to_regprocedure('public.dk_require_backoffice()') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: is_admin / is_enabled_backoffice_user / dk_require_backoffice missing.';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.attendance_shifts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  clock_in_at timestamptz NOT NULL,
  clock_out_at timestamptz NULL,
  status text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT attendance_shifts_status_ck
    CHECK (status IN ('open', 'closed')),
  CONSTRAINT attendance_shifts_open_closed_ck
    CHECK (
      (status = 'open' AND clock_out_at IS NULL)
      OR (status = 'closed' AND clock_out_at IS NOT NULL)
    ),
  CONSTRAINT attendance_shifts_clock_range_ck
    CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at),
  CONSTRAINT attendance_shifts_source_ck
    CHECK (source IS NULL OR source IN ('staff_rpc', 'admin_correction')),
  CONSTRAINT attendance_shifts_extra_object_ck
    CHECK (pg_catalog.jsonb_typeof(extra) = 'object')
);

CREATE TABLE IF NOT EXISTS public.attendance_breaks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.attendance_shifts(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  break_start_at timestamptz NOT NULL,
  break_end_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT attendance_breaks_range_ck
    CHECK (break_end_at IS NULL OR break_end_at >= break_start_at),
  CONSTRAINT attendance_breaks_extra_object_ck
    CHECK (pg_catalog.jsonb_typeof(extra) = 'object')
);

CREATE TABLE IF NOT EXISTS public.attendance_audit_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  shift_id uuid NOT NULL REFERENCES public.attendance_shifts(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT attendance_audit_action_ck
    CHECK (action IN ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END', 'ADMIN_CORRECTION')),
  CONSTRAINT attendance_audit_correction_reason_ck
    CHECK (
      action <> 'ADMIN_CORRECTION'
      OR (reason IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(reason)) > 0)
    )
);

CREATE INDEX IF NOT EXISTS attendance_shifts_employee_id_idx
  ON public.attendance_shifts (employee_id);
CREATE INDEX IF NOT EXISTS attendance_shifts_clock_in_at_idx
  ON public.attendance_shifts (clock_in_at);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_shifts_one_open_per_employee_uidx
  ON public.attendance_shifts (employee_id)
  WHERE clock_out_at IS NULL;

CREATE INDEX IF NOT EXISTS attendance_breaks_shift_id_idx
  ON public.attendance_breaks (shift_id);
CREATE INDEX IF NOT EXISTS attendance_breaks_employee_id_idx
  ON public.attendance_breaks (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS attendance_breaks_one_open_per_shift_uidx
  ON public.attendance_breaks (shift_id)
  WHERE break_end_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_breaks_one_open_per_employee_uidx
  ON public.attendance_breaks (employee_id)
  WHERE break_end_at IS NULL;

CREATE INDEX IF NOT EXISTS attendance_audit_logs_employee_id_idx
  ON public.attendance_audit_logs (employee_id);
CREATE INDEX IF NOT EXISTS attendance_audit_logs_shift_id_idx
  ON public.attendance_audit_logs (shift_id);
CREATE INDEX IF NOT EXISTS attendance_audit_logs_created_at_idx
  ON public.attendance_audit_logs (created_at);

COMMENT ON TABLE public.attendance_shifts IS 'Stage 11 employee shifts; open = clock_out_at IS NULL; times are timestamptz; no stored worked_hours';
COMMENT ON TABLE public.attendance_breaks IS 'Stage 11 breaks; open = break_end_at IS NULL; employee_id must match parent shift';
COMMENT ON TABLE public.attendance_audit_logs IS 'Stage 11 append-only attendance audit; independent from public.audit_logs';
COMMENT ON COLUMN public.attendance_shifts.clock_in_at IS 'timestamptz; staff RPC uses server now(); UI displays Asia/Taipei';
COMMENT ON COLUMN public.attendance_shifts.employee_id IS 'profiles.id = auth.users.id; staff RPC ignores client employee_id';

CREATE OR REPLACE FUNCTION public.dk_attendance_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_shifts_set_updated_at ON public.attendance_shifts;
CREATE TRIGGER trg_attendance_shifts_set_updated_at
  BEFORE UPDATE ON public.attendance_shifts
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_breaks_set_updated_at ON public.attendance_breaks;
CREATE TRIGGER trg_attendance_breaks_set_updated_at
  BEFORE UPDATE ON public.attendance_breaks
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_set_updated_at();

CREATE OR REPLACE FUNCTION public.dk_attendance_breaks_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_emp uuid;
  v_in timestamptz;
  v_out timestamptz;
BEGIN
  SELECT s.employee_id, s.clock_in_at, s.clock_out_at
    INTO v_emp, v_in, v_out
  FROM public.attendance_shifts s
  WHERE s.id = NEW.shift_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;
  IF NEW.employee_id IS DISTINCT FROM v_emp THEN
    RAISE EXCEPTION 'break employee must match shift';
  END IF;
  IF TG_OP = 'INSERT' AND v_out IS NOT NULL THEN
    RAISE EXCEPTION 'shift closed';
  END IF;
  IF NEW.break_start_at < v_in THEN
    RAISE EXCEPTION 'invalid break range';
  END IF;
  IF NEW.break_end_at IS NOT NULL AND v_out IS NOT NULL AND NEW.break_end_at > v_out THEN
    RAISE EXCEPTION 'invalid break range';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_breaks_integrity ON public.attendance_breaks;
CREATE TRIGGER trg_attendance_breaks_integrity
  BEFORE INSERT OR UPDATE ON public.attendance_breaks
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_breaks_integrity();

CREATE OR REPLACE FUNCTION public.dk_attendance_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'attendance_audit_logs is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_audit_logs_immutable ON public.attendance_audit_logs;
CREATE TRIGGER trg_attendance_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.attendance_audit_logs
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_attendance_audit_immutable();

ALTER TABLE public.attendance_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_shifts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.attendance_breaks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.attendance_audit_logs FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.dk_attendance_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_breaks_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_audit_immutable() FROM PUBLIC, anon, authenticated;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- GRANT SELECT + policies。staff 只能讀自己的 shift/break。
-- 無 INSERT/UPDATE/DELETE policy；authenticated 無表寫入 GRANT。
-- audit：僅 admin SELECT。anon DENY。
-- 請複製本 SECTION（從下一行到 M1_RLS END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_shifts') IS NULL
     OR to_regclass('public.attendance_breaks') IS NULL
     OR to_regclass('public.attendance_audit_logs') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: Stage 11 tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M1_RLS blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

ALTER TABLE public.attendance_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.attendance_shifts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.attendance_breaks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.attendance_audit_logs FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.attendance_shifts TO authenticated;
GRANT SELECT ON TABLE public.attendance_breaks TO authenticated;
GRANT SELECT ON TABLE public.attendance_audit_logs TO authenticated;

DROP POLICY IF EXISTS attendance_shifts_select_own ON public.attendance_shifts;
DROP POLICY IF EXISTS attendance_shifts_select_admin ON public.attendance_shifts;
CREATE POLICY attendance_shifts_select_own
  ON public.attendance_shifts
  FOR SELECT
  TO authenticated
  USING (
    employee_id = (SELECT auth.uid())
    AND public.is_enabled_backoffice_user()
  );
CREATE POLICY attendance_shifts_select_admin
  ON public.attendance_shifts
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS attendance_breaks_select_own ON public.attendance_breaks;
DROP POLICY IF EXISTS attendance_breaks_select_admin ON public.attendance_breaks;
CREATE POLICY attendance_breaks_select_own
  ON public.attendance_breaks
  FOR SELECT
  TO authenticated
  USING (
    employee_id = (SELECT auth.uid())
    AND public.is_enabled_backoffice_user()
  );
CREATE POLICY attendance_breaks_select_admin
  ON public.attendance_breaks
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS attendance_audit_logs_select_admin ON public.attendance_audit_logs;
CREATE POLICY attendance_audit_logs_select_admin
  ON public.attendance_audit_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_RPC
-- staff 打卡走 RPC；時間 = server now()；employee = auth.uid()。
-- admin correction 必填 reason，寫 before/after snapshot。
-- SECURITY DEFINER + search_path=''。
-- 請複製本 SECTION（從下一行到 M2_RPC END）單獨執行。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.attendance_shifts') IS NULL
     OR to_regclass('public.attendance_breaks') IS NULL
     OR to_regclass('public.attendance_audit_logs') IS NULL
  THEN
    RAISE EXCEPTION 'M2_RPC blocked: Stage 11 tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
  THEN
    RAISE EXCEPTION 'M2_RPC blocked: dk_require_backoffice / is_admin missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_attendance_shift_snapshot(p_shift_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'shift', pg_catalog.to_jsonb(s),
    'breaks', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b) ORDER BY b.break_start_at, b.id)
      FROM public.attendance_breaks b
      WHERE b.shift_id = s.id
    ), '[]'::jsonb)
  )
  FROM public.attendance_shifts s
  WHERE s.id = p_shift_id;
$$;

CREATE OR REPLACE FUNCTION public.dk_attendance_write_audit(
  p_actor uuid,
  p_employee uuid,
  p_shift uuid,
  p_action text,
  p_reason text,
  p_before jsonb,
  p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.attendance_audit_logs (
    actor_user_id, employee_id, shift_id, action, reason, before_snapshot, after_snapshot, created_at
  ) VALUES (
    p_actor, p_employee, p_shift, p_action, p_reason, p_before, p_after, pg_catalog.now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_attendance_shift_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_attendance_write_audit(uuid, uuid, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.attendance_clock_in()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_shift_id uuid;
  v_now timestamptz;
  v_after jsonb;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  v_now := pg_catalog.now();

  PERFORM 1 FROM public.profiles p WHERE p.id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_shifts s
    WHERE s.employee_id = v_uid AND s.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'open shift already exists';
  END IF;

  INSERT INTO public.attendance_shifts (
    employee_id, clock_in_at, clock_out_at, status, source, created_by, updated_by
  ) VALUES (
    v_uid, v_now, NULL, 'open', 'staff_rpc', v_uid, v_uid
  )
  RETURNING id INTO v_shift_id;

  v_after := public.dk_attendance_shift_snapshot(v_shift_id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, v_uid, v_shift_id, 'CLOCK_IN', NULL, NULL, v_after
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_shift_id,
    'status', 'open',
    'clock_in_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_clock_out()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_shift public.attendance_shifts%ROWTYPE;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  v_now := pg_catalog.now();

  SELECT * INTO v_shift
  FROM public.attendance_shifts s
  WHERE s.employee_id = v_uid AND s.clock_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_breaks b
    WHERE b.shift_id = v_shift.id AND b.break_end_at IS NULL
  ) THEN
    RAISE EXCEPTION 'open break exists';
  END IF;

  IF v_now < v_shift.clock_in_at THEN
    RAISE EXCEPTION 'invalid clock range';
  END IF;

  v_before := public.dk_attendance_shift_snapshot(v_shift.id);

  UPDATE public.attendance_shifts
  SET clock_out_at = v_now,
      status = 'closed',
      updated_by = v_uid
  WHERE id = v_shift.id;

  v_after := public.dk_attendance_shift_snapshot(v_shift.id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, v_uid, v_shift.id, 'CLOCK_OUT', NULL, v_before, v_after
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_shift.id,
    'status', 'closed',
    'clock_out_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_break_start()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_shift public.attendance_shifts%ROWTYPE;
  v_break_id uuid;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  v_now := pg_catalog.now();

  SELECT * INTO v_shift
  FROM public.attendance_shifts s
  WHERE s.employee_id = v_uid AND s.clock_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open shift';
  END IF;
  IF v_shift.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'shift closed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.attendance_breaks b
    WHERE b.shift_id = v_shift.id AND b.break_end_at IS NULL
  ) THEN
    RAISE EXCEPTION 'open break already exists';
  END IF;

  IF v_now < v_shift.clock_in_at THEN
    RAISE EXCEPTION 'invalid break range';
  END IF;

  v_before := public.dk_attendance_shift_snapshot(v_shift.id);

  INSERT INTO public.attendance_breaks (
    shift_id, employee_id, break_start_at, break_end_at
  ) VALUES (
    v_shift.id, v_uid, v_now, NULL
  )
  RETURNING id INTO v_break_id;

  v_after := public.dk_attendance_shift_snapshot(v_shift.id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, v_uid, v_shift.id, 'BREAK_START', NULL, v_before, v_after
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_break_id,
    'shift_id', v_shift.id,
    'break_start_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_break_end()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_break public.attendance_breaks%ROWTYPE;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_role := public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  v_now := pg_catalog.now();

  SELECT * INTO v_break
  FROM public.attendance_breaks b
  WHERE b.employee_id = v_uid AND b.break_end_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open break';
  END IF;

  PERFORM 1 FROM public.attendance_shifts s
  WHERE s.id = v_break.shift_id AND s.employee_id = v_uid AND s.clock_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no open shift';
  END IF;

  IF v_now < v_break.break_start_at THEN
    RAISE EXCEPTION 'invalid break range';
  END IF;

  v_before := public.dk_attendance_shift_snapshot(v_break.shift_id);

  UPDATE public.attendance_breaks
  SET break_end_at = v_now
  WHERE id = v_break.id;

  v_after := public.dk_attendance_shift_snapshot(v_break.shift_id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, v_uid, v_break.shift_id, 'BREAK_END', NULL, v_before, v_after
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_break.id,
    'shift_id', v_break.shift_id,
    'break_end_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_admin_correct(
  p_shift_id uuid,
  p_reason text,
  p_employee_id uuid DEFAULT NULL,
  p_clock_in_at timestamptz DEFAULT NULL,
  p_clock_out_at timestamptz DEFAULT NULL,
  p_break_id uuid DEFAULT NULL,
  p_break_start_at timestamptz DEFAULT NULL,
  p_break_end_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_uid uuid;
  v_shift public.attendance_shifts%ROWTYPE;
  v_break public.attendance_breaks%ROWTYPE;
  v_new_in timestamptz;
  v_new_out timestamptz;
  v_new_status text;
  v_b_start timestamptz;
  v_b_end timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_changed boolean := false;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := (SELECT auth.uid());

  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  IF p_shift_id IS NULL THEN
    RAISE EXCEPTION 'shift_id required';
  END IF;

  SELECT * INTO v_shift
  FROM public.attendance_shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found';
  END IF;

  IF p_employee_id IS NOT NULL AND p_employee_id IS DISTINCT FROM v_shift.employee_id THEN
    RAISE EXCEPTION 'employee mismatch';
  END IF;

  IF p_clock_in_at IS NULL AND p_clock_out_at IS NULL
     AND p_break_id IS NULL AND p_break_start_at IS NULL AND p_break_end_at IS NULL THEN
    RAISE EXCEPTION 'nothing to correct';
  END IF;

  v_before := public.dk_attendance_shift_snapshot(v_shift.id);

  v_new_in := COALESCE(p_clock_in_at, v_shift.clock_in_at);
  v_new_out := v_shift.clock_out_at;
  IF p_clock_out_at IS NOT NULL THEN
    v_new_out := p_clock_out_at;
  END IF;
  IF v_new_out IS NOT NULL AND v_new_out < v_new_in THEN
    RAISE EXCEPTION 'invalid clock range';
  END IF;
  v_new_status := CASE WHEN v_new_out IS NULL THEN 'open' ELSE 'closed' END;

  IF v_new_status = 'closed' THEN
    IF EXISTS (
      SELECT 1 FROM public.attendance_breaks b
      WHERE b.shift_id = v_shift.id
        AND b.break_end_at IS NULL
        AND (p_break_id IS NULL OR b.id IS DISTINCT FROM p_break_id OR p_break_end_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'open break exists';
    END IF;
  END IF;

  IF p_clock_in_at IS NOT NULL OR p_clock_out_at IS NOT NULL THEN
    UPDATE public.attendance_shifts
    SET clock_in_at = v_new_in,
        clock_out_at = v_new_out,
        status = v_new_status,
        source = 'admin_correction',
        updated_by = v_uid
    WHERE id = v_shift.id;
    v_changed := true;
  END IF;

  IF p_break_id IS NOT NULL THEN
    SELECT * INTO v_break
    FROM public.attendance_breaks b
    WHERE b.id = p_break_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'break not found';
    END IF;
    IF v_break.shift_id IS DISTINCT FROM v_shift.id THEN
      RAISE EXCEPTION 'break shift mismatch';
    END IF;
    v_b_start := COALESCE(p_break_start_at, v_break.break_start_at);
    v_b_end := v_break.break_end_at;
    IF p_break_end_at IS NOT NULL THEN
      v_b_end := p_break_end_at;
    END IF;
    IF v_b_end IS NOT NULL AND v_b_end < v_b_start THEN
      RAISE EXCEPTION 'invalid break range';
    END IF;
    UPDATE public.attendance_breaks
    SET break_start_at = v_b_start,
        break_end_at = v_b_end
    WHERE id = v_break.id;
    v_changed := true;
  ELSIF p_break_start_at IS NOT NULL OR p_break_end_at IS NOT NULL THEN
    RAISE EXCEPTION 'break_id required';
  END IF;

  IF NOT v_changed THEN
    RAISE EXCEPTION 'nothing to correct';
  END IF;

  v_after := public.dk_attendance_shift_snapshot(v_shift.id);
  PERFORM public.dk_attendance_write_audit(
    v_uid, v_shift.employee_id, v_shift.id, 'ADMIN_CORRECTION', pg_catalog.btrim(p_reason), v_before, v_after
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_shift.id,
    'status', v_new_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_clock_in() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_clock_in() TO authenticated;

REVOKE ALL ON FUNCTION public.attendance_clock_out() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_clock_out() TO authenticated;

REVOKE ALL ON FUNCTION public.attendance_break_start() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_break_start() TO authenticated;

REVOKE ALL ON FUNCTION public.attendance_break_end() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_break_end() TO authenticated;

REVOKE ALL ON FUNCTION public.attendance_admin_correct(uuid, text, uuid, timestamptz, timestamptz, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_admin_correct(uuid, text, uuid, timestamptz, timestamptz, uuid, timestamptz, timestamptz) TO authenticated;

*/

-- M2_RPC END


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀。不 INSERT / UPDATE / DELETE。
-- 請複製本 SECTION（從下一行到 M3_VERIFY END）單獨執行。
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_shifts' AS check_name,
       (to_regclass('public.attendance_shifts') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_shifts') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.attendance_breaks',
       (to_regclass('public.attendance_breaks') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_breaks') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.attendance_audit_logs',
       (to_regclass('public.attendance_audit_logs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.attendance_audit_logs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rls.enabled_all3',
       (
         SELECT COUNT(*)::text FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND c.relrowsecurity
       ), '3',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND c.relrowsecurity
       ) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'grant.anon_table_any',
       (
         SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND grantee IN ('PUBLIC','anon')
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND grantee IN ('PUBLIC','anon')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'grant.authenticated_write',
       (
         SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND grantee = 'authenticated'
           AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'grant.authenticated_select_shifts_breaks',
       (
         SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks')
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ), '2',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks')
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'grant.authenticated_select_audit',
       (
         SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name = 'attendance_audit_logs'
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ), '1',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name = 'attendance_audit_logs'
           AND grantee = 'authenticated'
           AND privilege_type = 'SELECT'
       ) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'policy.write_none',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'policy.staff_self_select_shifts',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_own' AND cmd = 'SELECT'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_own' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'policy.staff_self_select_breaks',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_own' AND cmd = 'SELECT'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_own' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'policy.admin_select_shifts',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_admin' AND cmd = 'SELECT'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_admin' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'policy.admin_select_breaks',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_admin' AND cmd = 'SELECT'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_admin' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'policy.audit_admin_only',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_audit_logs'
       ), '1',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_audit_logs'
       ) = 1
       AND EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_audit_logs'
           AND policyname = 'attendance_audit_logs_select_admin' AND cmd = 'SELECT'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'policy.staff_shifts_using_self',
       (
         SELECT COALESCE(qual, '') FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_own' AND cmd = 'SELECT'
       ), 'employee_id + auth.uid()',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_shifts'
           AND policyname = 'attendance_shifts_select_own' AND cmd = 'SELECT'
           AND qual ILIKE '%employee_id%'
           AND qual ILIKE '%auth.uid()%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'policy.staff_breaks_using_self',
       (
         SELECT COALESCE(qual, '') FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_own' AND cmd = 'SELECT'
       ), 'employee_id + auth.uid()',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'attendance_breaks'
           AND policyname = 'attendance_breaks_select_own' AND cmd = 'SELECT'
           AND qual ILIKE '%employee_id%'
           AND qual ILIKE '%auth.uid()%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'policy.admin_select_using_is_admin',
       (
         SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public'
           AND (
             (tablename = 'attendance_shifts' AND policyname = 'attendance_shifts_select_admin')
             OR (tablename = 'attendance_breaks' AND policyname = 'attendance_breaks_select_admin')
             OR (tablename = 'attendance_audit_logs' AND policyname = 'attendance_audit_logs_select_admin')
           )
           AND cmd = 'SELECT'
           AND qual ILIKE '%is_admin()%'
       ), '3',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public'
           AND (
             (tablename = 'attendance_shifts' AND policyname = 'attendance_shifts_select_admin')
             OR (tablename = 'attendance_breaks' AND policyname = 'attendance_breaks_select_admin')
             OR (tablename = 'attendance_audit_logs' AND policyname = 'attendance_audit_logs_select_admin')
           )
           AND cmd = 'SELECT'
           AND qual ILIKE '%is_admin()%'
       ) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'rpc.count5',
       (
         SELECT COUNT(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
       ), '5',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
       ) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'rpc.security_definer',
       (
         SELECT COUNT(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND p.prosecdef
       ), '5',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND p.prosecdef
       ) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'rpc.search_path_empty',
       (
         SELECT COUNT(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND p.proconfig IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM unnest(p.proconfig) cfg
             WHERE lower(cfg) LIKE 'search_path=%'
               AND replace(replace(btrim(substr(cfg, position('=' in cfg) + 1)), '"', ''), '''', '') = ''
           )
       ), '5',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND p.proconfig IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM unnest(p.proconfig) cfg
             WHERE lower(cfg) LIKE 'search_path=%'
               AND replace(replace(btrim(substr(cfg, position('=' in cfg) + 1)), '"', ''), '''', '') = ''
           )
       ) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'rpc.execute_authenticated',
       (
         SELECT COUNT(*)::text FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND grantee = 'authenticated'
           AND privilege_type = 'EXECUTE'
       ), '5',
       CASE WHEN (
         SELECT COUNT(*) FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct'
           )
           AND grantee = 'authenticated'
           AND privilege_type = 'EXECUTE'
       ) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'rpc.execute_public_or_anon',
       (
         SELECT COUNT(*)::text FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct',
             'dk_attendance_shift_snapshot','dk_attendance_write_audit'
           )
           AND grantee IN ('PUBLIC','anon')
           AND privilege_type = 'EXECUTE'
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN (
             'attendance_clock_in','attendance_clock_out','attendance_break_start',
             'attendance_break_end','attendance_admin_correct',
             'dk_attendance_shift_snapshot','dk_attendance_write_audit'
           )
           AND grantee IN ('PUBLIC','anon')
           AND privilege_type = 'EXECUTE'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'idx.open_shift_unique',
       (
         SELECT COUNT(*)::text FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_shifts'
           AND ic.relname = 'attendance_shifts_one_open_per_employee_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_shifts'
           AND ic.relname = 'attendance_shifts_one_open_per_employee_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'idx.open_break_unique_shift',
       (
         SELECT COUNT(*)::text FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND ic.relname = 'attendance_breaks_one_open_per_shift_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND ic.relname = 'attendance_breaks_one_open_per_shift_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 59, 'idx.open_break_unique_employee',
       (
         SELECT COUNT(*)::text FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND ic.relname = 'attendance_breaks_one_open_per_employee_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND ic.relname = 'attendance_breaks_one_open_per_employee_uidx'
           AND i.indisunique AND i.indpred IS NOT NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'ck.shift_clock_range',
       (
         SELECT COUNT(*)::text FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_shifts'
           AND con.conname = 'attendance_shifts_clock_range_ck'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_shifts'
           AND con.conname = 'attendance_shifts_clock_range_ck'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'ck.break_range',
       (
         SELECT COUNT(*)::text FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND con.conname = 'attendance_breaks_range_ck'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND con.conname = 'attendance_breaks_range_ck'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'ck.audit_correction_reason',
       (
         SELECT COUNT(*)::text FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_audit_logs'
           AND con.conname = 'attendance_audit_correction_reason_ck'
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_audit_logs'
           AND con.conname = 'attendance_audit_correction_reason_ck'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'rpc.helper_no_authenticated_execute',
       (
         SELECT COUNT(*)::text FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN ('dk_attendance_shift_snapshot','dk_attendance_write_audit')
           AND grantee = 'authenticated'
           AND privilege_type = 'EXECUTE'
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.routine_privileges
         WHERE routine_schema = 'public'
           AND routine_name IN ('dk_attendance_shift_snapshot','dk_attendance_write_audit')
           AND grantee = 'authenticated'
           AND privilege_type = 'EXECUTE'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'rpc.staff_clock_no_client_args',
       (
         SELECT COUNT(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out',
             'attendance_break_start','attendance_break_end'
           )
           AND p.pronargs = 0
       ), '4',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'attendance_clock_in','attendance_clock_out',
             'attendance_break_start','attendance_break_end'
           )
           AND p.pronargs = 0
       ) = 4 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'rpc.admin_correct_has_reason_arg',
       (
         SELECT COUNT(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'attendance_admin_correct'
           AND p.proargnames IS NOT NULL
           AND 'p_reason' = ANY (p.proargnames)
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'attendance_admin_correct'
           AND p.proargnames IS NOT NULL
           AND 'p_reason' = ANY (p.proargnames)
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'rpc.clock_identity_auth_uid',
       (
         SELECT COUNT(*)::text
         WHERE to_regprocedure('public.attendance_clock_in()') IS NOT NULL
           AND to_regprocedure('public.attendance_clock_out()') IS NOT NULL
           AND to_regprocedure('public.attendance_break_start()') IS NOT NULL
           AND to_regprocedure('public.attendance_break_end()') IS NOT NULL
           AND pg_get_functiondef(to_regprocedure('public.attendance_clock_in()')) ILIKE '%auth.uid()%'
           AND pg_get_functiondef(to_regprocedure('public.attendance_clock_out()')) ILIKE '%auth.uid()%'
           AND pg_get_functiondef(to_regprocedure('public.attendance_break_start()')) ILIKE '%auth.uid()%'
           AND pg_get_functiondef(to_regprocedure('public.attendance_break_end()')) ILIKE '%auth.uid()%'
       ), '1',
       CASE WHEN to_regprocedure('public.attendance_clock_in()') IS NOT NULL
         AND to_regprocedure('public.attendance_clock_out()') IS NOT NULL
         AND to_regprocedure('public.attendance_break_start()') IS NOT NULL
         AND to_regprocedure('public.attendance_break_end()') IS NOT NULL
         AND pg_get_functiondef(to_regprocedure('public.attendance_clock_in()')) ILIKE '%auth.uid()%'
         AND pg_get_functiondef(to_regprocedure('public.attendance_clock_out()')) ILIKE '%auth.uid()%'
         AND pg_get_functiondef(to_regprocedure('public.attendance_break_start()')) ILIKE '%auth.uid()%'
         AND pg_get_functiondef(to_regprocedure('public.attendance_break_end()')) ILIKE '%auth.uid()%'
       THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'rpc.admin_correct_no_employee_reassign',
       (
         SELECT COUNT(*)::text
         WHERE to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)') IS NOT NULL
           AND pg_get_functiondef(to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)'))
               ILIKE '%p_employee_id IS DISTINCT FROM%'
       ), '1',
       CASE WHEN to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)') IS NOT NULL
         AND pg_get_functiondef(to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)'))
             ILIKE '%p_employee_id IS DISTINCT FROM%'
       THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 55, 'trigger.audit_immutable',
       (
         SELECT COUNT(*)::text FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_audit_logs'
           AND t.tgname = 'trg_attendance_audit_logs_immutable' AND NOT t.tgisinternal
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_audit_logs'
           AND t.tgname = 'trg_attendance_audit_logs_immutable' AND NOT t.tgisinternal
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 56, 'trigger.break_integrity',
       (
         SELECT COUNT(*)::text FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND t.tgname = 'trg_attendance_breaks_integrity' AND NOT t.tgisinternal
       ), '1',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'attendance_breaks'
           AND t.tgname = 'trg_attendance_breaks_integrity' AND NOT t.tgisinternal
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'col.no_worked_hours',
       (
         SELECT COUNT(*)::text FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND column_name IN ('worked_hours','workedHours','hours')
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND column_name IN ('worked_hours','workedHours','hours')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'stage7.tables_untouched_exist',
       (
         SELECT COUNT(*)::text FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','v2_data'
           )
       ), '9',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','v2_data'
           )
       ) = 9 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'stage7.no_attendance_fk_into_orders',
       (
         SELECT COUNT(*)::text FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class f ON f.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = f.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND con.contype = 'f'
           AND fn.nspname = 'public'
           AND f.relname IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','v2_data','site_config'
           )
       ), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class f ON f.oid = con.confrelid
         JOIN pg_namespace fn ON fn.oid = f.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('attendance_shifts','attendance_breaks','attendance_audit_logs')
           AND con.contype = 'f'
           AND fn.nspname = 'public'
           AND f.relname IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','v2_data','site_config'
           )
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'stage7.inventory_items_exist',
       (to_regclass('public.inventory_items') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_items') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'stage7.orders_exist',
       (to_regclass('public.orders') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.orders') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 74, 'stage7.v2_data_exist',
       (to_regclass('public.v2_data') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.v2_data') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 75, 'rpc.exists.attendance_clock_in',
       (to_regprocedure('public.attendance_clock_in()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_in()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 76, 'rpc.exists.attendance_clock_out',
       (to_regprocedure('public.attendance_clock_out()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_clock_out()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 77, 'rpc.exists.attendance_break_start',
       (to_regprocedure('public.attendance_break_start()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_start()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 78, 'rpc.exists.attendance_break_end',
       (to_regprocedure('public.attendance_break_end()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_break_end()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 79, 'rpc.exists.attendance_admin_correct',
       (to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.attendance_admin_correct(uuid,text,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END


-- ============================================================
-- SECTION ROLLBACK
-- 只撤 Stage 11 新物件。禁止碰 profiles / auth / inventory* / orders* /
-- v2_data / site_config / Storage。
-- 請複製本 SECTION（從下一行到 ROLLBACK END）單獨執行。
-- ============================================================
/*

DROP FUNCTION IF EXISTS public.attendance_admin_correct(uuid, text, uuid, timestamptz, timestamptz, uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.attendance_break_end();
DROP FUNCTION IF EXISTS public.attendance_break_start();
DROP FUNCTION IF EXISTS public.attendance_clock_out();
DROP FUNCTION IF EXISTS public.attendance_clock_in();
DROP FUNCTION IF EXISTS public.dk_attendance_write_audit(uuid, uuid, uuid, text, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.dk_attendance_shift_snapshot(uuid);

DROP TRIGGER IF EXISTS trg_attendance_audit_logs_immutable ON public.attendance_audit_logs;
DROP TRIGGER IF EXISTS trg_attendance_breaks_integrity ON public.attendance_breaks;
DROP TRIGGER IF EXISTS trg_attendance_breaks_set_updated_at ON public.attendance_breaks;
DROP TRIGGER IF EXISTS trg_attendance_shifts_set_updated_at ON public.attendance_shifts;

DROP FUNCTION IF EXISTS public.dk_attendance_audit_immutable();
DROP FUNCTION IF EXISTS public.dk_attendance_breaks_integrity();
DROP FUNCTION IF EXISTS public.dk_attendance_set_updated_at();

DROP TABLE IF EXISTS public.attendance_audit_logs;
DROP TABLE IF EXISTS public.attendance_breaks;
DROP TABLE IF EXISTS public.attendance_shifts;

*/

-- ROLLBACK END
