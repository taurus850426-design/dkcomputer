-- ============================================================
-- DK Computer Stage 6-2：移除 site_config Legacy 明文密碼
--
-- 本檔只處理 public.site_config 且 id = 'default'。
-- 禁止：改 RLS / GRANT / POLICY、建新表、碰 profiles / auth.users、
--       改 banner / logo / frontend / brand / line / shop / siteTitle /
--       inventoryCategories 等非 password 欄位。
--
-- 可重複執行（idempotent）。
-- 本 Stage 只準備 SQL，不要在此對話中執行。
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.site_config WHERE id = 'default'
  ) THEN
    RAISE NOTICE 'Stage 6-2 skip: site_config id=default 不存在';
    RETURN;
  END IF;

  UPDATE public.site_config
  SET data = CASE
    WHEN jsonb_typeof(data->'admin'->'users') = 'array' THEN
      jsonb_set(
        COALESCE(data, '{}'::jsonb) #- '{admin,password}',
        '{admin,users}',
        (
          SELECT COALESCE(jsonb_agg(elem - 'password' ORDER BY ord), '[]'::jsonb)
          FROM jsonb_array_elements(data->'admin'->'users') WITH ORDINALITY AS t(elem, ord)
        ),
        false
      )
    ELSE
      COALESCE(data, '{}'::jsonb) #- '{admin,password}'
  END
  WHERE id = 'default';
END $$;

-- 安全驗證：只回傳是否仍有 password key，絕不 SELECT 密碼值。
SELECT
  EXISTS (SELECT 1 FROM public.site_config WHERE id = 'default') AS default_row_exists,
  COALESCE((
    SELECT (data->'admin') ? 'password'
    FROM public.site_config
    WHERE id = 'default'
  ), false) AS admin_password_key_exists,
  COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(data->'admin'->'users') = 'array'
        THEN jsonb_array_length(data->'admin'->'users')
      ELSE 0
    END
    FROM public.site_config
    WHERE id = 'default'
  ), 0) AS admin_users_count,
  COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(data->'admin'->'users') = 'array' THEN (
        SELECT count(*)::int
        FROM jsonb_array_elements(sc.data->'admin'->'users') AS u
        WHERE u ? 'password'
      )
      ELSE 0
    END
    FROM public.site_config sc
    WHERE sc.id = 'default'
  ), 0) AS users_still_having_password_key;
