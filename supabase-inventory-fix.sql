-- ============================================================
-- 修復 inventory 表：讓 upsert (ON CONFLICT) 可正常運作
-- 錯誤：「there is no unique or exclusion constraint matching the ON CONFLICT specification」
--
-- 到 Supabase Dashboard → SQL Editor → 貼上此段 → Run
-- ============================================================

-- 若 id 尚未設為 PRIMARY KEY，則加入
-- （若出現「already exists」可忽略，代表已正確設定）
ALTER TABLE inventory ADD PRIMARY KEY (id);

-- 若上列失敗（例如 id 已為 PK 但 constraint 名稱不同），可改試：
-- ALTER TABLE inventory ADD CONSTRAINT inventory_id_unique UNIQUE (id);
