-- ============================================================
-- DK Computer Stage 6-3-2：public.inventory
-- JWT + RLS 零停機兩階段切換（Phase I1 / I2）
--
-- 本檔禁止修改其他表、schema USAGE、service_role。
-- 禁止修改 public.is_admin()。
-- 禁止本對話執行本檔。I2 與 R 預設不執行。
--
-- 依賴：public.is_admin()（Stage 2）
--
-- 複製方式：
--   每一個 SECTION 都是完整可執行 SQL。
--   請只複製該 SECTION 到 SQL Editor，不要整份一次跑完。
--
-- 正確順序：
--   1) 複製執行 I1（建立 anon 過渡 ALL + authenticated admin WRITE；不收 anon）
--   2) 用目前正式舊站確認首頁／整機／商品詳情仍可 GET
--   3) commit + push JWT 前端（upsert/delete 改 user JWT）
--   4) 等 GitHub Pages 部署
--   5) 正式站 admin：上架／編輯／下架
--   6) staff：上架管理仍不可見；若繞前端應 permission_denied
--   7) 僅在 JWT WRITE 驗證通過後，才複製執行 I2
--
-- I1 必須同時支援：
--   舊路徑 anon SELECT + anon WRITE
--   新路徑 admin JWT SELECT/INSERT/UPDATE/DELETE
--
-- 正式 DB 可能是：
--   A) RLS 已 ENABLE 且有 anon_all
--   B) RLS 原本未 ENABLE
-- I1 在 ENABLE RLS 前先建立 anon 過渡 policy，避免公開 GET／舊 WRITE 中斷。
-- 不得 DROP 現有 anon_all。不得 REVOKE anon。
--
-- 正式 I1 執行後另發現 legacy PUBLIC policies（I1 刻意未動，勿重跑 I1）：
--   public_read_inventory   TO PUBLIC  FOR SELECT
--   public_write_inventory  TO PUBLIC  FOR ALL
-- PUBLIC policy 會套用到 anon 與 authenticated。
-- 因此 I2 若只 DROP inventory_anon_transition_all，匿名 WRITE 仍會活著。
-- I2 必須 DROP 這兩條，改用明確 TO anon / TO authenticated。
-- ============================================================


-- ============================================================
-- SECTION I1
-- inventory Phase 1
-- ADD AUTHENTICATED ADMIN ACCESS — KEEP ANON SELECT+WRITE
--
-- 本 SECTION 已在正式 DB 執行成功。不要為了 legacy PUBLIC policy 重跑 I1。
-- public_read_inventory / public_write_inventory 留給 I2 處理。
--
-- 請複製本 SECTION（從下一行到 I1 END）單獨執行。
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.inventory') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-3-2 I1 中止：缺少 public.inventory。';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-3-2 I1 中止：缺少 public.is_admin()。請先完成 supabase-auth-stage2.sql。';
  END IF;
END $$;

-- 過渡 anon ALL：若目前 RLS 關閉，ENABLE 後仍要讓舊站 anon 讀寫。
-- 若已有 anon_all，本 policy 並存（OR），不 DROP anon_all。
-- 不 DROP public_read_inventory / public_write_inventory（I2 才處理）。
DROP POLICY IF EXISTS inventory_anon_transition_all ON public.inventory;
CREATE POLICY inventory_anon_transition_all
  ON public.inventory
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- 先給 anon 讀寫權限，再 ENABLE RLS，避免公開站中斷。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO anon;

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_authenticated_select ON public.inventory;
DROP POLICY IF EXISTS inventory_admin_insert ON public.inventory;
DROP POLICY IF EXISTS inventory_admin_update ON public.inventory;
DROP POLICY IF EXISTS inventory_admin_delete ON public.inventory;

CREATE POLICY inventory_authenticated_select
  ON public.inventory
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY inventory_admin_insert
  ON public.inventory
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY inventory_admin_update
  ON public.inventory
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY inventory_admin_delete
  ON public.inventory
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- Phase I1：JWT admin 需要表權限。staff 只有 SELECT policy，沒有 WRITE policy。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO authenticated;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'inventory'
ORDER BY policyname;

