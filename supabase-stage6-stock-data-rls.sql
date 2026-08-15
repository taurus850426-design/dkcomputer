-- ============================================================
-- DK Computer Stage 6-6-2：public.stock_data Legacy 安全退役
--
-- 本檔是 migration 紀錄。禁止本對話再執行。
-- 禁止修改其他表、schema USAGE、service_role。
-- 禁止修改 public.is_admin() / is_enabled_backoffice_user()。
-- 禁止 DROP / 改 Storage、inventory、site_config、v2_data、
--     vendor_quotes、purchase_orders、orders_data、profiles。
-- 禁止 DELETE / UPDATE / TRUNCATE public.stock_data。
-- 禁止改 data JSONB、禁止 DROP table、禁止刪 id=default 列。
--
-- 正式現況（C2 已由使用者在 SQL Editor 執行）：
--   table 與 id=default 列保留
--   已 DROP：
--     public_write_stock_data
--     public_read_stock_data
--   已 REVOKE ALL FROM PUBLIC / anon / authenticated
--   未 ENABLE RLS（本 Stage 未執行 ALTER TABLE ... ENABLE）
--   未建立任何新 policy
--   未改 data、未刪列
--
-- 前端：
--   正式 boot 不再 GET stock_data
--   saveStock* 不再 POST stock_data
--   不建立 authenticated JWT WRITE（正式流程不需要 cloud）
--
-- 最終 client 權限目標：
--   anon            無任何 table privilege
--   authenticated   無任何 table privilege
--   PUBLIC          無任何 table privilege、無 permissive policy
-- ============================================================


-- ============================================================
-- 觀察用（只讀；已用於確認 C2 前政策名稱。不要當 mutation 再跑。）
-- ============================================================

-- SELECT to_regclass('public.stock_data') AS stock_data_regclass;
--
-- SELECT c.relrowsecurity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' AND c.relname = 'stock_data';
--
-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'stock_data'
-- ORDER BY policyname;
--
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name = 'stock_data'
--   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
-- ORDER BY grantee, privilege_type;
--
-- SELECT COUNT(*) AS row_count FROM public.stock_data;
-- SELECT id FROM public.stock_data ORDER BY id;


-- ============================================================
-- SECTION C1
-- 未執行。正式跳過 C1，直接執行下方已記錄的 C2。
-- ============================================================


-- ============================================================
-- SECTION C2  （正式已執行；保留紀錄，禁止再跑）
-- stock_data Phase 2
-- DROP PUBLIC policies + REVOKE ALL CLIENT GRANTS
-- KEEP TABLE AND DEFAULT ROW
--
-- 實際執行內容（與正式 SQL Editor 一致）：
-- ============================================================
/*

DROP POLICY IF EXISTS public_write_stock_data ON public.stock_data;
DROP POLICY IF EXISTS public_read_stock_data ON public.stock_data;

REVOKE ALL ON TABLE public.stock_data FROM PUBLIC;
REVOKE ALL ON TABLE public.stock_data FROM anon;
REVOKE ALL ON TABLE public.stock_data FROM authenticated;

-- 未執行：
-- ALTER TABLE public.stock_data ENABLE ROW LEVEL SECURITY;
-- 未建立任何 TO anon / authenticated / PUBLIC 的新 policy。
-- 未刪列、未改 data。

-- C2 END
*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- 不得刪 row、不得改 data、不得 DROP table、不得改其他表。
-- ============================================================

-- R-C2  撤銷正式 C2：恢復 C2 前兩條 PUBLIC policy + client GRANT。
--       不猜其他 policy 名稱。
--       不 ENABLE / DISABLE RLS。
-- R-C2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS public_read_stock_data ON public.stock_data;
-- CREATE POLICY public_read_stock_data
--   ON public.stock_data
--   FOR SELECT
--   TO PUBLIC
--   USING (true);
-- DROP POLICY IF EXISTS public_write_stock_data ON public.stock_data;
-- CREATE POLICY public_write_stock_data
--   ON public.stock_data
--   FOR ALL
--   TO PUBLIC
--   USING (true)
--   WITH CHECK (true);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stock_data TO PUBLIC;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stock_data TO anon;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stock_data TO authenticated;
-- R-C2 COPY END
--
-- R-C1  C1 未執行，無需 rollback。
