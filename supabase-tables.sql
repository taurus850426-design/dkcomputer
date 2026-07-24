-- ============================================================
-- 換電腦／換瀏覽器都能用：在 Supabase 建立這 4 張表
-- 到 Supabase Dashboard → SQL Editor → 貼上整段 → Run
-- ============================================================

-- 1) 官網設定（LINE 連結、按鈕文案、每頁一句話、品牌標題等）
--    後台「前台管理」儲存時會寫入；任何裝置開官網都會從這裡讀
CREATE TABLE IF NOT EXISTS site_config (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'
);
INSERT INTO site_config (id, data) VALUES ('default', '{}')
  ON CONFLICT (id) DO NOTHING;

-- 2) 前台整機販售商品（上架管理、同步到前台會寫入）
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  stock_status TEXT,
  price NUMERIC,
  note TEXT,
  photos JSONB,
  qty NUMERIC,
  featured_home BOOLEAN DEFAULT false,
  featured_order INTEGER NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3) 庫存規格／種類（若後台有使用舊版庫存規格會讀寫）
CREATE TABLE IF NOT EXISTS stock_data (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'
);
INSERT INTO stock_data (id, data) VALUES ('default', '{"stock":[],"stockKinds":[],"stockSchema":[]}')
  ON CONFLICT (id) DO NOTHING;

-- 4) 訂單（訂單管理用；目前後台「庫存+記帳」的訂單是 localStorage，此表給舊版訂單或未來擴充）
CREATE TABLE IF NOT EXISTS orders_data (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{"orders":[]}'
);
INSERT INTO orders_data (id, data) VALUES ('default', '{"orders":[]}')
  ON CONFLICT (id) DO NOTHING;

-- 5) 庫存＋記帳 v2（品項、流水帳、訂單、支出）- 換電腦／換瀏覽器同步用
CREATE TABLE IF NOT EXISTS v2_data (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{"items":[],"ledger":[],"orders":[],"expenses":[]}'
);
INSERT INTO v2_data (id, data) VALUES ('default', '{"items":[],"ledger":[],"orders":[],"expenses":[]}')
  ON CONFLICT (id) DO NOTHING;

-- 若開啟了 RLS 且出現「權限不足」錯誤，再到 SQL Editor 執行下方（或到 Dashboard → Table → 各表 → RLS 新增 Policy 允許 anon 全部操作）：
-- ALTER TABLE site_config ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "anon_all" ON site_config FOR ALL TO anon USING (true) WITH CHECK (true);
-- （inventory、stock_data、orders_data 同理）
