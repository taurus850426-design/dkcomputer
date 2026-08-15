-- ============================================================
-- DK Computer Stage 5A.1：vendor_quotes / purchase_orders
-- JWT + RLS 零停機兩階段切換
--
-- 本檔禁止修改其他表、schema USAGE、service_role。
-- 依賴：public.is_admin()（Stage 2）
--
-- 複製方式：
--   每一個 SECTION 都是完整可執行 SQL。
--   請只複製該 SECTION 到 SQL Editor，不要整份一次跑完。
--   不要拆半個 DO block。
--
-- 正確順序：
--   STEP 1  複製執行 A1（保留 anon_all，新增 authenticated admin）
--   STEP 2  用目前正式舊版網站確認廠商報價仍正常
--   STEP 3  commit + push JWT 前端
--   STEP 4  等 GitHub Pages 部署完成
--   STEP 5  正式站 admin：讀 / 新增 / 修改 / 同步
--   STEP 6  staff：不應看到廠商管理；client 回 permission_denied
--   STEP 7  複製執行 A2（DROP anon_all，REVOKE anon）
--   STEP 8  再測 admin / staff / anon
--   vendor_quotes 全部 PASS 後：
--     B1 → 驗證 → B2 → 驗證
-- ============================================================


-- ============================================================
-- SECTION A1
-- vendor_quotes Phase 1
-- ADD AUTHENTICATED ADMIN ACCESS — KEEP ANON TEMPORARILY
--
-- 請複製本 SECTION（從下一行到 A1 END）單獨執行。
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5A A1 中止：缺少 public.is_admin()。請先完成 supabase-auth-stage2.sql。';
  END IF;
END $$;

ALTER TABLE public.vendor_quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_quotes_admin_select ON public.vendor_quotes;
DROP POLICY IF EXISTS vendor_quotes_admin_insert ON public.vendor_quotes;
DROP POLICY IF EXISTS vendor_quotes_admin_update ON public.vendor_quotes;
DROP POLICY IF EXISTS vendor_quotes_admin_delete ON public.vendor_quotes;

CREATE POLICY vendor_quotes_admin_select
  ON public.vendor_quotes
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY vendor_quotes_admin_insert
  ON public.vendor_quotes
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY vendor_quotes_admin_update
  ON public.vendor_quotes
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY vendor_quotes_admin_delete
  ON public.vendor_quotes
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- Phase 1：給 authenticated 表權限，否則 JWT admin 仍無法操作。
-- 保留 anon 既有 GRANT 與 anon_all。不 REVOKE anon。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_quotes TO authenticated;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vendor_quotes'
ORDER BY policyname;

-- ============================================================
-- A1 END
-- 停止。不要繼續執行下面的 SECTION。
-- ============================================================


-- ============================================================
-- SECTION A2
-- vendor_quotes Phase 2
-- REMOVE ANON ACCESS — RUN ONLY AFTER JWT VERIFIED
--
-- 整份貼上不會執行本區（包在區塊註解內）。
-- 執行時：複製 /* 與 */ 之間的完整 SQL（含完整 DO block），單獨貼上。
-- 僅在正式站 JWT admin 讀/新增/修改/同步都 PASS 之後才跑。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5A A2 中止：缺少 public.is_admin()。';
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_all" ON public.vendor_quotes;

REVOKE ALL ON TABLE public.vendor_quotes FROM anon;
REVOKE ALL ON TABLE public.vendor_quotes FROM PUBLIC;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'vendor_quotes'
ORDER BY policyname;

*/


-- ============================================================
-- SECTION B1
-- purchase_orders Phase 1
-- ADD AUTHENTICATED ADMIN ACCESS — KEEP ANON TEMPORARILY
--
-- vendor_quotes A1→JWT→A2 全部 PASS 後，才複製本區 /* */ 內完整 SQL。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5A B1 中止：缺少 public.is_admin()。';
  END IF;
END $$;

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_orders_admin_select ON public.purchase_orders;
DROP POLICY IF EXISTS purchase_orders_admin_insert ON public.purchase_orders;
DROP POLICY IF EXISTS purchase_orders_admin_update ON public.purchase_orders;
DROP POLICY IF EXISTS purchase_orders_admin_delete ON public.purchase_orders;

CREATE POLICY purchase_orders_admin_select
  ON public.purchase_orders
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY purchase_orders_admin_insert
  ON public.purchase_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY purchase_orders_admin_update
  ON public.purchase_orders
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY purchase_orders_admin_delete
  ON public.purchase_orders
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.purchase_orders TO authenticated;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'purchase_orders'
ORDER BY policyname;

*/


-- ============================================================
-- SECTION B2
-- purchase_orders Phase 2
-- REMOVE ANON ACCESS — RUN ONLY AFTER JWT VERIFIED
--
-- B1 驗證通過後，才複製本區 /* */ 內完整 SQL。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 5A B2 中止：缺少 public.is_admin()。';
  END IF;
END $$;

DROP POLICY IF EXISTS "anon_all" ON public.purchase_orders;

REVOKE ALL ON TABLE public.purchase_orders FROM anon;
REVOKE ALL ON TABLE public.purchase_orders FROM PUBLIC;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'purchase_orders'
ORDER BY policyname;

*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- ============================================================

-- ------------------------------------------------------------
-- R-A2  緊急恢復 vendor_quotes anon（撤銷 Phase 2，保留 admin policy）
-- R-A2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS "anon_all" ON public.vendor_quotes;
-- CREATE POLICY "anon_all"
--   ON public.vendor_quotes
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- GRANT ALL ON TABLE public.vendor_quotes TO anon;
-- R-A2 COPY END

-- ------------------------------------------------------------
-- R-A1  緊急撤銷 vendor_quotes authenticated admin policy（撤銷 Phase 1）
-- R-A1 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS vendor_quotes_admin_select ON public.vendor_quotes;
-- DROP POLICY IF EXISTS vendor_quotes_admin_insert ON public.vendor_quotes;
-- DROP POLICY IF EXISTS vendor_quotes_admin_update ON public.vendor_quotes;
-- DROP POLICY IF EXISTS vendor_quotes_admin_delete ON public.vendor_quotes;
-- R-A1 COPY END

-- ------------------------------------------------------------
-- R-B2  緊急恢復 purchase_orders anon（撤銷 Phase 2，保留 admin policy）
-- R-B2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS "anon_all" ON public.purchase_orders;
-- CREATE POLICY "anon_all"
--   ON public.purchase_orders
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- GRANT ALL ON TABLE public.purchase_orders TO anon;
-- R-B2 COPY END

-- ------------------------------------------------------------
-- R-B1  緊急撤銷 purchase_orders authenticated admin policy（撤銷 Phase 1）
-- R-B1 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS purchase_orders_admin_select ON public.purchase_orders;
-- DROP POLICY IF EXISTS purchase_orders_admin_insert ON public.purchase_orders;
-- DROP POLICY IF EXISTS purchase_orders_admin_update ON public.purchase_orders;
-- DROP POLICY IF EXISTS purchase_orders_admin_delete ON public.purchase_orders;
-- R-B1 COPY END
