-- ============================================================
-- DK Computer Stage 6-4-2：Storage S1 過渡（product-photos / site-assets）
-- JWT admin WRITE + 暫時保留 anon WRITE
--
-- 本檔禁止：
--   把 bucket 改 private
--   DELETE / TRUNCATE storage.objects
--   改其他表 RLS（inventory / site_config / v2_data / vendor_quotes / purchase_orders）
--   修改 public.is_admin()
--   給 staff WRITE 或 SELECT
--   用 TO PUBLIC / TO anon 建 admin policy
--   本對話執行本檔。S2 與 R 預設不執行。
--
-- 依賴：public.is_admin()（Stage 2，SECURITY DEFINER，GRANT EXECUTE TO authenticated）
--
-- 複製方式：
--   每一個 SECTION 都是完整可執行 SQL。
--   請只複製該 SECTION 到 SQL Editor，不要整份一次跑完。
--
-- 正確順序（本 Stage 只準備，不要現在執行）：
--   1) 先跑下方「觀察用」查詢，記下正式 storage.objects policy 名稱
--   2) 複製執行 S1（增加 authenticated admin SELECT/INSERT/UPDATE/DELETE；不收 anon WRITE）
--   3) 正式 admin 用 JWT 上傳商品圖 / Logo / Banner / homeEntries
--   4) 確認公開頁仍用 /object/public/... 顯示
--   5) 僅在 JWT WRITE 驗證通過後，才進入未來 Stage 做 S2
--
-- S1 必須同時支援：
--   舊路徑 anon WRITE（名稱未知，本檔不 DROP）
--   新路徑 admin JWT SELECT / INSERT / UPDATE / DELETE（僅兩 bucket）
--   x-upsert / overwrite 需要 SELECT + UPDATE；DELETE API 可能需要 SELECT + DELETE
--
-- 正式 policy 名稱目前未知。可能不是 anon_all。
-- 禁止在不知道名字時 DROP 全部 storage.objects policy。
-- ============================================================


-- ============================================================
-- 觀察用（可在 S1 前單獨跑；只讀，不改 policy）
-- 用途：讓 S2 有「正式觀察到的 policy 名稱」再決定 DROP。
-- 不要用這段去猜 DROP。
-- ============================================================

-- 1) 全部 storage.objects policies（blanket FOR ALL 不會出現 bucket 名）
-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'storage'
--   AND tablename = 'objects'
-- ORDER BY policyname;

-- 2) 字面上提到這兩個 bucket 的 policy（可能為空，若 legacy 是 USING (true)）
-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'storage'
--   AND tablename = 'objects'
--   AND (
--     coalesce(qual, '') ILIKE '%product-photos%'
--     OR coalesce(with_check, '') ILIKE '%product-photos%'
--     OR coalesce(qual, '') ILIKE '%site-assets%'
--     OR coalesce(with_check, '') ILIKE '%site-assets%'
--     OR policyname ILIKE '%product-photo%'
--     OR policyname ILIKE '%site-asset%'
--   )
-- ORDER BY policyname;

-- 3) bucket public flag（不列 object 名稱）
-- SELECT id, public
-- FROM storage.buckets
-- WHERE id IN ('product-photos', 'site-assets')
-- ORDER BY id;


-- ============================================================
-- SECTION S1
-- Storage Phase 1
-- ADD AUTHENTICATED ADMIN SELECT+WRITE — KEEP ANON WRITE
--
-- 請複製本 SECTION（從下一行到 S1 END）單獨執行。
-- 不 DROP 任何現有 anon / PUBLIC policy。
-- 不 ALTER storage.buckets.public。
-- ============================================================

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-4-2 S1 中止：缺少 storage.objects。';
  END IF;
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-4-2 S1 中止：缺少 storage.buckets。';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Stage 6-4-2 S1 中止：缺少 public.is_admin()。請先完成 supabase-auth-stage2.sql。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'product-photos') THEN
    RAISE EXCEPTION 'Stage 6-4-2 S1 中止：缺少 bucket product-photos。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'site-assets') THEN
    RAISE EXCEPTION 'Stage 6-4-2 S1 中止：缺少 bucket site-assets。';
  END IF;
END $$;

-- 表權限：authenticated 需要 SELECT/INSERT/UPDATE/DELETE 才進得了 RLS。
-- 不 REVOKE anon。不 GRANT 其他 bucket 的例外；RLS 用 bucket_id + is_admin() 限制。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE storage.objects TO authenticated;