-- ============================================================
-- I1 END
-- 停止。不要繼續執行下面的 SECTION。
-- anon WRITE 此時必須仍然存在。
-- 已執行的正式 I1 不要重跑。legacy PUBLIC policies 由 I2 DROP。
-- ============================================================


-- ============================================================
-- SECTION I2
-- inventory Phase 2
-- REMOVE ANON / PUBLIC WRITE — KEEP ANON SELECT
--
-- 整份貼上不會執行本區（包在區塊註解內）。
-- 執行時：複製 /* 與 */ 之間的完整 SQL，單獨貼上。
-- 僅在正式站 JWT admin 上架／編輯／下架都 PASS 之後才跑。
-- 禁止拿掉 anon SELECT。
--
-- 最終狀態：
--   anon            SELECT only
--   authenticated   SELECT（staff + admin）
--   is_admin()      INSERT / UPDATE / DELETE
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.inventory') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-3-2 I2 中止：缺少 public.inventory。';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-3-2 I2 中止：缺少 public.is_admin()。';
  END IF;
END $$;

-- 先建立明確 SELECT，再 DROP legacy PUBLIC read，避免公開 GET 空窗。
DROP POLICY IF EXISTS inventory_public_select ON public.inventory;
CREATE POLICY inventory_public_select
  ON public.inventory
  FOR SELECT
  TO anon
  USING (true);

DROP POLICY IF EXISTS inventory_authenticated_select ON public.inventory;
CREATE POLICY inventory_authenticated_select
  ON public.inventory
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS inventory_admin_insert ON public.inventory;
CREATE POLICY inventory_admin_insert
  ON public.inventory
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS inventory_admin_update ON public.inventory;
CREATE POLICY inventory_admin_update
  ON public.inventory
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS inventory_admin_delete ON public.inventory;
CREATE POLICY inventory_admin_delete
  ON public.inventory
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- 封鎖匿名／PUBLIC WRITE。PUBLIC FOR ALL 會套到 anon 與 authenticated。
DROP POLICY IF EXISTS inventory_anon_transition_all ON public.inventory;
DROP POLICY IF EXISTS "anon_all" ON public.inventory;
DROP POLICY IF EXISTS public_write_inventory ON public.inventory;
DROP POLICY IF EXISTS public_read_inventory ON public.inventory;

REVOKE ALL ON TABLE public.inventory FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory FROM anon;
GRANT SELECT ON TABLE public.inventory TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO authenticated;

-- 安全驗證：只列 policy／GRANT，不 SELECT 商品內容。
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'inventory'
ORDER BY policyname;

SELECT
  grantee,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'inventory'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, privilege_type;

*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- ============================================================

-- ------------------------------------------------------------
-- R-I2  緊急恢復 I1 過渡期 anon／PUBLIC WRITE（撤銷 Phase I2，保留 admin policy）
--       恢復舊站上架所需的 WRITE 能力，不恢復任何密碼相關設定。
-- R-I2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS inventory_anon_transition_all ON public.inventory;
-- CREATE POLICY inventory_anon_transition_all
--   ON public.inventory
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- DROP POLICY IF EXISTS public_write_inventory ON public.inventory;
-- CREATE POLICY public_write_inventory
--   ON public.inventory
--   FOR ALL
--   TO PUBLIC
--   USING (true)
--   WITH CHECK (true);
-- DROP POLICY IF EXISTS public_read_inventory ON public.inventory;
-- CREATE POLICY public_read_inventory
--   ON public.inventory
--   FOR SELECT
--   TO PUBLIC
--   USING (true);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO anon;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO PUBLIC;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory TO authenticated;
-- R-I2 COPY END

-- ------------------------------------------------------------
-- R-I1  緊急撤銷 authenticated inventory policies（撤銷 Phase I1）
--       不 DROP anon 過渡／legacy PUBLIC policy，避免公開站中斷。
-- R-I1 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS inventory_authenticated_select ON public.inventory;
-- DROP POLICY IF EXISTS inventory_admin_insert ON public.inventory;
-- DROP POLICY IF EXISTS inventory_admin_update ON public.inventory;
-- DROP POLICY IF EXISTS inventory_admin_delete ON public.inventory;
-- R-I1 COPY END
