-- ============================================================
-- DK Computer：廠商報價＋採購叫貨單雲端同步 1.0
-- 到 Supabase Dashboard → SQL Editor → 貼上整段 → Run
--
-- 安全注意：
-- 本專案前端使用 anon／publishable key，且沒有 Supabase Auth。
-- 下方 RLS policy 允許 anon 全部讀寫（沿用現有 inventory／site_config 模式）。
-- 這不是安全的多人帳號系統；知道 URL + anon key 即可讀寫這些表。
--
-- 禁止：DROP TABLE、刪除既有資料
-- ============================================================

-- 1) 廠商報價（對應 localStorage：dk_vendor_quotes_v1）
CREATE TABLE IF NOT EXISTS vendor_quotes (
  id TEXT PRIMARY KEY,
  date TEXT,
  vendor TEXT,
  category TEXT,
  brand TEXT,
  spec TEXT,
  price NUMERIC,
  market_price NUMERIC,
  note TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS date TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS vendor TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS spec TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS price NUMERIC;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS market_price NUMERIC;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE vendor_quotes ADD COLUMN IF NOT EXISTS data_json JSONB;

CREATE INDEX IF NOT EXISTS idx_vendor_quotes_updated_at ON vendor_quotes (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_quotes_deleted_at ON vendor_quotes (deleted_at);

-- 2) 採購／叫貨單（對應 localStorage：dk_purchase_orders_v1）
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  supplier_order_date TEXT,
  expected_date TEXT,
  note TEXT,
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  deleted_at TIMESTAMPTZ,
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS order_no TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_order_date TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS items_json JSONB;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS data_json JSONB;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_updated_at ON purchase_orders (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_order_no ON purchase_orders (order_no);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_deleted_at ON purchase_orders (deleted_at);

-- 3) RLS（沿用現有 anon 公開讀寫模式；有風險，見檔案頂部說明）
ALTER TABLE vendor_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_quotes' AND policyname = 'anon_all'
  ) THEN
    CREATE POLICY "anon_all" ON vendor_quotes FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'anon_all'
  ) THEN
    CREATE POLICY "anon_all" ON purchase_orders FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