DROP POLICY IF EXISTS storage_objects_admin_select ON storage.objects;
DROP POLICY IF EXISTS storage_objects_admin_insert ON storage.objects;
DROP POLICY IF EXISTS storage_objects_admin_update ON storage.objects;
DROP POLICY IF EXISTS storage_objects_admin_delete ON storage.objects;

-- SELECT：x-upsert overwrite 與 DELETE API 可能需要先讀到既有 object。
-- 僅兩 bucket + is_admin()。不給 staff、不給 anon、不給 PUBLIC。
CREATE POLICY storage_objects_admin_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id IN ('product-photos', 'site-assets')
    AND public.is_admin()
  );

-- INSERT：x-upsert 新檔需要。僅兩 bucket + is_admin()。
CREATE POLICY storage_objects_admin_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id IN ('product-photos', 'site-assets')
    AND public.is_admin()
  );

-- UPDATE：前端 x-upsert: true 覆寫同路徑需要 USING + WITH CHECK。
CREATE POLICY storage_objects_admin_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id IN ('product-photos', 'site-assets')
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id IN ('product-photos', 'site-assets')
    AND public.is_admin()
  );

-- DELETE：現行 UI 不刪 Storage 物件；預留給 admin。staff 沒有 is_admin()。
CREATE POLICY storage_objects_admin_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id IN ('product-photos', 'site-assets')
    AND public.is_admin()
  );

-- 只讀驗證：policy + 兩 bucket 的 public flag。不列 object 名稱。
-- 確認四條：storage_objects_admin_select / insert / update / delete
SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname IN (
    'storage_objects_admin_select',
    'storage_objects_admin_insert',
    'storage_objects_admin_update',
    'storage_objects_admin_delete'
  )
ORDER BY policyname;

SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;

SELECT id, public
FROM storage.buckets
WHERE id IN ('product-photos', 'site-assets')
ORDER BY id;

-- ============================================================
-- S1 END
-- 停止。不要繼續執行下面的 SECTION。
-- anon WRITE 此時必須仍然存在（本 SECTION 未 DROP 任何舊 policy）。
-- bucket.public 不得被改。
-- ============================================================


