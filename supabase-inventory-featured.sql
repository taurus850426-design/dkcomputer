-- ============================================================
-- inventory 表：補上首頁主推欄位（既有表安全升級）
-- 到 Supabase Dashboard → SQL Editor → 貼上此段 → Run
-- 若出現「already exists」可忽略
-- ============================================================

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS featured_home BOOLEAN DEFAULT false;

ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS featured_order INTEGER NULL;

-- 既有列預設不主推
UPDATE inventory
SET featured_home = false
WHERE featured_home IS NULL;
