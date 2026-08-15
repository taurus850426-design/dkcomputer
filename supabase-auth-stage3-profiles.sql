-- ============================================================
-- DK Computer Stage 3：Auth User 建立後的 profiles 對應
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔不得自動建立 Auth User，不含密碼，不含 UUID 手抄。
-- 請先到 Authentication → Users 手動建立：
--   admin@login.dkcomputer.internal
--   dk001@login.dkcomputer.internal
-- 建議勾選 Auto Confirm User（內部信箱收不到確認信）。
--
-- 執行順序：
--   1) 先跑「查詢 Auth User」確認兩筆都在
--   2) 再跑「寫入 profiles」區塊
-- 若缺任一 Auth User，profiles 寫入會整段中止，不會只寫一筆。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 查詢：用 email 找 auth.users UUID（不要手動複製）
-- ------------------------------------------------------------
SELECT id, email, created_at, email_confirmed_at
FROM auth.users
WHERE email IN (
  'admin@login.dkcomputer.internal',
  'dk001@login.dkcomputer.internal'
)
ORDER BY email;

-- ------------------------------------------------------------
-- 2) 寫入 profiles
--    依 auth.users.email 對應 UUID 後 INSERT
--    ON CONFLICT (id) DO UPDATE
--
-- display_name 來源（讀自正式 site_config.data.admin.users[]，不含密碼）：
--   admin  → displayName = 管理員
--   DK001  → displayName = DK001（不是猜的姓名；config 裡目前就是這個值）
-- ------------------------------------------------------------
DO $$
DECLARE
  admin_id uuid;
  dk001_id uuid;
BEGIN
  SELECT id INTO admin_id
  FROM auth.users
  WHERE email = 'admin@login.dkcomputer.internal';

  SELECT id INTO dk001_id
  FROM auth.users
  WHERE email = 'dk001@login.dkcomputer.internal';

  IF admin_id IS NULL AND dk001_id IS NULL THEN
    RAISE EXCEPTION 'Stage 3 中止：兩個 Auth User 都不存在。請先在 Dashboard 建立 admin@login.dkcomputer.internal 與 dk001@login.dkcomputer.internal。profiles 未寫入。';
  ELSIF admin_id IS NULL THEN
    RAISE EXCEPTION 'Stage 3 中止：缺少 admin@login.dkcomputer.internal。整個 profiles 寫入未執行。';
  ELSIF dk001_id IS NULL THEN
    RAISE EXCEPTION 'Stage 3 中止：缺少 dk001@login.dkcomputer.internal。整個 profiles 寫入未執行。';
  END IF;

  INSERT INTO public.profiles (id, username, display_name, role, enabled)
  VALUES
    (admin_id, 'admin', '管理員', 'admin', true),
    (dk001_id, 'DK001', 'DK001', 'staff', true)
  ON CONFLICT (id) DO UPDATE
  SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    role = EXCLUDED.role,
    enabled = EXCLUDED.enabled;
END $$;

-- ------------------------------------------------------------
-- 3) 驗證 profiles（不含密碼）
-- ------------------------------------------------------------
SELECT id, username, display_name, role, enabled, created_at, updated_at
FROM public.profiles
ORDER BY username;
