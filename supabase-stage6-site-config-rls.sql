-- ============================================================
-- DK Computer Stage 6-5-2：public.site_config
-- JWT admin WRITE 零停機兩階段切換（Phase C1 / C2）
--
-- 本檔禁止修改其他表、schema USAGE、service_role。
-- 禁止修改 public.is_admin()。
-- 禁止 DROP / 改 Storage、inventory、v2_data、vendor_quotes、purchase_orders。
-- 禁止刪 site_config row、禁止改 data、禁止加回 password。
-- 禁止本對話執行本檔。C2 與 R 預設不執行。
--
-- 依賴：public.is_admin()（Stage 2）
--
-- 複製方式：
--   每一個 SECTION 都是完整可執行 SQL。
--   請只複製該 SECTION 到 SQL Editor，不要整份一次跑完。
--
-- 正確順序：
--   1) 複製執行 C1（建立 anon 過渡 ALL + authenticated admin WRITE；不收 anon）
--   2) 確認公開頁 anon GET 仍 200（Banner / Logo / LINE / shop）
--   3) commit + push JWT 前端（saveSiteConfigToSupabase 改 user JWT）
--   4) 等 GitHub Pages 部署
--   5) 正式站 admin：前台設定 / 廠商清單 / Logo / Banner
--   6) staff：前台管理仍不可見；若繞前端應 permission_denied
--   7) 僅在 JWT WRITE 驗證通過後，才複製執行 C2
--
-- C1 必須同時支援：
--   舊路徑 anon SELECT + anon WRITE
--   新路徑 admin JWT SELECT/INSERT/UPDATE/DELETE
--
-- 正式 DB 可能是：
--   A) RLS 已 ENABLE 且有 legacy anon / PUBLIC policy
--   B) RLS 原本未 ENABLE
--   C) PUBLIC FOR ALL（會套到 anon 與 authenticated）
-- C1 在 ENABLE RLS 前先建立 anon 過渡 policy，避免公開 GET／舊 WRITE 中斷。
-- 不得 DROP 現有 legacy policy。不得 REVOKE anon。
-- ============================================================


-- ============================================================
-- 正式 C1 後已確認 7 條 policy（見 SECTION C2）。
-- C2 只 DROP 已確認的 PUBLIC/anon WRITE，不猜其他名字。
-- ============================================================

-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'site_config'
-- ORDER BY policyname;
--
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name = 'site_config'
--   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
-- ORDER BY grantee, privilege_type;


-- ============================================================
-- SECTION C1
-- site_config Phase 1
-- ADD AUTHENTICATED ADMIN ACCESS — KEEP ANON SELECT+WRITE
--
-- 請複製本 SECTION（從下一行到 C1 END）單獨執行。
-- 不 DROP 任何現有 anon / PUBLIC policy。
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.site_config') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-5-2 C1 中止：缺少 public.site_config。';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-5-2 C1 中止：缺少 public.is_admin()。請先完成 supabase-auth-stage2.sql。';
  END IF;
END $$;

-- 過渡 anon ALL：若目前 RLS 關閉，ENABLE 後仍要讓舊站 anon 讀寫。
-- 若已有 anon_all / PUBLIC FOR ALL，本 policy 並存（OR），不 DROP 舊的。
DROP POLICY IF EXISTS site_config_anon_transition_all ON public.site_config;
CREATE POLICY site_config_anon_transition_all
  ON public.site_config
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- 先給 anon 讀寫權限，再 ENABLE RLS，避免公開站中斷。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_config TO anon;

ALTER TABLE public.site_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_config_authenticated_select ON public.site_config;
DROP POLICY IF EXISTS site_config_admin_insert ON public.site_config;
DROP POLICY IF EXISTS site_config_admin_update ON public.site_config;
DROP POLICY IF EXISTS site_config_admin_delete ON public.site_config;

CREATE POLICY site_config_authenticated_select
  ON public.site_config
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY site_config_admin_insert
  ON public.site_config
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY site_config_admin_update
  ON public.site_config
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY site_config_admin_delete
  ON public.site_config
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- Phase C1：JWT admin 需要表權限。staff 只有 SELECT policy，沒有 WRITE policy。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_config TO authenticated;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'site_config'
ORDER BY policyname;

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'site_config'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, privilege_type;

-- ============================================================
-- C1 END
-- 停止。不要繼續執行下面的 SECTION。
-- anon SELECT + anon WRITE 此時必須仍然存在。
-- 不得改 data、不得刪 row。
-- ============================================================


