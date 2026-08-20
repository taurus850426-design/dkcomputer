-- ============================================================
-- DK Computer Stage 2：Supabase Auth 基礎＋profiles
-- 到 Supabase Dashboard → SQL Editor → 貼上整段 → Run
--
-- 本檔尚未由網站自動執行。執行前正式登入仍走舊系統。
--
-- 本 Stage 只建立 public.profiles 與 is_admin()。
-- 禁止：DROP 業務表、DELETE/TRUNCATE、改 site_config 資料、
--       改其他表 RLS / GRANT / POLICY、改 Storage policy。
-- ============================================================

-- 1) profiles（對應未來 Auth user；不含 password）
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) updated_at：profiles 專用 trigger（不改其他表）
CREATE OR REPLACE FUNCTION public.profiles_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_set_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.profiles_set_updated_at();

-- 3) is_admin()
--    - 使用 auth.uid()，不接受 user id 參數（避免 anon 查別人）
--    - LANGUAGE plpgsql：避免 SQL 函式被 inlining 而失去 SECURITY DEFINER
--    - SET search_path = ''：固定搜尋路徑，物件一律 schema-qualify
--    - SECURITY DEFINER：以擁有者權限讀 profiles，避免 RLS 自我遞迴
CREATE OR REPLACE FUNCTION public.is_admin()
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
      AND role = 'admin'
      AND enabled = true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- 4) 權限：authenticated 只能讀；anon 無直接表權限
--    即使預設 GRANT 曾給寫入，這裡收回。寫入靠 RLS 沒有 policy 也會被擋。
REVOKE ALL ON TABLE public.profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- 5) 只對 profiles 啟用 RLS（不改其他表）
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 最低讀取：登入者讀自己；admin（enabled）可讀全部
-- 本 Stage 不建立 INSERT/UPDATE/DELETE policy：
-- staff 不能改自己的 role / enabled，也不能改別人。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select_own'
  ) THEN
    CREATE POLICY profiles_select_own
      ON public.profiles
      FOR SELECT
      TO authenticated
      USING (id = (SELECT auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select_admin'
  ) THEN
    CREATE POLICY profiles_select_admin
      ON public.profiles
      FOR SELECT
      TO authenticated
      USING (public.is_admin());
  END IF;
END $$;
