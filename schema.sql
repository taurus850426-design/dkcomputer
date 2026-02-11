-- 庫存＋記帳系統 - Supabase Schema
-- 執行於 Supabase SQL Editor 建立 tables（可選；目前後台先用 localStorage，之後可遷移）
-- 後台頁面：admin-v2.html（庫存 Items / 流水帳 / 訂單 / 支出 / 報表）

-- 1) Items 庫存品項
-- category: PC成品 / GPU顯卡 / PART零件 / CONSUMABLE耗材
-- condition: NEW/USED/REFURB；status: READY/TESTING/PREP/RESERVED/CLEARANCE/SCRAP
CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('PC','GPU','PART','CONSUMABLE')),
  name TEXT NOT NULL,
  spec TEXT DEFAULT '',
  condition TEXT NOT NULL DEFAULT 'USED' CHECK (condition IN ('NEW','USED','REFURB')),
  status TEXT NOT NULL DEFAULT 'TESTING' CHECK (status IN ('READY','TESTING','PREP','RESERVED','CLEARANCE','SCRAP')),
  qty_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  cost_unit NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_list NUMERIC(12,2),
  price_floor NUMERIC(12,2),
  inbound_date DATE,
  last_moved_at TIMESTAMPTZ,
  reorder_point INTEGER DEFAULT 0,
  location TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_inbound_date ON items(inbound_date);
CREATE INDEX IF NOT EXISTS idx_items_last_moved_at ON items(last_moved_at);

-- 2) InventoryLedger 庫存流水帳
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJUST')),
  qty INTEGER NOT NULL,
  unit_cost NUMERIC(12,2) DEFAULT 0,
  ref_type TEXT CHECK (ref_type IN ('PURCHASE','ORDER','RMA','SCRAP','MOVE','ADJUST')),
  ref_id TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  note TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_ledger_item_id ON inventory_ledger(item_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON inventory_ledger(created_at);

-- 3) Orders 訂單
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT UNIQUE NOT NULL,
  customer_name TEXT DEFAULT '',
  total_sale NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_income NUMERIC(12,2) DEFAULT 0,
  discount NUMERIC(12,2) DEFAULT 0,
  payment_method TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','paid','shipped','completed','refunded')),
  cogs_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_profit NUMERIC(12,2) GENERATED ALWAYS AS (total_sale + COALESCE(shipping_income,0) - COALESCE(discount,0) - cogs_total) STORED,
  created_at TIMESTAMPTZ DEFAULT now(),
  shipped_at TIMESTAMPTZ
);

-- gross_margin 用 view 或應用層計算: gross_profit / (total_sale + shipping_income - discount)
CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- 4) Expenses 支出
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('COGS','OPEX','OTHER')),
  category TEXT DEFAULT '',
  amount NUMERIC(12,2) NOT NULL,
  note TEXT DEFAULT '',
  ref_item_id TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses(type);