-- ============================================================
-- SECTION S2
-- Storage Phase 2
-- REMOVE ANON / PUBLIC WRITE — KEEP PUBLIC BUCKET READ
--
-- 整份貼上不會執行本區（包在區塊註解內）。
-- 預設不要執行。未來 Stage 才做。
--
-- 最終目標：
--   public URL /object/public/...   仍可 GET 圖片（bucket 保持 public）
--   anon                            不可 INSERT / UPDATE / DELETE
--   authenticated admin (is_admin)  可 SELECT / INSERT / UPDATE / DELETE
--   staff                           不可 WRITE（也不可靠這四條 SELECT 這兩 bucket）
--   公開 /object/public/... 顯示不依賴 storage_objects_admin_select
--
-- 禁止：
--   ALTER bucket 改 private
--   刪 object
--   誤刪造成 public URL 失效的設定
--
-- 未知 legacy 名稱：S2 不可假裝已知道正式 policy。
-- 執行前必須先跑觀察查詢，把實際名稱填進 TODO 再 DROP。
-- 若正式只有一條 FOR ALL TO anon/PUBLIC USING (true)：
--   直接 DROP 會連 WRITE 與（若有）SELECT/list 一起拿掉。
--   public bucket 的 /object/public/ GET 通常不靠 SELECT policy，
--   但仍必須人工確認後再 DROP，不要自動猜名字。
-- ============================================================
/*

-- S2 執行前必跑（只讀）：
-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'storage' AND tablename = 'objects'
-- ORDER BY policyname;
--
-- SELECT id, public
-- FROM storage.buckets
-- WHERE id IN ('product-photos', 'site-assets')
-- ORDER BY id;

-- REQUIRED observed policy names（執行 S2 前用觀察結果改寫；不要留空白就跑）：
-- TODO: DROP POLICY IF EXISTS "<observed_anon_or_public_insert_or_all>" ON storage.objects;
-- TODO: DROP POLICY IF EXISTS "<observed_anon_or_public_update>" ON storage.objects;
-- TODO: DROP POLICY IF EXISTS "<observed_anon_or_public_delete>" ON storage.objects;
--
-- 常見但未證實的名字（僅備註，未觀察到不得當已存在）：
-- DROP POLICY IF EXISTS "anon_all" ON storage.objects;
-- DROP POLICY IF EXISTS "Give users access to own folder 1j6q0xx_0" ON storage.objects;
-- DROP POLICY IF EXISTS "Public Access" ON storage.objects;
-- DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;

-- 保留 S1 四條 admin policy（若已存在則重建，避免 S2 誤傷）。
-- 禁止 DROP storage_objects_admin_select。
-- DROP POLICY IF EXISTS storage_objects_admin_select ON storage.objects;
-- CREATE POLICY storage_objects_admin_select
--   ON storage.objects
--   FOR SELECT
--   TO authenticated
--   USING (
--     bucket_id IN ('product-photos', 'site-assets')
--     AND public.is_admin()
--   );
-- DROP POLICY IF EXISTS storage_objects_admin_insert ON storage.objects;
-- CREATE POLICY storage_objects_admin_insert
--   ON storage.objects
--   FOR INSERT
--   TO authenticated
--   WITH CHECK (
--     bucket_id IN ('product-photos', 'site-assets')
--     AND public.is_admin()
--   );
-- DROP POLICY IF EXISTS storage_objects_admin_update ON storage.objects;
-- CREATE POLICY storage_objects_admin_update
--   ON storage.objects
--   FOR UPDATE
--   TO authenticated
--   USING (
--     bucket_id IN ('product-photos', 'site-assets')
--     AND public.is_admin()
--   )
--   WITH CHECK (
--     bucket_id IN ('product-photos', 'site-assets')
--     AND public.is_admin()
--   );
-- DROP POLICY IF EXISTS storage_objects_admin_delete ON storage.objects;
-- CREATE POLICY storage_objects_admin_delete
--   ON storage.objects
--   FOR DELETE
--   TO authenticated
--   USING (
--     bucket_id IN ('product-photos', 'site-assets')
--     AND public.is_admin()
--   );

-- 不要：
-- ALTER TABLE storage.buckets ...
-- UPDATE storage.buckets SET public = false ...
-- DELETE FROM storage.objects ...

-- SELECT policyname, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'storage' AND tablename = 'objects'
-- ORDER BY policyname;
--
-- SELECT id, public
-- FROM storage.buckets
-- WHERE id IN ('product-photos', 'site-assets')
-- ORDER BY id;

*/


-- ============================================================
-- SECTION R
-- EMERGENCY ONLY — ROLLBACK
-- 預設不要執行。緊急時才複製對應區塊。
-- 不得刪 bucket、不得刪 object、不得改 public flag。
-- ============================================================

-- ------------------------------------------------------------
-- R-S2  緊急恢復這兩 bucket 的 anon WRITE（撤銷 Phase S2 後的「禁止 anon WRITE」）
--       正式舊 policy 名稱未知，因此這裡用「範圍僅兩 bucket」的過渡 policy，
--       不是保證還原成觀察前的原始名稱。
--       執行前仍應對照觀察紀錄，若知道原始名稱，改用原始 CREATE。
-- R-S2 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS storage_anon_write_transition ON storage.objects;
-- CREATE POLICY storage_anon_write_transition
--   ON storage.objects
--   FOR ALL
--   TO anon
--   USING (bucket_id IN ('product-photos', 'site-assets'))
--   WITH CHECK (bucket_id IN ('product-photos', 'site-assets'));
-- GRANT INSERT, UPDATE, DELETE ON TABLE storage.objects TO anon;
-- R-S2 COPY END

-- ------------------------------------------------------------
-- R-S1  緊急撤銷 authenticated admin Storage SELECT+WRITE（撤銷 Phase S1）
--       不 DROP 任何 anon / PUBLIC 舊 policy，避免舊站上傳中斷。
--       不改 bucket.public。
-- R-S1 COPY START
-- ------------------------------------------------------------
-- DROP POLICY IF EXISTS storage_objects_admin_select ON storage.objects;
-- DROP POLICY IF EXISTS storage_objects_admin_insert ON storage.objects;
-- DROP POLICY IF EXISTS storage_objects_admin_update ON storage.objects;
-- DROP POLICY IF EXISTS storage_objects_admin_delete ON storage.objects;
-- R-S1 COPY END
