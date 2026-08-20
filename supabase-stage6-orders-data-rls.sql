-- ============================================================
-- DK Computer Stage 6-6-3：public.orders_data Legacy 安全退役
--
-- 本檔是 migration 紀錄。禁止本對話再執行。
-- 禁止修改其他表、schema USAGE、service_role。
-- 禁止修改 public.is_admin() / is_enabled_backoffice_user()。
-- 禁止 DROP / 改 Storage、inventory、site_config、v2_data、
--     vendor_quotes、purchase_orders、stock_data、profiles。
-- 禁止 DELETE / UPDATE / TRUNCATE public.orders_data。
-- 禁止改 data JSONB、禁止 DROP table、禁止刪 id=default 列。
--
-- 正式現況（C2 已由使用者在 SQL Editor 執行）：
--   table 與 id=default 列保留
--   RLS 原本已為 true，保持 ENABLE（本 Stage 未 ALTER RLS）
--   已 DROP：
--     public_write_orders_data
--     public_read_orders_data
--   已 REVOKE ALL FROM PUBLIC / anon / authenticated
--   未建立任何新 policy
--   未改 data、未刪列
--
-- 前端：
--   fetchOrdersFromSupabase / saveOrdersToSupabase 為 no-op
--   無 boot GET、無正式呼叫端
--   正式訂單仍只走 v2_data JWT
--   不建立 authenticated JWT WRITE
--
-- 最終 client 權限目標：
--   anon            無任何 table privilege
--   authenticated   無任何 table privilege
--   PUBLIC          無任何 table privilege、無 permissive policy
-- ============================================================


-- ============================================================
-- OBSERVATION（只讀紀錄；不要當 mutation 再跑）
-- ============================================================

-- SELECT to_regclass('public.orders_data') AS orders_data_regclass;
--
-- SELECT c.relrowsecurity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' AND c.relname = 'orders_data';
--
-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'orders_data'
-- ORDER BY policyname;
--
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name = 'orders_data'
--   AND grantee IN ('anon', 'authenticated', 'PUBLIC')
-- ORDER BY grantee, privilege_type;
--
-- SELECT COUNT(*) AS row_count FROM public.orders_data;
-- SELECT id FROM public.orders_data ORDER BY id;


-- ============================================================
-- SECTION C2  （正式已執行；保留紀錄，禁止再跑）
-- orders_data Phase 2
-- DROP PUBLIC policies + REVOKE ALL CLIENT GRANTS
-- KEEP TABLE AND DEFAULT ROW
-- KEEP RLS ENABLED（原本已為 true，未 ALTER）
--
-- 實際執行內容（與正式 SQL Editor 一致）：
-- ============================================================
/*

DROP POLICY IF EXISTS public_write_orders_data ON public.orders_data;
DROP POLICY IF EXISTS public_read_orders_data ON public.orders_data;

REVOKE ALL ON TABLE public.orders_data FROM PUBLIC;
REVOKE ALL ON TABLE public.orders_data FROM anon;
REVOKE ALL ON TABLE public.orders_data FROM authenticated;

-- 未執行：
-- ALTER TABLE public.orders_data ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.orders_data DISABLE ROW LEVEL SECURITY;
-- 未建立任何 TO anon / authenticated / PUBLIC 的新 policy。
-- 未刪列、未改 data。

-- C2 END
*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- 不得刪 row、不得改 data、不得 DROP table、不得改其他表。
-- 不 GRANT WRITE TO PUBLIC。
-- 不重建 public_read_orders_data / public_write_orders_data。
-- ============================================================

-- R-C2  撤銷正式 C2：只恢復 anon 讀寫過渡，不恢復 PUBLIC 全角色 WRITE。
-- R-C2 COPY START
-- DROP POLICY IF EXISTS orders_data_anon_rollback_all ON public.orders_data;
-- CREATE POLICY orders_data_anon_rollback_all
--   ON public.orders_data
--   FOR ALL
--   TO anon
--   USING (true)
--   WITH CHECK (true);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders_data TO anon;
-- R-C2 COPY END
