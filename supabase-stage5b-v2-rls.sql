-- ============================================================
-- DK Computer Stage 5B：v2_data JWT 過渡保護
--
-- 本檔禁止修改其他表、schema USAGE、service_role。
-- 禁止破壞 public.is_admin()。
--
-- 過渡期安全界線（必須讀）：
--   staff 雖然 UI 看不到成本，authenticated staff 技術上仍能讀取
--   v2_data 整列 JSONB，包括：
--     cost_unit / ledger.unit_cost / cogs_total / expenses / auditLogs
--   這不是最終資料隔離。最終隔離要靠後續拆表。
--   禁止宣稱 Stage 5B「staff 已無法取得成本」。
--
-- 複製方式：每一個 SECTION 都是完整可執行 SQL。不要整份一次跑完。
--
-- 正確順序：
--   1) 複製執行 V1（保留 anon_all，新增 authenticated admin+staff）
--   2) 用目前正式舊站確認庫存＋記帳仍正常
--   3) commit + push JWT 前端
--   4) 等 GitHub Pages 部署
--   5) 正式站 admin / staff 測庫存／訂單，確認資料沒有遺失
--   6) 複製執行 V2（DROP anon_all，REVOKE anon）
--   7) 再測 admin / staff / anon
-- ============================================================


-- ============================================================
-- SECTION V1
-- v2_data Phase 1
-- ADD AUTHENTICATED BACKOFFICE ACCESS — KEEP ANON TEMPORARILY
--
-- 請複製本 SECTION（從下一行到 V1 END）單獨執行。
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5B V1 中止：缺少 public.is_admin()。請先完成 supabase-auth-stage2.sql。';
  END IF;
END $$;

-- enabled admin 或 staff。不取代 is_admin()。
-- SECURITY DEFINER + search_path=''：以擁有者讀 profiles，避免 RLS 遞迴。
CREATE OR REPLACE FUNCTION public.is_enabled_backoffice_user()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND enabled = true
      AND role IN ('admin', 'staff')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_enabled_backoffice_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_enabled_backoffice_user() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_enabled_backoffice_user() TO authenticated;

ALTER TABLE public.v2_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS v2_data_backoffice_select ON public.v2_data;
DROP POLICY IF EXISTS v2_data_backoffice_insert ON public.v2_data;
DROP POLICY IF EXISTS v2_data_backoffice_update ON public.v2_data;
DROP POLICY IF EXISTS v2_data_backoffice_delete ON public.v2_data;

CREATE POLICY v2_data_backoffice_select
  ON public.v2_data
  FOR SELECT
  TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY v2_data_backoffice_insert
  ON public.v2_data
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_enabled_backoffice_user());

CREATE POLICY v2_data_backoffice_update
  ON public.v2_data
  FOR UPDATE
  TO authenticated
  USING (public.is_enabled_backoffice_user())
  WITH CHECK (public.is_enabled_backoffice_user());

CREATE POLICY v2_data_backoffice_delete
  ON public.v2_data
  FOR DELETE
  TO authenticated
  USING (public.is_enabled_backoffice_user());

-- Phase 1：給 authenticated 表權限。保留 anon 既有 GRANT 與 anon_all。不 REVOKE anon。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.v2_data TO authenticated;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'v2_data'
ORDER BY policyname;

-- ============================================================
-- V1 END
-- 停止。不要繼續執行下面的 SECTION。
-- ============================================================


-- ============================================================
-- SECTION V2
-- v2_data Phase 2
-- REMOVE ANON ACCESS — RUN ONLY AFTER JWT VERIFIED
--
-- 整份貼上不會執行本區（包在區塊註解內）。
-- 執行時：複製 /* 與 */ 之間的完整 SQL，單獨貼上。
-- 僅在 V1 + JWT 前端 + admin/staff 正式測試 PASS 之後才跑。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.is_enabled_backoffice_user()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5B V2 中止：缺少 public.is_enabled_backoffice_user()。請先執行 V1。';
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_all" ON public.v2_data;

REVOKE ALL ON TABLE public.v2_data FROM anon;
REVOKE ALL ON TABLE public.v2_data FROM PUBLIC;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'v2_data'
ORDER BY policyname;

*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- ============================================================

-- ------------------------------------------------------------
-- R-V2  緊急恢復 v2_data anon（撤銷 Phase 2，保留 backoffice policy）
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS "anon_all" ON public.v2_data;
-- CREATE POLICY "anon_all"
--   ON public.v2_data
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- GRANT ALL ON TABLE public.v2_data TO anon;

-- ------------------------------------------------------------
-- R-V1  緊急撤銷 v2_data authenticated backoffice policy（撤銷 Phase 1）
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS v2_data_backoffice_select ON public.v2_data;
-- DROP POLICY IF EXISTS v2_data_backoffice_insert ON public.v2_data;
-- DROP POLICY IF EXISTS v2_data_backoffice_update ON public.v2_data;
-- DROP POLICY IF EXISTS v2_data_backoffice_delete ON public.v2_data;
-- DROP FUNCTION IF EXISTS public.is_enabled_backoffice_user();