-- ============================================================
-- SECTION C2
-- site_config Phase 2
-- REMOVE ANON / PUBLIC WRITE — KEEP ANON SELECT
--
-- 正式 C1 後已確認 7 條 policy：
--   必須保留：
--     public_read_site_config          PUBLIC SELECT
--     site_config_authenticated_select authenticated SELECT
--     site_config_admin_insert         authenticated INSERT + is_admin()
--     site_config_admin_update         authenticated UPDATE + is_admin()
--     site_config_admin_delete         authenticated DELETE + is_admin()
--   本 C2 只 DROP：
--     public_write_site_config         PUBLIC ALL（WRITE）
--     site_config_anon_transition_all  anon ALL（WRITE）
--
-- 整份貼上不會執行本區（包在區塊註解內）。
-- 執行時：複製 /* 與 */ 之間的完整 SQL，單獨貼上。
-- 預設不要執行。
--
-- 順序：先確保 SELECT policy + GRANT SELECT，再 DROP WRITE，再 REVOKE。
-- 禁止拿掉公開 SELECT。禁止拆表。禁止改 data。禁止刪 row。
--
-- 最終狀態：
--   anon            SELECT only
--   authenticated   SELECT / INSERT / UPDATE / DELETE only（無 TRUNCATE / REFERENCES / TRIGGER）
--   is_admin()      控制 row WRITE
--   PUBLIC          不得有 WRITE，亦不得留 REFERENCES / TRIGGER / TRUNCATE
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.site_config') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 public.site_config。';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 public.is_admin()。';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'site_config'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：public.site_config RLS 未 ENABLE。';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_config'
      AND policyname = 'site_config_authenticated_select'
  ) THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 site_config_authenticated_select。請先完成 C1。';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_config'
      AND policyname = 'site_config_admin_insert'
  ) THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 site_config_admin_insert。請先完成 C1。';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_config'
      AND policyname = 'site_config_admin_update'
  ) THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 site_config_admin_update。請先完成 C1。';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_config'
      AND policyname = 'site_config_admin_delete'
  ) THEN
    RAISE EXCEPTION 'Stage 6-5-2 C2 中止：缺少 site_config_admin_delete。請先完成 C1。';
  END IF;
END $$;

-- 1) 先確保公開 SELECT，避免下一步 DROP FOR ALL 造成首頁 GET 空窗。
--    沿用既有 public_read_site_config（TO PUBLIC SELECT），不 DROP。
--    再加明確 TO anon SELECT。兩者並存（OR）無害。
DROP POLICY IF EXISTS site_config_public_select ON public.site_config;
CREATE POLICY site_config_public_select
  ON public.site_config
  FOR SELECT
  TO anon
  USING (true);

GRANT SELECT ON TABLE public.site_config TO anon;

-- 2) 再撤 WRITE policy。不碰 admin 四條、不碰 authenticated SELECT、不碰 public_read_site_config。
DROP POLICY IF EXISTS public_write_site_config ON public.site_config;
DROP POLICY IF EXISTS site_config_anon_transition_all ON public.site_config;

-- 3) 收 table privilege。
--    PUBLIC 的 GRANT 會被 anon / authenticated 繼承；只 REVOKE anon 不夠。
--    不對 anon 做 REVOKE ALL，以免瞬間拿掉 SELECT。
REVOKE ALL ON TABLE public.site_config FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.site_config FROM anon;
GRANT SELECT ON TABLE public.site_config TO anon;

-- authenticated 保留 SELECT/INSERT/UPDATE/DELETE；row WRITE 仍受 is_admin() policy。
-- staff 有 SELECT policy，沒有 WRITE policy。
-- 不保留 authenticated TRUNCATE / REFERENCES / TRIGGER（與正式最終 GRANT 對齊）。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_config TO authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.site_config FROM authenticated;

-- 驗證：policy（不 SELECT data）
SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'site_config'
ORDER BY policyname;

-- 驗證：table grants（anon 應只剩 SELECT）
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'site_config'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, privilege_type;

-- 驗證：row 數 / id（不輸出 data）
SELECT COUNT(*) AS row_count
FROM public.site_config;

SELECT id
FROM public.site_config
ORDER BY id;

-- 驗證：RLS 已 ENABLE
SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'site_config';

-- REST 行為驗證（在 SQL Editor 外、用 anon key，禁止動 id=default）：
--   GET  /rest/v1/site_config?id=eq.default&select=data     → 應 200
--   PATCH /rest/v1/site_config?id=eq.__dk_sc_probe_noexist__ → 應 401/403，不得 200 []
--   DELETE /rest/v1/site_config?id=eq.__dk_sc_probe_noexist__ → 應 401/403，不得 200 []
--   不可對真實 default row 做 PATCH / DELETE / 清空 data

*/



-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- 不得刪 row、不得改 data、不得加回 password、不得改其他表。
-- ============================================================

-- ------------------------------------------------------------
-- R-C2  緊急恢復「anon 可 WRITE」過渡（撤銷 Phase C2）
--       只恢復 TO anon FOR ALL，不恢復 PUBLIC FOR ALL。
--       不重建 public_write_site_config。
--       不 GRANT CRUD TO PUBLIC（避免 staff 經 PUBLIC policy 取得 WRITE）。
--       保留 admin policies、public_read_site_config、site_config_public_select。
--       不刪 row、不改 data。
-- R-C2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS site_config_anon_transition_all ON public.site_config;
-- CREATE POLICY site_config_anon_transition_all
--   ON public.site_config
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.site_config TO anon;
-- R-C2 COPY END

-- ------------------------------------------------------------
-- R-C1  緊急撤銷 authenticated site_config policies（撤銷 Phase C1）
--       不 DROP anon 過渡／legacy PUBLIC policy，避免公開站中斷。
-- R-C1 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS site_config_authenticated_select ON public.site_config;
-- DROP POLICY IF EXISTS site_config_admin_insert ON public.site_config;
-- DROP POLICY IF EXISTS site_config_admin_update ON public.site_config;
-- DROP POLICY IF EXISTS site_config_admin_delete ON public.site_config;
-- R-C1 COPY END
