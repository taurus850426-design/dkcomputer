-- ============================================================
-- DK Computer Stage 7：v2_data 拆表 Migration
-- staff 在資料庫層真正拿不到成本
--
-- Production live 狀態（2026-08-20，M5 cutover 已完成）：
--   M0_SCHEMA = PASS
--   M1 migration / resync = PASS
--   M2_VERIFY = PASS
--   M3_RLS = SUCCESS
--   M4_RPC = SUCCESS
--   M5_CUTOVER SQL = SUCCESS
-- 本檔為已執行紀錄與 rollback 參考。不要重跑任何 SECTION。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解語句；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會建表、搬資料、改 RLS、切流量。
--
-- 使用方式（歷史）：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
--
-- 禁止：
--   DROP / ALTER / UPDATE / DELETE public.v2_data
--   改 site_config / inventory / vendor_quotes / purchase_orders
--   改 Storage / profiles schema
--   改 is_admin() / is_enabled_backoffice_user() 語意
--   使用 service_role key 從前端呼叫
--
-- 正式 SoT 已切到正規表 + RPC。v2_data 保留作 archive，禁止 DROP。
-- 前端不再 GET / POST v2_data。
--
-- 已知限制（Stage 7-2C，live 仍適用）：
--   ledger_orphan_item_id = 51；order_line_orphan_item_id = 33。
--   第一版不對 ledger.item_id / order_items.item_id /
--   expenses.ref_item_id / audit_logs.target_id 加 FK。
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。M0–M5 已在 Production live 完成。本檔僅供紀錄／rollback 參考，不要重跑。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT_KEYS（只讀診斷；非正式 M2_VERIFY。可在有 admin SQL Editor 時先跑）
-- 不輸出成本值、客戶姓名、note 內容。
-- 請複製本 SECTION 單獨執行。
-- ============================================================
/*

-- 1) 確認只有 default 列
SELECT id, jsonb_typeof(data) AS data_type,
       jsonb_typeof(data->'items') AS items_type,
       jsonb_typeof(data->'ledger') AS ledger_type,
       jsonb_typeof(data->'orders') AS orders_type,
       jsonb_typeof(data->'expenses') AS expenses_type,
       jsonb_typeof(data->'auditLogs') AS audit_type
FROM public.v2_data
WHERE id = 'default';

-- 2) counts（無內容）
SELECT
  jsonb_array_length(COALESCE(data->'items', '[]'::jsonb)) AS items_count,
  jsonb_array_length(COALESCE(data->'ledger', '[]'::jsonb)) AS ledger_count,
  jsonb_array_length(COALESCE(data->'orders', '[]'::jsonb)) AS orders_count,
  jsonb_array_length(COALESCE(data->'expenses', '[]'::jsonb)) AS expenses_count,
  jsonb_array_length(COALESCE(data->'auditLogs', '[]'::jsonb)) AS audit_count
FROM public.v2_data
WHERE id = 'default';

-- 3) 實際出現過的 key（無值）
SELECT 'items' AS src, jsonb_object_keys(elem) AS k
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'items', '[]'::jsonb)) elem
WHERE d.id = 'default'
UNION
SELECT 'ledger', jsonb_object_keys(elem)
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'ledger', '[]'::jsonb)) elem
WHERE d.id = 'default'
UNION
SELECT 'orders', jsonb_object_keys(elem)
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'orders', '[]'::jsonb)) elem
WHERE d.id = 'default'
UNION
SELECT 'order_items', jsonb_object_keys(line)
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'orders', '[]'::jsonb)) ord,
     LATERAL jsonb_array_elements(COALESCE(ord->'items', '[]'::jsonb)) line
WHERE d.id = 'default'
UNION
SELECT 'expenses', jsonb_object_keys(elem)
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'expenses', '[]'::jsonb)) elem
WHERE d.id = 'default'
UNION
SELECT 'auditLogs', jsonb_object_keys(elem)
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs', '[]'::jsonb)) elem
WHERE d.id = 'default'
ORDER BY 1, 2;

-- 4) orphan / 關聯（只計數，不列 id 對應的名稱或金額）
SELECT
  (
    SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
    WHERE COALESCE(e->>'item_id','') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
        WHERE i->>'id' = e->>'item_id'
      )
  ) AS ledger_orphan_item_id,
  (
    SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
                         jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) line
    WHERE COALESCE(line->>'item_id', line->>'id', '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
        WHERE i->>'id' = COALESCE(line->>'item_id', line->>'id')
      )
  ) AS order_line_orphan_item_id,
  (
    SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.data->'expenses','[]'::jsonb)) e
    WHERE COALESCE(e->>'ref_item_id','') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
        WHERE i->>'id' = e->>'ref_item_id'
      )
  ) AS expense_orphan_ref_item_id,
  (
    SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE i->>'id' IS NULL OR i->>'id' = ''
  ) AS items_missing_id,
  (
    SELECT COUNT(*) FROM (
      SELECT i->>'id' AS id
      FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
      GROUP BY 1 HAVING COUNT(*) > 1
    ) dup
  ) AS items_duplicate_id
FROM public.v2_data d
WHERE d.id = 'default';

-- 5) 成本覆蓋（只計有/無，不輸出金額）
SELECT
  COUNT(*) FILTER (WHERE (i ? 'cost_unit')) AS items_with_cost_key,
  COUNT(*) FILTER (WHERE NOT (i ? 'cost_unit')) AS items_without_cost_key,
  COUNT(*) FILTER (WHERE (i->>'isArchived') = 'true' OR NULLIF(i->>'archivedAt','') IS NOT NULL) AS items_archived_like
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
WHERE d.id = 'default';

*/


-- ============================================================
-- SECTION M0_SCHEMA  ★ Production live = PASS。不要重跑。
-- 建 10 張空表 / index / updated_at trigger / RLS enable / client DENY。
-- 不搬資料。不切正式讀寫。不建 RPC。不改 v2_data。
--
-- 本區預設註解，避免誤貼整份檔案時建表。
-- 請只複製本 SECTION，刪除下方 /* 與對應 */ 後執行。
-- ============================================================
/*

DO $$
DECLARE
  v2_cnt integer;
  tbl text;
  expected constant text[] := ARRAY[
    'inventory_items',
    'inventory_costs',
    'inventory_ledger',
    'inventory_ledger_costs',
    'orders',
    'order_costs',
    'order_items',
    'order_item_costs',
    'expenses',
    'audit_logs'
  ];
  has_extra boolean;
BEGIN
  IF to_regclass('public.v2_data') IS NULL THEN
    RAISE EXCEPTION 'M0 中止：public.v2_data 不存在';
  END IF;

  SELECT COUNT(*) INTO v2_cnt FROM public.v2_data WHERE id = 'default';
  IF v2_cnt <> 1 THEN
    RAISE EXCEPTION 'M0 中止：v2_data id=default 必須恰好 1 列（目前 %）', v2_cnt;
  END IF;

  FOREACH tbl IN ARRAY expected LOOP
    IF to_regclass(format('%I.%I', 'public', tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = tbl
        AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'M0 中止：public.% 已存在但不是普通 table，拒絕覆蓋', tbl;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = tbl
        AND column_name = 'extra'
        AND udt_name = 'jsonb'
    ) INTO has_extra;
    IF NOT has_extra THEN
      RAISE EXCEPTION 'M0 中止：public.% 已存在且沒有 extra JSONB，視為非 Stage 7 物件，拒絕覆蓋', tbl;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id TEXT PRIMARY KEY,
  sku TEXT,
  category TEXT,
  sub_type TEXT,
  brand TEXT,
  model TEXT,
  name TEXT,
  spec TEXT,
  vendor TEXT,
  condition TEXT,
  status TEXT,
  qty_on_hand NUMERIC NOT NULL DEFAULT 0,
  price_list NUMERIC,
  price_floor NUMERIC,
  inbound_date DATE,
  last_moved_at TIMESTAMPTZ,
  reorder_point NUMERIC,
  location TEXT,
  notes TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_sku_lower_uidx
  ON public.inventory_items (lower(sku))
  WHERE sku IS NOT NULL AND sku <> '';

CREATE TABLE IF NOT EXISTS public.inventory_costs (
  item_id TEXT PRIMARY KEY REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  cost_unit NUMERIC NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_ledger (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  type TEXT NOT NULL,
  qty NUMERIC NOT NULL DEFAULT 0,
  ref_type TEXT,
  ref_id TEXT,
  note TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_ledger_item_id_idx
  ON public.inventory_ledger (item_id);

CREATE TABLE IF NOT EXISTS public.inventory_ledger_costs (
  ledger_id TEXT PRIMARY KEY REFERENCES public.inventory_ledger(id) ON DELETE CASCADE,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.orders (
  id TEXT PRIMARY KEY,
  order_no TEXT,
  customer_name TEXT,
  sales_type TEXT,
  total_sale NUMERIC NOT NULL DEFAULT 0,
  shipping_income NUMERIC NOT NULL DEFAULT 0,
  discount NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT,
  status TEXT,
  shipped_at TIMESTAMPTZ,
  date DATE,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_uidx
  ON public.orders (order_no)
  WHERE order_no IS NOT NULL AND order_no <> '';

CREATE TABLE IF NOT EXISTS public.order_costs (
  order_id TEXT PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  cogs_total NUMERIC NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  item_id TEXT,
  sku TEXT,
  name TEXT,
  spec TEXT,
  qty NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx
  ON public.order_items (order_id);

CREATE INDEX IF NOT EXISTS order_items_item_id_idx
  ON public.order_items (item_id);

CREATE TABLE IF NOT EXISTS public.order_item_costs (
  order_item_id TEXT PRIMARY KEY REFERENCES public.order_items(id) ON DELETE CASCADE,
  cost_unit NUMERIC NOT NULL DEFAULT 0,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id TEXT PRIMARY KEY,
  date DATE,
  type TEXT,
  category TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  note TEXT,
  ref_item_id TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  display_name TEXT,
  action TEXT,
  target_id TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON public.audit_logs (created_at DESC);

-- 若先前草稿已建表，只補第一版需要的欄；不改既有型別、不加 FK。
ALTER TABLE public.inventory_costs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(req.tbl || '.' || req.col, ', ' ORDER BY req.tbl, req.col)
  INTO missing
  FROM (VALUES
    ('inventory_items', 'id'),
    ('inventory_items', 'qty_on_hand'),
    ('inventory_items', 'extra'),
    ('inventory_items', 'created_at'),
    ('inventory_items', 'updated_at'),
    ('inventory_costs', 'item_id'),
    ('inventory_costs', 'cost_unit'),
    ('inventory_costs', 'created_at'),
    ('inventory_costs', 'updated_at'),
    ('inventory_ledger', 'id'),
    ('inventory_ledger', 'item_id'),
    ('inventory_ledger', 'extra'),
    ('inventory_ledger_costs', 'ledger_id'),
    ('inventory_ledger_costs', 'unit_cost'),
    ('orders', 'id'),
    ('orders', 'order_no'),
    ('orders', 'customer_name'),
    ('orders', 'date'),
    ('orders', 'extra'),
    ('order_costs', 'order_id'),
    ('order_costs', 'cogs_total'),
    ('order_items', 'id'),
    ('order_items', 'order_id'),
    ('order_items', 'item_id'),
    ('order_items', 'sku'),
    ('order_items', 'name'),
    ('order_items', 'spec'),
    ('order_items', 'qty'),
    ('order_items', 'unit_price'),
    ('order_item_costs', 'order_item_id'),
    ('order_item_costs', 'cost_unit'),
    ('expenses', 'id'),
    ('expenses', 'ref_item_id'),
    ('expenses', 'updated_at'),
    ('audit_logs', 'id'),
    ('audit_logs', 'user_id'),
    ('audit_logs', 'target_id'),
    ('audit_logs', 'created_at')
  ) AS req(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = req.tbl
      AND c.column_name = req.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'M0 中止：schema 不相容，缺欄 %', missing;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_items'
      AND column_name = 'cost_unit'
  ) THEN
    RAISE EXCEPTION 'M0 中止：inventory_items 不得含 cost_unit';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_ledger'
      AND column_name = 'unit_cost'
  ) THEN
    RAISE EXCEPTION 'M0 中止：inventory_ledger 不得含 unit_cost';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name = 'cogs_total'
  ) THEN
    RAISE EXCEPTION 'M0 中止：orders 不得含 cogs_total';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_items'
      AND column_name = 'cost_unit'
  ) THEN
    RAISE EXCEPTION 'M0 中止：order_items 不得含 cost_unit';
  END IF;
END $$;

-- updated_at：INVOKER，不碰 v2_data。M0 不建補貨／訂單 RPC。
CREATE OR REPLACE FUNCTION public.dk_stage7_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_stage7_set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dk_stage7_set_updated_at() FROM anon;
REVOKE ALL ON FUNCTION public.dk_stage7_set_updated_at() FROM authenticated;

DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.inventory_items;
CREATE TRIGGER trg_dk_stage7_set_updated_at
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_stage7_set_updated_at();

DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.inventory_costs;
CREATE TRIGGER trg_dk_stage7_set_updated_at
  BEFORE UPDATE ON public.inventory_costs
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_stage7_set_updated_at();

DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.orders;
CREATE TRIGGER trg_dk_stage7_set_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_stage7_set_updated_at();

DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.expenses;
CREATE TRIGGER trg_dk_stage7_set_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE PROCEDURE public.dk_stage7_set_updated_at();

COMMENT ON TABLE public.inventory_items IS 'Stage 7 ops items; no cost_unit';
COMMENT ON TABLE public.inventory_costs IS 'admin-only item unit cost; staff must not SELECT';
COMMENT ON TABLE public.inventory_ledger IS 'historical ledger; item_id TEXT nullable, no FK';
COMMENT ON TABLE public.inventory_ledger_costs IS 'admin-only ledger unit_cost snapshot';
COMMENT ON TABLE public.orders IS 'Stage 7 orders; no cogs_total';
COMMENT ON TABLE public.order_costs IS 'admin-only order COGS';
COMMENT ON TABLE public.order_items IS 'line snapshot; item_id TEXT nullable, no FK';
COMMENT ON TABLE public.order_item_costs IS 'admin-only order line cost_unit snapshot';
COMMENT ON TABLE public.expenses IS 'admin-only; ref_item_id TEXT nullable, no FK';
COMMENT ON TABLE public.audit_logs IS 'admin-only first version; timestamp mapped to created_at';

-- M0：enable RLS + 撤 client 權限。不建允許 policy（等 M3）。
-- 若曾誤跑 M3，這裡把已知 policy 拿掉，恢復 fail-closed。
DO $$
DECLARE
  t text;
  expected constant text[] := ARRAY[
    'inventory_items',
    'inventory_costs',
    'inventory_ledger',
    'inventory_ledger_costs',
    'orders',
    'order_costs',
    'order_items',
    'order_item_costs',
    'expenses',
    'audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY expected LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS inventory_items_select_backoffice ON public.inventory_items;
DROP POLICY IF EXISTS inventory_items_write_admin ON public.inventory_items;
DROP POLICY IF EXISTS inventory_costs_admin ON public.inventory_costs;
DROP POLICY IF EXISTS inventory_ledger_select_backoffice ON public.inventory_ledger;
DROP POLICY IF EXISTS inventory_ledger_write_admin ON public.inventory_ledger;
DROP POLICY IF EXISTS inventory_ledger_costs_admin ON public.inventory_ledger_costs;
DROP POLICY IF EXISTS orders_select_backoffice ON public.orders;
DROP POLICY IF EXISTS orders_write_admin ON public.orders;
DROP POLICY IF EXISTS order_costs_admin ON public.order_costs;
DROP POLICY IF EXISTS order_items_select_backoffice ON public.order_items;
DROP POLICY IF EXISTS order_items_write_admin ON public.order_items;
DROP POLICY IF EXISTS order_item_costs_admin ON public.order_item_costs;
DROP POLICY IF EXISTS expenses_admin ON public.expenses;
DROP POLICY IF EXISTS audit_logs_admin ON public.audit_logs;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
    WHERE n.nspname = 'public'
      AND con.contype = 'f'
      AND a.attisdropped = false
      AND (
        (c.relname = 'inventory_ledger' AND a.attname = 'item_id')
        OR (c.relname = 'order_items' AND a.attname = 'item_id')
        OR (c.relname = 'expenses' AND a.attname = 'ref_item_id')
        OR (c.relname = 'audit_logs' AND a.attname = 'target_id')
      )
  ) THEN
    RAISE EXCEPTION 'M0 中止：歷史 item ref 被加上 FK';
  END IF;
END $$;

-- ---------- M0 只讀驗證（不 SELECT v2_data.data）----------
SELECT 'inventory_items' AS table_name, (SELECT COUNT(*) FROM public.inventory_items) AS row_count,
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inventory_items') AS rls_enabled
UNION ALL SELECT 'inventory_costs', (SELECT COUNT(*) FROM public.inventory_costs),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inventory_costs')
UNION ALL SELECT 'inventory_ledger', (SELECT COUNT(*) FROM public.inventory_ledger),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inventory_ledger')
UNION ALL SELECT 'inventory_ledger_costs', (SELECT COUNT(*) FROM public.inventory_ledger_costs),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inventory_ledger_costs')
UNION ALL SELECT 'orders', (SELECT COUNT(*) FROM public.orders),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'orders')
UNION ALL SELECT 'order_costs', (SELECT COUNT(*) FROM public.order_costs),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'order_costs')
UNION ALL SELECT 'order_items', (SELECT COUNT(*) FROM public.order_items),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'order_items')
UNION ALL SELECT 'order_item_costs', (SELECT COUNT(*) FROM public.order_item_costs),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'order_item_costs')
UNION ALL SELECT 'expenses', (SELECT COUNT(*) FROM public.expenses),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'expenses')
UNION ALL SELECT 'audit_logs', (SELECT COUNT(*) FROM public.audit_logs),
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'audit_logs');

SELECT COUNT(*) AS v2_data_row_count FROM public.v2_data;
SELECT id AS v2_data_id FROM public.v2_data;

SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
    'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
  )
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

SELECT
  c.relname AS table_name,
  con.conname AS fk_name,
  pg_get_constraintdef(con.oid) AS fk_def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND con.contype = 'f'
  AND c.relname IN (
    'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
    'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
  )
ORDER BY 1, 2;

*/

-- ============================================================
-- END SECTION M0_SCHEMA
-- 預期：10 表存在、row_count 全 0、rls_enabled 全 true、
-- client grants 0 列、v2_data 仍有 default、未讀 data。
-- 不要繼續執行 M1。
-- ============================================================


-- ============================================================
-- SECTION M1_PRECHECK（只讀；歷史：M1_BACKFILL 前必跑）
-- Production live：M1 = PASS。不要重跑。
-- 不輸出成本值、客戶姓名、note。
-- 上次確認 live：items 190 / ledger 291 / orders 70 / order_lines 226 /
-- expenses 0 / auditLogs 16 / ledger_orphan 51 / order_line_orphan 33。
-- 第一次 M1 前：10 張新表 row_count 應全 0。
-- ============================================================
/*

SELECT
  (SELECT COUNT(*) FROM public.v2_data) AS v2_data_row_count,
  (SELECT COUNT(*) FROM public.v2_data WHERE id = 'default') AS v2_data_default_count,
  (SELECT jsonb_array_length(COALESCE(data->'items','[]'::jsonb)) FROM public.v2_data WHERE id='default') AS legacy_items,
  (SELECT jsonb_array_length(COALESCE(data->'ledger','[]'::jsonb)) FROM public.v2_data WHERE id='default') AS legacy_ledger,
  (SELECT jsonb_array_length(COALESCE(data->'orders','[]'::jsonb)) FROM public.v2_data WHERE id='default') AS legacy_orders,
  (SELECT COUNT(*) FROM jsonb_array_elements((SELECT data->'orders' FROM public.v2_data WHERE id='default')) o,
                       jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))) AS legacy_order_lines,
  (SELECT jsonb_array_length(COALESCE(data->'expenses','[]'::jsonb)) FROM public.v2_data WHERE id='default') AS legacy_expenses,
  (SELECT jsonb_array_length(COALESCE(data->'auditLogs','[]'::jsonb)) FROM public.v2_data WHERE id='default') AS legacy_audit,
  (SELECT COUNT(*) FROM public.inventory_items) AS new_items,
  (SELECT COUNT(*) FROM public.inventory_ledger) AS new_ledger,
  (SELECT COUNT(*) FROM public.orders) AS new_orders,
  (SELECT COUNT(*) FROM public.order_items) AS new_order_items,
  (SELECT COUNT(*) FROM public.expenses) AS new_expenses,
  (SELECT COUNT(*) FROM public.audit_logs) AS new_audit;

SELECT
  (
    SELECT COUNT(*) FROM (
      SELECT i->>'id' FROM jsonb_array_elements((SELECT data->'items' FROM public.v2_data WHERE id='default')) i
      GROUP BY 1 HAVING COUNT(*) > 1
    ) s
  ) AS dup_item_id_groups,
  (
    SELECT COUNT(*) FROM jsonb_array_elements((SELECT data->'items' FROM public.v2_data WHERE id='default')) i
    WHERE i->>'id' IS NULL OR i->>'id' = ''
  ) AS items_missing_id,
  (
    SELECT COUNT(*) FROM (
      SELECT lower(i->>'sku') FROM jsonb_array_elements((SELECT data->'items' FROM public.v2_data WHERE id='default')) i
      WHERE NULLIF(i->>'sku','') IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) > 1
    ) s
  ) AS dup_sku_groups,
  (
    SELECT COUNT(*) FROM (
      SELECT e->>'id' FROM jsonb_array_elements((SELECT data->'ledger' FROM public.v2_data WHERE id='default')) e
      GROUP BY 1 HAVING COUNT(*) > 1
    ) s
  ) AS dup_ledger_id_groups,
  (
    SELECT COUNT(*) FROM (
      SELECT o->>'id' FROM jsonb_array_elements((SELECT data->'orders' FROM public.v2_data WHERE id='default')) o
      GROUP BY 1 HAVING COUNT(*) > 1
    ) s
  ) AS dup_order_id_groups,
  (
    SELECT COUNT(*) FROM (
      SELECT o->>'order_no' FROM jsonb_array_elements((SELECT data->'orders' FROM public.v2_data WHERE id='default')) o
      WHERE NULLIF(o->>'order_no','') IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) > 1
    ) s
  ) AS dup_order_no_groups,
  (
    SELECT COUNT(*) FROM jsonb_array_elements((SELECT data->'ledger' FROM public.v2_data WHERE id='default')) e
    WHERE COALESCE(e->>'item_id','') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements((SELECT data->'items' FROM public.v2_data WHERE id='default')) i
        WHERE i->>'id' = e->>'item_id'
      )
  ) AS ledger_orphan,
  (
    SELECT COUNT(*) FROM jsonb_array_elements((SELECT data->'orders' FROM public.v2_data WHERE id='default')) o,
                         jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) line
    WHERE COALESCE(line->>'item_id', line->>'id', '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements((SELECT data->'items' FROM public.v2_data WHERE id='default')) i
        WHERE i->>'id' = COALESCE(line->>'item_id', line->>'id')
      )
  ) AS order_line_orphan;

*/


-- ============================================================
-- SECTION M1_BACKFILL  ★ 先完成 M1_PRECHECK；本區預設註解
-- 只從 public.v2_data id='default' 讀。只寫 10 張 Stage 7 新表。
-- 禁止 UPDATE / DELETE / ALTER / DROP v2_data。
-- 不重算 qty / cogs / cost；orphan 全留；ON CONFLICT 可重跑。
-- 正式前端仍走 v2_data。
--
-- 訂單明細 PK 固定為 order_id || ':' || ordinality。
-- 不用 line.id 當 PK（前端明細常無獨立 id，舊資料可能用品項 id）。
-- JOIN 必須用 CROSS JOIN LATERAL，不可寫「逗號 FROM + JOIN」：
-- PostgreSQL 的 JOIN 比逗號綁得更緊，ON 看不到前面的 ord。
-- ============================================================
/*

BEGIN;

DO $$
DECLARE
  v2_cnt integer;
  dup_item integer;
  dup_ledger integer;
  dup_order integer;
  dup_audit integer;
  sku_dup_groups integer;
  order_no_dup_groups integer;
BEGIN
  IF to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.inventory_costs') IS NULL
     OR to_regclass('public.inventory_ledger') IS NULL
     OR to_regclass('public.inventory_ledger_costs') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_costs') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.order_item_costs') IS NULL
     OR to_regclass('public.expenses') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'M1 中止：缺少 M0 新表。請先完成 M0_SCHEMA。';
  END IF;
  IF to_regclass('public.v2_data') IS NULL THEN
    RAISE EXCEPTION 'M1 中止：缺少 v2_data。';
  END IF;

  SELECT COUNT(*) INTO v2_cnt FROM public.v2_data WHERE id = 'default';
  IF v2_cnt <> 1 THEN
    RAISE EXCEPTION 'M1 中止：v2_data id=default 必須恰好 1 列（目前 %）', v2_cnt;
  END IF;

  SELECT COUNT(*) INTO dup_item FROM (
    SELECT i->>'id' AS id
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_ledger FROM (
    SELECT e->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_order FROM (
    SELECT o->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_audit FROM (
    SELECT a->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) a
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  IF dup_item > 0 OR dup_ledger > 0 OR dup_order > 0 OR dup_audit > 0 THEN
    RAISE EXCEPTION 'M1 中止：來源 PK 重複（item=% ledger=% order=% audit=%）。ON CONFLICT 會合併列，拒絕執行',
      dup_item, dup_ledger, dup_order, dup_audit;
  END IF;

  -- 歷史 sku / order_no 重複時，unique index 會讓 INSERT 失敗並丟列。
  -- 新表尚無 runtime 呼叫端；改非 unique，完整保留歷史列。
  SELECT COUNT(*) INTO sku_dup_groups FROM (
    SELECT lower(i->>'sku')
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default'
      AND NULLIF(i->>'sku','') IS NOT NULL
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO order_no_dup_groups FROM (
    SELECT o->>'order_no'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
    WHERE d.id = 'default'
      AND NULLIF(o->>'order_no','') IS NOT NULL
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;

  IF sku_dup_groups > 0 THEN
    EXECUTE 'DROP INDEX IF EXISTS public.inventory_items_sku_lower_uidx';
    EXECUTE 'CREATE INDEX IF NOT EXISTS inventory_items_sku_lower_idx ON public.inventory_items (lower(sku)) WHERE sku IS NOT NULL AND sku <> ''''';
    RAISE NOTICE 'M1：% 組重複 sku，已改非 unique index，不丟列', sku_dup_groups;
  END IF;
  IF order_no_dup_groups > 0 THEN
    EXECUTE 'DROP INDEX IF EXISTS public.orders_order_no_uidx';
    EXECUTE 'CREATE INDEX IF NOT EXISTS orders_order_no_idx ON public.orders (order_no) WHERE order_no IS NOT NULL AND order_no <> ''''';
    RAISE NOTICE 'M1：% 組重複 order_no，已改非 unique index，不丟列', order_no_dup_groups;
  END IF;
END $$;

ALTER TABLE public.inventory_items DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.inventory_costs DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.orders DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.expenses DISABLE TRIGGER trg_dk_stage7_set_updated_at;

INSERT INTO public.inventory_items (
  id, sku, category, sub_type, brand, model, name, spec, vendor, condition, status,
  qty_on_hand, price_list, price_floor, inbound_date, last_moved_at, reorder_point,
  location, notes, is_archived, archived_at, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text)),
  NULLIF(i->>'sku',''),
  NULLIF(i->>'category',''),
  NULLIF(i->>'sub_type',''),
  NULLIF(i->>'brand',''),
  NULLIF(i->>'model',''),
  NULLIF(i->>'name',''),
  NULLIF(i->>'spec',''),
  NULLIF(i->>'vendor',''),
  NULLIF(i->>'condition',''),
  NULLIF(i->>'status',''),
  COALESCE(NULLIF(i->>'qty_on_hand','')::numeric, 0),
  NULLIF(i->>'price_list','')::numeric,
  NULLIF(i->>'price_floor','')::numeric,
  NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '')::date,
  NULLIF(i->>'last_moved_at','')::timestamptz,
  NULLIF(i->>'reorder_point','')::numeric,
  NULLIF(i->>'location',''),
  NULLIF(i->>'notes',''),
  CASE
    WHEN lower(COALESCE(i->>'isArchived','')) IN ('true','t','1') THEN true
    WHEN lower(COALESCE(i->>'isArchived','')) IN ('false','f','0') THEN false
    ELSE (NULLIF(i->>'archivedAt','') IS NOT NULL)
  END,
  NULLIF(i->>'archivedAt','')::timestamptz,
  (i - ARRAY['id','sku','category','sub_type','brand','model','name','spec','vendor','condition','status','qty_on_hand','cost_unit','costUnit','unit_cost','cogs_total','cogs','price_list','price_floor','inbound_date','last_moved_at','reorder_point','location','notes','isArchived','archivedAt','created_at','updated_at']::text[]),
  COALESCE(NULLIF(i->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(i->>'updated_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  sku = EXCLUDED.sku,
  category = EXCLUDED.category,
  sub_type = EXCLUDED.sub_type,
  brand = EXCLUDED.brand,
  model = EXCLUDED.model,
  name = EXCLUDED.name,
  spec = EXCLUDED.spec,
  vendor = EXCLUDED.vendor,
  condition = EXCLUDED.condition,
  status = EXCLUDED.status,
  qty_on_hand = EXCLUDED.qty_on_hand,
  price_list = EXCLUDED.price_list,
  price_floor = EXCLUDED.price_floor,
  inbound_date = EXCLUDED.inbound_date,
  last_moved_at = EXCLUDED.last_moved_at,
  reorder_point = EXCLUDED.reorder_point,
  location = EXCLUDED.location,
  notes = EXCLUDED.notes,
  is_archived = EXCLUDED.is_archived,
  archived_at = EXCLUDED.archived_at,
  extra = EXCLUDED.extra,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.inventory_costs (item_id, cost_unit, extra, created_at, updated_at)
SELECT
  it.id,
  COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0),
  '{}'::jsonb,
  COALESCE(NULLIF(i->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(i->>'updated_at','')::timestamptz, now())
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
INNER JOIN public.inventory_items it
  ON it.id = COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text))
WHERE d.id = 'default'
ON CONFLICT (item_id) DO UPDATE SET
  cost_unit = EXCLUDED.cost_unit,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.inventory_ledger (
  id, item_id, type, qty, ref_type, ref_id, note, extra, created_at
)
SELECT
  COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text)),
  NULLIF(e->>'item_id',''),
  COALESCE(NULLIF(e->>'type',''), 'ADJUST'),
  COALESCE(NULLIF(e->>'qty','')::numeric, 0),
  NULLIF(e->>'ref_type',''),
  NULLIF(e->>'ref_id',''),
  NULLIF(e->>'note',''),
  (e - ARRAY['id','item_id','type','qty','unit_cost','cost_unit','costUnit','cogs_total','ref_type','ref_id','note','created_at']::text[]),
  COALESCE(NULLIF(e->>'created_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  item_id = EXCLUDED.item_id,
  type = EXCLUDED.type,
  qty = EXCLUDED.qty,
  ref_type = EXCLUDED.ref_type,
  ref_id = EXCLUDED.ref_id,
  note = EXCLUDED.note,
  extra = EXCLUDED.extra;

INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost, extra)
SELECT
  l.id,
  COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0),
  '{}'::jsonb
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
INNER JOIN public.inventory_ledger l
  ON l.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
WHERE d.id = 'default'
ON CONFLICT (ledger_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost;

INSERT INTO public.orders (
  id, order_no, customer_name, sales_type, total_sale, shipping_income, discount,
  payment_method, status, shipped_at, date, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text)),
  NULLIF(o->>'order_no',''),
  NULLIF(o->>'customer_name',''),
  NULLIF(COALESCE(o->>'salesType', o->>'sales_type'), ''),
  COALESCE(NULLIF(o->>'total_sale','')::numeric, 0),
  COALESCE(NULLIF(o->>'shipping_income','')::numeric, 0),
  COALESCE(NULLIF(o->>'discount','')::numeric, 0),
  NULLIF(o->>'payment_method',''),
  NULLIF(o->>'status',''),
  NULLIF(o->>'shipped_at','')::timestamptz,
  NULLIF(left(COALESCE(o->>'date', o->>'created_at'), 10), '')::date,
  (o - ARRAY['id','order_no','customer_name','salesType','sales_type','total_sale','shipping_income','discount','payment_method','status','cogs_total','cogs','cost_unit','costUnit','created_at','updated_at','shipped_at','date','items']::text[]),
  COALESCE(NULLIF(o->>'created_at','')::timestamptz, NULLIF(o->>'date','')::timestamptz, now()),
  COALESCE(NULLIF(o->>'updated_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  order_no = EXCLUDED.order_no,
  customer_name = EXCLUDED.customer_name,
  sales_type = EXCLUDED.sales_type,
  total_sale = EXCLUDED.total_sale,
  shipping_income = EXCLUDED.shipping_income,
  discount = EXCLUDED.discount,
  payment_method = EXCLUDED.payment_method,
  status = EXCLUDED.status,
  shipped_at = EXCLUDED.shipped_at,
  date = EXCLUDED.date,
  extra = EXCLUDED.extra,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.order_costs (order_id, cogs_total, extra)
SELECT
  ord.id,
  COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0),
  '{}'::jsonb
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
INNER JOIN public.orders ord
  ON ord.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
WHERE d.id = 'default'
ON CONFLICT (order_id) DO UPDATE SET cogs_total = EXCLUDED.cogs_total;

INSERT INTO public.order_items (
  id, order_id, item_id, sku, name, spec, qty, unit_price, extra
)
SELECT
  COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
    || ':' || (line.ordinality::text),
  COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)),
  NULLIF(COALESCE(line.elem->>'item_id', line.elem->>'id'), ''),
  NULLIF(line.elem->>'sku',''),
  NULLIF(line.elem->>'name',''),
  NULLIF(line.elem->>'spec',''),
  COALESCE(NULLIF(line.elem->>'qty','')::numeric, 0),
  COALESCE(NULLIF(COALESCE(line.elem->>'unit_price', line.elem->>'unitPrice'),'')::numeric, 0),
  (line.elem - ARRAY['id','item_id','sku','name','spec','qty','unit_price','unitPrice','cost_unit','costUnit','unit_cost','cogs']::text[])
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  item_id = EXCLUDED.item_id,
  sku = EXCLUDED.sku,
  name = EXCLUDED.name,
  spec = EXCLUDED.spec,
  qty = EXCLUDED.qty,
  unit_price = EXCLUDED.unit_price,
  extra = EXCLUDED.extra;

INSERT INTO public.order_item_costs (order_item_id, cost_unit, extra)
SELECT
  src.order_item_id,
  COALESCE(NULLIF(COALESCE(src.line_elem->>'cost_unit', src.line_elem->>'costUnit'),'')::numeric, 0),
  '{}'::jsonb
FROM (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    line.elem AS line_elem
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
) src
INNER JOIN public.order_items oi
  ON oi.id = src.order_item_id
ON CONFLICT (order_item_id) DO UPDATE SET cost_unit = EXCLUDED.cost_unit;

INSERT INTO public.expenses (
  id, date, type, category, amount, note, ref_item_id, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(e->>'id',''), 'missing-exp-' || md5(e::text)),
  NULLIF(e->>'date','')::date,
  NULLIF(e->>'type',''),
  NULLIF(e->>'category',''),
  COALESCE(NULLIF(e->>'amount','')::numeric, 0),
  NULLIF(e->>'note',''),
  NULLIF(e->>'ref_item_id',''),
  (e - ARRAY['id','date','type','category','amount','note','ref_item_id','created_at','updated_at']::text[]),
  COALESCE(NULLIF(e->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(e->>'updated_at','')::timestamptz, NULLIF(e->>'created_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'expenses','[]'::jsonb)) e
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  date = EXCLUDED.date,
  type = EXCLUDED.type,
  category = EXCLUDED.category,
  amount = EXCLUDED.amount,
  note = EXCLUDED.note,
  ref_item_id = EXCLUDED.ref_item_id,
  extra = EXCLUDED.extra,
  updated_at = EXCLUDED.updated_at;

INSERT INTO public.audit_logs (
  id, user_id, display_name, action, target_id, extra, created_at
)
SELECT
  COALESCE(NULLIF(a->>'id',''), 'missing-aud-' || md5(a::text)),
  NULLIF(a->>'userId',''),
  NULLIF(a->>'displayName',''),
  NULLIF(a->>'action',''),
  NULLIF(a->>'targetId',''),
  (a - ARRAY['id','userId','displayName','action','targetId','timestamp']::text[]),
  COALESCE(NULLIF(a->>'timestamp','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) a
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  display_name = EXCLUDED.display_name,
  action = EXCLUDED.action,
  target_id = EXCLUDED.target_id,
  extra = EXCLUDED.extra;

ALTER TABLE public.inventory_items ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.inventory_costs ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.orders ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.expenses ENABLE TRIGGER trg_dk_stage7_set_updated_at;

COMMIT;

*/


-- ============================================================
-- SECTION M1_POSTCHECK（只讀；M1_BACKFILL 成功後立刻跑）
-- 不輸出成本值、客戶姓名、note。
-- 判定：legacy_count = new_count；orphan 必須相等且不得變 0。
-- 上次確認 live 預期：
--   items 190 / costs 190 / ledger 291 / ledger_costs 291 /
--   orders 70 / order_costs 70 / order_items 226 / order_item_costs 226 /
--   expenses 0 / audit 16 / ledger_orphan 51 / order_line_orphan 33
-- v2_data 必須仍是 1 列 / default。
-- trigger trg_dk_stage7_set_updated_at 必須已 ENABLE（tgenabled = O）。
-- ============================================================
/*

WITH
legacy AS (
  SELECT
    jsonb_array_length(COALESCE(data->'items','[]'::jsonb)) AS items,
    jsonb_array_length(COALESCE(data->'ledger','[]'::jsonb)) AS ledger,
    jsonb_array_length(COALESCE(data->'orders','[]'::jsonb)) AS orders,
    jsonb_array_length(COALESCE(data->'expenses','[]'::jsonb)) AS expenses,
    jsonb_array_length(COALESCE(data->'auditLogs','[]'::jsonb)) AS audit,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
    ) AS order_lines
  FROM public.v2_data
  WHERE id = 'default'
),
qty_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND COALESCE(NULLIF(i->>'qty_on_hand','')::numeric, 0) IS DISTINCT FROM n.qty_on_hand
),
archive_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND (
      CASE
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('true','t','1') THEN true
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('false','f','0') THEN false
        ELSE (NULLIF(i->>'archivedAt','') IS NOT NULL)
      END
    ) IS DISTINCT FROM n.is_archived
),
orphans AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
      WHERE COALESCE(e->>'item_id','') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = e->>'item_id'
        )
    ) AS legacy_ledger_orphan,
    (
      SELECT COUNT(*) FROM public.inventory_ledger l
      WHERE COALESCE(l.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = l.item_id)
    ) AS new_ledger_orphan,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) line
      WHERE COALESCE(line->>'item_id', line->>'id', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = COALESCE(line->>'item_id', line->>'id')
        )
    ) AS legacy_order_line_orphan,
    (
      SELECT COUNT(*) FROM public.order_items oi
      WHERE COALESCE(oi.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = oi.item_id)
    ) AS new_order_line_orphan
  FROM public.v2_data d
  WHERE d.id = 'default'
),
checksums AS (
  SELECT
    md5((
      SELECT string_agg(to_char(COALESCE(cogs_total,0), 'FM9999999990.00'), ',' ORDER BY order_id)
      FROM public.order_costs
    )) AS new_cogs,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY o->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      WHERE d.id = 'default'
    )) AS legacy_cogs,
    md5((
      SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY item_id)
      FROM public.inventory_costs
    )) AS new_item_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY i->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      WHERE d.id = 'default'
    )) AS legacy_item_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(unit_cost,0), 'FM9999999990.00'), ',' ORDER BY ledger_id)
      FROM public.inventory_ledger_costs
    )) AS new_ledger_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY e->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      WHERE d.id = 'default'
    )) AS legacy_ledger_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY order_item_id)
      FROM public.order_item_costs
    )) AS new_line_cost,
    md5((
      SELECT string_agg(
        to_char(COALESCE(NULLIF(COALESCE(line.elem->>'cost_unit', line.elem->>'costUnit'),'')::numeric, 0), 'FM9999999990.00'),
        ',' ORDER BY COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      )
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      WHERE d.id = 'default'
    )) AS legacy_line_cost
),
triggers AS (
  SELECT COUNT(*) AS enabled_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
    AND t.tgname = 'trg_dk_stage7_set_updated_at'
    AND t.tgenabled = 'O'
    AND c.relname IN ('inventory_items','inventory_costs','orders','expenses')
),
extra_cost AS (
  SELECT
    (SELECT COUNT(*) FROM public.inventory_items
      WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) AS items_extra,
    (SELECT COUNT(*) FROM public.inventory_ledger
      WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) AS ledger_extra,
    (SELECT COUNT(*) FROM public.orders
      WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) AS orders_extra,
    (SELECT COUNT(*) FROM public.order_items
      WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) AS order_items_extra
)
SELECT 10 AS seq, 'v2_data.row_count'::text AS check_name,
       (SELECT COUNT(*) FROM public.v2_data)::text AS actual,
       '1'::text AS expected,
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'v2_data.default_id',
       (SELECT COUNT(*)::text FROM public.v2_data WHERE id = 'default'),
       '1',
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data WHERE id = 'default') = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'count.items',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_items),
       'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'count.inventory_costs',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_costs),
       'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'count.ledger',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger),
       'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'count.inventory_ledger_costs',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs),
       'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'count.orders',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.orders),
       'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.orders) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'count.order_costs',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_costs),
       'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'count.order_items',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_items),
       'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'count.order_item_costs',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_item_costs),
       'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'count.expenses',
       (SELECT expenses::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.expenses),
       'equal',
       CASE WHEN (SELECT expenses FROM legacy) = (SELECT COUNT(*) FROM public.expenses) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'count.audit_logs',
       (SELECT audit::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.audit_logs),
       'equal',
       CASE WHEN (SELECT audit FROM legacy) = (SELECT COUNT(*) FROM public.audit_logs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'coverage.items_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_items) || '=' || (SELECT COUNT(*)::text FROM public.inventory_costs),
       'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_items) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'coverage.ledger_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_ledger) || '=' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs),
       'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_ledger) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'coverage.orders_eq_costs',
       (SELECT COUNT(*)::text FROM public.orders) || '=' || (SELECT COUNT(*)::text FROM public.order_costs),
       'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.orders) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'coverage.order_items_eq_costs',
       (SELECT COUNT(*)::text FROM public.order_items) || '=' || (SELECT COUNT(*)::text FROM public.order_item_costs),
       'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.order_items) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'qty_mismatch_count',
       (SELECT n::text FROM qty_mismatch),
       '0',
       CASE WHEN (SELECT n FROM qty_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'archive_mismatch_count',
       (SELECT n::text FROM archive_mismatch),
       '0',
       CASE WHEN (SELECT n FROM archive_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'items_missing_cost_row',
       (SELECT COUNT(*)::text FROM public.inventory_items i LEFT JOIN public.inventory_costs c ON c.item_id = i.id WHERE c.item_id IS NULL),
       '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.inventory_items i LEFT JOIN public.inventory_costs c ON c.item_id = i.id WHERE c.item_id IS NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'extra.inventory_items_cost_keys',
       (SELECT items_extra::text FROM extra_cost),
       '0',
       CASE WHEN (SELECT items_extra FROM extra_cost) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'extra.inventory_ledger_cost_keys',
       (SELECT ledger_extra::text FROM extra_cost),
       '0',
       CASE WHEN (SELECT ledger_extra FROM extra_cost) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'extra.orders_cost_keys',
       (SELECT orders_extra::text FROM extra_cost),
       '0',
       CASE WHEN (SELECT orders_extra FROM extra_cost) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'extra.order_items_cost_keys',
       (SELECT order_items_extra::text FROM extra_cost),
       '0',
       CASE WHEN (SELECT order_items_extra FROM extra_cost) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'orphan.ledger_equal_nonzero',
       (SELECT legacy_ledger_orphan::text || '=' || new_ledger_orphan::text FROM orphans),
       'equal and <> 0',
       CASE WHEN (SELECT legacy_ledger_orphan = new_ledger_orphan AND legacy_ledger_orphan <> 0 FROM orphans)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'orphan.order_line_equal_nonzero',
       (SELECT legacy_order_line_orphan::text || '=' || new_order_line_orphan::text FROM orphans),
       'equal and <> 0',
       CASE WHEN (SELECT legacy_order_line_orphan = new_order_line_orphan AND legacy_order_line_orphan <> 0 FROM orphans)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'checksum.item_cost_match',
       (SELECT (new_item_cost = legacy_item_cost)::text FROM checksums),
       'true',
       CASE WHEN (SELECT new_item_cost = legacy_item_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'checksum.ledger_cost_match',
       (SELECT (new_ledger_cost = legacy_ledger_cost)::text FROM checksums),
       'true',
       CASE WHEN (SELECT new_ledger_cost = legacy_ledger_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'checksum.cogs_match',
       (SELECT (new_cogs = legacy_cogs)::text FROM checksums),
       'true',
       CASE WHEN (SELECT new_cogs = legacy_cogs FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'checksum.order_line_cost_match',
       (SELECT (new_line_cost = legacy_line_cost)::text FROM checksums),
       'true',
       CASE WHEN (SELECT new_line_cost = legacy_line_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 80, 'triggers.enabled_count',
       (SELECT enabled_count::text FROM triggers),
       '4',
       CASE WHEN (SELECT enabled_count FROM triggers) = 4 THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/


-- ============================================================
-- SECTION M2_VERIFY  ★ Production live = PASS。不要重跑。
-- M1_POSTCHECK 已證明搬移列數。本區加 schema / isolation / FK /
-- fail-closed / relationship / ID strategy / extra / timestamp / numeric。
-- 只能 SELECT / WITH。每一列 verdict 必須 PASS 才能 M2 PASS / M3 READY。
-- 不輸出成本金額、客戶姓名、電話、note。
-- ============================================================
/*

WITH
legacy AS (
  SELECT
    jsonb_array_length(COALESCE(data->'items','[]'::jsonb)) AS items,
    jsonb_array_length(COALESCE(data->'ledger','[]'::jsonb)) AS ledger,
    jsonb_array_length(COALESCE(data->'orders','[]'::jsonb)) AS orders,
    jsonb_array_length(COALESCE(data->'expenses','[]'::jsonb)) AS expenses,
    jsonb_array_length(COALESCE(data->'auditLogs','[]'::jsonb)) AS audit,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
    ) AS order_lines
  FROM public.v2_data
  WHERE id = 'default'
),
tables AS (
  SELECT unnest(ARRAY[
    'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
    'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
  ]) AS table_name
),
table_meta AS (
  SELECT
    t.table_name,
    (c.oid IS NOT NULL AND c.relkind = 'r') AS exists,
    COALESCE(c.relrowsecurity, false) AS rls
  FROM tables t
  LEFT JOIN pg_class c
    ON c.relname = t.table_name
   AND c.relkind = 'r'
  LEFT JOIN pg_namespace n
    ON n.oid = c.relnamespace
   AND n.nspname = 'public'
),
qty_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND COALESCE(NULLIF(i->>'qty_on_hand','')::numeric, 0) IS DISTINCT FROM n.qty_on_hand
),
archive_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND (
      CASE
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('true','t','1') THEN true
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('false','f','0') THEN false
        ELSE (NULLIF(i->>'archivedAt','') IS NOT NULL)
      END
    ) IS DISTINCT FROM n.is_archived
),
numeric_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      INNER JOIN public.inventory_ledger n
        ON n.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(e->>'qty','')::numeric, 0) IS DISTINCT FROM n.qty
    ) AS ledger_qty,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'total_sale','')::numeric, 0) IS DISTINCT FROM n.total_sale
    ) AS order_total_sale,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'shipping_income','')::numeric, 0) IS DISTINCT FROM n.shipping_income
    ) AS order_shipping,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'discount','')::numeric, 0) IS DISTINCT FROM n.discount
    ) AS order_discount,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      INNER JOIN public.order_items n
        ON n.id = COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(COALESCE(line.elem->>'unit_price', line.elem->>'unitPrice'),'')::numeric, 0) IS DISTINCT FROM n.unit_price
    ) AS line_unit_price
),
ts_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'created_at','') IS NOT NULL
        AND NULLIF(i->>'created_at','')::timestamptz IS DISTINCT FROM n.created_at
    ) AS item_created_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'updated_at','') IS NOT NULL
        AND NULLIF(i->>'updated_at','')::timestamptz IS DISTINCT FROM n.updated_at
    ) AS item_updated_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '') IS NOT NULL
        AND NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '')::date IS DISTINCT FROM n.inbound_date
    ) AS item_inbound_date,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'last_moved_at','') IS NOT NULL
        AND NULLIF(i->>'last_moved_at','')::timestamptz IS DISTINCT FROM n.last_moved_at
    ) AS item_last_moved_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'archivedAt','')::timestamptz IS DISTINCT FROM n.archived_at
    ) AS item_archived_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND NULLIF(left(COALESCE(o->>'date', o->>'created_at'), 10), '')::date IS DISTINCT FROM n.date
    ) AS order_date,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND NULLIF(o->>'shipped_at','')::timestamptz IS DISTINCT FROM n.shipped_at
    ) AS order_shipped_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) AS a
      INNER JOIN public.audit_logs n
        ON n.id = COALESCE(NULLIF(a->>'id',''), 'missing-aud-' || md5(a::text))
      WHERE d.id = 'default'
        AND NULLIF(a->>'timestamp','') IS NOT NULL
        AND NULLIF(a->>'timestamp','')::timestamptz IS DISTINCT FROM n.created_at
    ) AS audit_timestamp
),
extra_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          i - ARRAY['id','sku','category','sub_type','brand','model','name','spec','vendor','condition','status','qty_on_hand','cost_unit','costUnit','unit_cost','cogs_total','cogs','price_list','price_floor','inbound_date','last_moved_at','reorder_point','location','notes','isArchived','archivedAt','created_at','updated_at']::text[]
        )
    ) AS items_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      INNER JOIN public.inventory_ledger n
        ON n.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          e - ARRAY['id','item_id','type','qty','unit_cost','cost_unit','costUnit','cogs_total','ref_type','ref_id','note','created_at']::text[]
        )
    ) AS ledger_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          o - ARRAY['id','order_no','customer_name','salesType','sales_type','total_sale','shipping_income','discount','payment_method','status','cogs_total','cogs','cost_unit','costUnit','created_at','updated_at','shipped_at','date','items']::text[]
        )
    ) AS orders_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      INNER JOIN public.order_items n
        ON n.id = COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          line.elem - ARRAY['id','item_id','sku','name','spec','qty','unit_price','unitPrice','cost_unit','costUnit','unit_cost','cogs']::text[]
        )
    ) AS order_items_extra
),
line_ids AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) AS order_id
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
orphans AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
      WHERE COALESCE(e->>'item_id','') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = e->>'item_id'
        )
    ) AS legacy_ledger_orphan,
    (
      SELECT COUNT(*) FROM public.inventory_ledger l
      WHERE COALESCE(l.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = l.item_id)
    ) AS new_ledger_orphan,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) line
      WHERE COALESCE(line->>'item_id', line->>'id', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = COALESCE(line->>'item_id', line->>'id')
        )
    ) AS legacy_order_line_orphan,
    (
      SELECT COUNT(*) FROM public.order_items oi
      WHERE COALESCE(oi.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = oi.item_id)
    ) AS new_order_line_orphan,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
      WHERE COALESCE(e->>'item_id','') = ''
    ) AS legacy_ledger_empty_item_id,
    (
      SELECT COUNT(*) FROM public.inventory_ledger WHERE COALESCE(item_id,'') = ''
    ) AS new_ledger_empty_item_id
  FROM public.v2_data d
  WHERE d.id = 'default'
),
checksums AS (
  SELECT
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY item_id) FROM public.inventory_costs)) AS new_item_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY i->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      WHERE d.id = 'default'
    )) AS legacy_item_cost,
    md5((SELECT string_agg(to_char(COALESCE(unit_cost,0), 'FM9999999990.00'), ',' ORDER BY ledger_id) FROM public.inventory_ledger_costs)) AS new_ledger_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY e->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      WHERE d.id = 'default'
    )) AS legacy_ledger_cost,
    md5((SELECT string_agg(to_char(COALESCE(cogs_total,0), 'FM9999999990.00'), ',' ORDER BY order_id) FROM public.order_costs)) AS new_cogs,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY o->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      WHERE d.id = 'default'
    )) AS legacy_cogs,
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY order_item_id) FROM public.order_item_costs)) AS new_line_cost,
    md5((
      SELECT string_agg(
        to_char(COALESCE(NULLIF(COALESCE(line.elem->>'cost_unit', line.elem->>'costUnit'),'')::numeric, 0), 'FM9999999990.00'),
        ',' ORDER BY COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      )
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      WHERE d.id = 'default'
    )) AS legacy_line_cost
),
fk_live AS (
  SELECT
    c.relname AS src_table,
    src.attname AS src_column,
    ref.relname AS dst_table,
    dst.attname AS dst_column
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_attribute src ON src.attrelid = c.oid AND src.attnum = con.conkey[1] AND NOT src.attisdropped
  JOIN pg_attribute dst ON dst.attrelid = ref.oid AND dst.attnum = con.confkey[1] AND NOT dst.attisdropped
  WHERE n.nspname = 'public'
    AND con.contype = 'f'
    AND c.relname IN (
      'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
      'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
    )
),
expected_fk(src_table, src_column, dst_table, dst_column) AS (
  VALUES
    ('inventory_costs','item_id','inventory_items','id'),
    ('inventory_ledger_costs','ledger_id','inventory_ledger','id'),
    ('order_costs','order_id','orders','id'),
    ('order_items','order_id','orders','id'),
    ('order_item_costs','order_item_id','order_items','id')
)
SELECT 10 AS seq, 'v2_data.row_count'::text AS check_name,
       (SELECT COUNT(*) FROM public.v2_data)::text AS actual, '1'::text AS expected,
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'v2_data.default_id',
       (SELECT COUNT(*)::text FROM public.v2_data WHERE id = 'default'), '1',
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data WHERE id = 'default') = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'schema.tables_exist',
       (SELECT COUNT(*) FILTER (WHERE exists)::text FROM table_meta), '10',
       CASE WHEN (SELECT COUNT(*) FILTER (WHERE exists) FROM table_meta) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'schema.rls_all_true',
       (SELECT COUNT(*) FILTER (WHERE exists AND rls)::text FROM table_meta), '10',
       CASE WHEN (SELECT COUNT(*) FILTER (WHERE exists AND rls) FROM table_meta) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'count.items',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_items), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'count.inventory_costs',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_costs), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'count.ledger',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger), 'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'count.inventory_ledger_costs',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs), 'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'count.orders',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.orders), 'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.orders) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'count.order_costs',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_costs), 'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'count.order_items',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_items), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'count.order_item_costs',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_item_costs), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'count.expenses',
       (SELECT expenses::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.expenses), 'equal',
       CASE WHEN (SELECT expenses FROM legacy) = (SELECT COUNT(*) FROM public.expenses) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'count.audit_logs',
       (SELECT audit::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.audit_logs), 'equal',
       CASE WHEN (SELECT audit FROM legacy) = (SELECT COUNT(*) FROM public.audit_logs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'coverage.items_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_items) || '=' || (SELECT COUNT(*)::text FROM public.inventory_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_items) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'coverage.ledger_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_ledger) || '=' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_ledger) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'coverage.orders_eq_costs',
       (SELECT COUNT(*)::text FROM public.orders) || '=' || (SELECT COUNT(*)::text FROM public.order_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.orders) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'coverage.order_items_eq_costs',
       (SELECT COUNT(*)::text FROM public.order_items) || '=' || (SELECT COUNT(*)::text FROM public.order_item_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.order_items) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'rel.missing_item_cost',
       (SELECT COUNT(*)::text FROM public.inventory_items i LEFT JOIN public.inventory_costs c ON c.item_id = i.id WHERE c.item_id IS NULL), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_items i LEFT JOIN public.inventory_costs c ON c.item_id = i.id WHERE c.item_id IS NULL) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'rel.missing_ledger_cost',
       (SELECT COUNT(*)::text FROM public.inventory_ledger l LEFT JOIN public.inventory_ledger_costs c ON c.ledger_id = l.id WHERE c.ledger_id IS NULL), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_ledger l LEFT JOIN public.inventory_ledger_costs c ON c.ledger_id = l.id WHERE c.ledger_id IS NULL) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'rel.missing_order_cost',
       (SELECT COUNT(*)::text FROM public.orders o LEFT JOIN public.order_costs c ON c.order_id = o.id WHERE c.order_id IS NULL), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.orders o LEFT JOIN public.order_costs c ON c.order_id = o.id WHERE c.order_id IS NULL) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'rel.missing_order_item_cost',
       (SELECT COUNT(*)::text FROM public.order_items oi LEFT JOIN public.order_item_costs c ON c.order_item_id = oi.id WHERE c.order_item_id IS NULL), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi LEFT JOIN public.order_item_costs c ON c.order_item_id = oi.id WHERE c.order_item_id IS NULL) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'rel.order_item_missing_parent_order',
       (SELECT COUNT(*)::text FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = oi.order_id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = oi.order_id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'rel.dup_pk_order_items',
       (SELECT COUNT(*)::text FROM (SELECT id FROM public.order_items GROUP BY 1 HAVING COUNT(*) > 1) s), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items GROUP BY id HAVING COUNT(*) > 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'integrity.qty_mismatch',
       (SELECT n::text FROM qty_mismatch), '0',
       CASE WHEN (SELECT n FROM qty_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'integrity.archive_mismatch',
       (SELECT n::text FROM archive_mismatch), '0',
       CASE WHEN (SELECT n FROM archive_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'numeric.ledger_qty_mismatch',
       (SELECT ledger_qty::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT ledger_qty FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'numeric.order_total_sale_mismatch',
       (SELECT order_total_sale::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_total_sale FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'numeric.order_shipping_mismatch',
       (SELECT order_shipping::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_shipping FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'numeric.order_discount_mismatch',
       (SELECT order_discount::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_discount FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'numeric.line_unit_price_mismatch',
       (SELECT line_unit_price::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT line_unit_price FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'ts.item_created_at_present_mismatch',
       (SELECT item_created_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_created_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'ts.item_updated_at_present_mismatch',
       (SELECT item_updated_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_updated_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'ts.item_inbound_date_present_mismatch',
       (SELECT item_inbound_date::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_inbound_date FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'ts.item_last_moved_at_present_mismatch',
       (SELECT item_last_moved_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_last_moved_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'ts.item_archived_at_mismatch',
       (SELECT item_archived_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_archived_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'ts.order_date_mismatch',
       (SELECT order_date::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT order_date FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'ts.order_shipped_at_mismatch',
       (SELECT order_shipped_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT order_shipped_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'ts.audit_timestamp_present_mismatch',
       (SELECT audit_timestamp::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT audit_timestamp FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'id.order_item_generated_missing_in_table',
       (SELECT COUNT(*)::text FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'id.order_item_table_not_in_generated',
       (SELECT COUNT(*)::text FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 62, 'id.order_item_generated_dups',
       (SELECT COUNT(*)::text FROM (SELECT order_item_id FROM line_ids GROUP BY 1 HAVING COUNT(*) > 1) s), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM line_ids GROUP BY order_item_id HAVING COUNT(*) > 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 63, 'id.order_item_parent_matches_generated',
       (SELECT COUNT(*)::text FROM public.order_items oi JOIN line_ids g ON g.order_item_id = oi.id WHERE oi.order_id IS DISTINCT FROM g.order_id), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi JOIN line_ids g ON g.order_item_id = oi.id WHERE oi.order_id IS DISTINCT FROM g.order_id) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'orphan.ledger_equal_nonzero',
       (SELECT legacy_ledger_orphan::text || '=' || new_ledger_orphan::text FROM orphans), 'equal and <> 0',
       CASE WHEN (SELECT legacy_ledger_orphan = new_ledger_orphan AND legacy_ledger_orphan <> 0 FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'orphan.order_line_equal_nonzero',
       (SELECT legacy_order_line_orphan::text || '=' || new_order_line_orphan::text FROM orphans), 'equal and <> 0',
       CASE WHEN (SELECT legacy_order_line_orphan = new_order_line_orphan AND legacy_order_line_orphan <> 0 FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'orphan.ledger_empty_item_id_equal',
       (SELECT legacy_ledger_empty_item_id::text || '=' || new_ledger_empty_item_id::text FROM orphans), 'equal',
       CASE WHEN (SELECT legacy_ledger_empty_item_id = new_ledger_empty_item_id FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 80, 'iso.staff_columns_no_cost',
       (SELECT COUNT(*)::text FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('inventory_items','inventory_ledger','orders','order_items')
           AND column_name IN ('cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('inventory_items','inventory_ledger','orders','order_items')
           AND column_name IN ('cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 81, 'iso.extra_cost_keys_items',
       (SELECT COUNT(*)::text FROM public.inventory_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 82, 'iso.extra_cost_keys_ledger',
       (SELECT COUNT(*)::text FROM public.inventory_ledger WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_ledger WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 83, 'iso.extra_cost_keys_orders',
       (SELECT COUNT(*)::text FROM public.orders WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 84, 'iso.extra_cost_keys_order_items',
       (SELECT COUNT(*)::text FROM public.order_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 85, 'extra.typeof_object_all',
       (
         (SELECT COUNT(*) FROM public.inventory_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.inventory_ledger WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.orders WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.order_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
       )::text, '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.inventory_ledger WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.orders WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.order_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 86, 'extra.items_unknown_json_mismatch',
       (SELECT items_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT items_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 87, 'extra.ledger_unknown_json_mismatch',
       (SELECT ledger_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT ledger_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 88, 'extra.orders_unknown_json_mismatch',
       (SELECT orders_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT orders_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 89, 'extra.order_items_unknown_json_mismatch',
       (SELECT order_items_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT order_items_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 90, 'checksum.item_cost_match',
       (SELECT (new_item_cost = legacy_item_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_item_cost = legacy_item_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 91, 'checksum.ledger_cost_match',
       (SELECT (new_ledger_cost = legacy_ledger_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_ledger_cost = legacy_ledger_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 92, 'checksum.cogs_match',
       (SELECT (new_cogs = legacy_cogs)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_cogs = legacy_cogs FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 93, 'checksum.order_line_cost_match',
       (SELECT (new_line_cost = legacy_line_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_line_cost = legacy_line_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 100, 'sec.client_grants',
       (SELECT COUNT(*)::text FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
           )
           AND grantee IN ('PUBLIC','anon','authenticated')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
           )
           AND grantee IN ('PUBLIC','anon','authenticated')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 101, 'sec.client_policies',
       (SELECT COUNT(*)::text FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
           )), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN (
             'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
             'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
           )
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 102, 'sec.m4_rpc_absent',
       (SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('dk_require_backoffice','backoffice_adjust_stock','backoffice_admin_adjust_stock','backoffice_create_order')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('dk_require_backoffice','backoffice_adjust_stock','backoffice_admin_adjust_stock','backoffice_create_order')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 110, 'fk.expected_present',
       (SELECT COUNT(*)::text FROM expected_fk e JOIN fk_live f
         ON f.src_table = e.src_table AND f.src_column = e.src_column
        AND f.dst_table = e.dst_table AND f.dst_column = e.dst_column), '5',
       CASE WHEN (SELECT COUNT(*) FROM expected_fk e JOIN fk_live f
         ON f.src_table = e.src_table AND f.src_column = e.src_column
        AND f.dst_table = e.dst_table AND f.dst_column = e.dst_column) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 111, 'fk.live_count',
       (SELECT COUNT(*)::text FROM fk_live), '5',
       CASE WHEN (SELECT COUNT(*) FROM fk_live) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 112, 'fk.forbidden_absent',
       (SELECT COUNT(*)::text FROM fk_live f
         WHERE (f.src_table = 'inventory_ledger' AND f.src_column = 'item_id')
            OR (f.src_table = 'order_items' AND f.src_column = 'item_id')
            OR (f.src_table = 'expenses' AND f.src_column = 'ref_item_id')
            OR (f.src_table = 'audit_logs' AND f.src_column = 'target_id')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM fk_live f
         WHERE (f.src_table = 'inventory_ledger' AND f.src_column = 'item_id')
            OR (f.src_table = 'order_items' AND f.src_column = 'item_id')
            OR (f.src_table = 'expenses' AND f.src_column = 'ref_item_id')
            OR (f.src_table = 'audit_logs' AND f.src_column = 'target_id')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 120, 'trigger.enabled_count',
       (SELECT COUNT(*)::text FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_dk_stage7_set_updated_at' AND t.tgenabled = 'O'
           AND c.relname IN ('inventory_items','inventory_costs','orders','expenses')), '4',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_dk_stage7_set_updated_at' AND t.tgenabled = 'O'
           AND c.relname IN ('inventory_items','inventory_costs','orders','expenses')
       ) = 4 THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/


-- ============================================================
-- SECTION M1_INCREMENTAL_RESYNC
-- 從已審查 M1_BACKFILL 衍生。M2_VERIFY counts FAIL 後使用。
-- 只從 public.v2_data id='default' 讀。只寫 10 張 Stage 7 新表。
-- 禁止 DELETE / TRUNCATE / DROP TABLE / 改 v2_data。
-- 不重算 qty / cogs / cost；只複製目前 JSON 欄位。orphan 全留。
-- 正式前端仍走 v2_data。不新增 grants / policies。不進 M3。
--
-- 相對 M1_BACKFILL 的必要修正：
--   ON CONFLICT 不再寫 updated_at = EXCLUDED.updated_at
--   （EXCLUDED 在 JSON 缺 updated_at 時是 now()，會污染既有 timestamp）。
--   trigger 仍全程 DISABLE；COMMIT 前 ENABLE。
--   JSON 有 updated_at 時，另以 UPDATE 同步（trigger 仍關）。
--
-- 訂單明細 PK 仍為 order_id || ':' || ordinality。
-- JOIN 必須用 CROSS JOIN LATERAL。
-- 唯一允許的 DROP：歷史 sku / order_no 重複時，把 unique index
-- 降成非 unique（與 M1 相同，避免 INSERT 丟列）。不是 DROP TABLE。
-- ============================================================
/*

BEGIN;

DO $$
DECLARE
  v2_cnt integer;
  dup_item integer;
  dup_ledger integer;
  dup_order integer;
  dup_audit integer;
  sku_dup_groups integer;
  order_no_dup_groups integer;
BEGIN
  IF to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.inventory_costs') IS NULL
     OR to_regclass('public.inventory_ledger') IS NULL
     OR to_regclass('public.inventory_ledger_costs') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_costs') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.order_item_costs') IS NULL
     OR to_regclass('public.expenses') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'RESYNC 中止：缺少 M0 新表。請先完成 M0_SCHEMA。';
  END IF;
  IF to_regclass('public.v2_data') IS NULL THEN
    RAISE EXCEPTION 'RESYNC 中止：缺少 v2_data。';
  END IF;

  SELECT COUNT(*) INTO v2_cnt FROM public.v2_data WHERE id = 'default';
  IF v2_cnt <> 1 THEN
    RAISE EXCEPTION 'RESYNC 中止：v2_data id=default 必須恰好 1 列（目前 %）', v2_cnt;
  END IF;

  SELECT COUNT(*) INTO dup_item FROM (
    SELECT i->>'id' AS id
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_ledger FROM (
    SELECT e->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_order FROM (
    SELECT o->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_audit FROM (
    SELECT a->>'id'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) a
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  IF dup_item > 0 OR dup_ledger > 0 OR dup_order > 0 OR dup_audit > 0 THEN
    RAISE EXCEPTION 'RESYNC 中止：來源 PK 重複（item=% ledger=% order=% audit=%）。ON CONFLICT 會合併列，拒絕執行',
      dup_item, dup_ledger, dup_order, dup_audit;
  END IF;

  SELECT COUNT(*) INTO sku_dup_groups FROM (
    SELECT lower(i->>'sku')
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default'
      AND NULLIF(i->>'sku','') IS NOT NULL
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO order_no_dup_groups FROM (
    SELECT o->>'order_no'
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
    WHERE d.id = 'default'
      AND NULLIF(o->>'order_no','') IS NOT NULL
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;

  IF sku_dup_groups > 0 THEN
    EXECUTE 'DROP INDEX IF EXISTS public.inventory_items_sku_lower_uidx';
    EXECUTE 'CREATE INDEX IF NOT EXISTS inventory_items_sku_lower_idx ON public.inventory_items (lower(sku)) WHERE sku IS NOT NULL AND sku <> ''''';
    RAISE NOTICE 'RESYNC：% 組重複 sku，已改非 unique index，不丟列', sku_dup_groups;
  END IF;
  IF order_no_dup_groups > 0 THEN
    EXECUTE 'DROP INDEX IF EXISTS public.orders_order_no_uidx';
    EXECUTE 'CREATE INDEX IF NOT EXISTS orders_order_no_idx ON public.orders (order_no) WHERE order_no IS NOT NULL AND order_no <> ''''';
    RAISE NOTICE 'RESYNC：% 組重複 order_no，已改非 unique index，不丟列', order_no_dup_groups;
  END IF;
END $$;

ALTER TABLE public.inventory_items DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.inventory_costs DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.orders DISABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.expenses DISABLE TRIGGER trg_dk_stage7_set_updated_at;

INSERT INTO public.inventory_items (
  id, sku, category, sub_type, brand, model, name, spec, vendor, condition, status,
  qty_on_hand, price_list, price_floor, inbound_date, last_moved_at, reorder_point,
  location, notes, is_archived, archived_at, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text)),
  NULLIF(i->>'sku',''),
  NULLIF(i->>'category',''),
  NULLIF(i->>'sub_type',''),
  NULLIF(i->>'brand',''),
  NULLIF(i->>'model',''),
  NULLIF(i->>'name',''),
  NULLIF(i->>'spec',''),
  NULLIF(i->>'vendor',''),
  NULLIF(i->>'condition',''),
  NULLIF(i->>'status',''),
  COALESCE(NULLIF(i->>'qty_on_hand','')::numeric, 0),
  NULLIF(i->>'price_list','')::numeric,
  NULLIF(i->>'price_floor','')::numeric,
  NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '')::date,
  NULLIF(i->>'last_moved_at','')::timestamptz,
  NULLIF(i->>'reorder_point','')::numeric,
  NULLIF(i->>'location',''),
  NULLIF(i->>'notes',''),
  CASE
    WHEN lower(COALESCE(i->>'isArchived','')) IN ('true','t','1') THEN true
    WHEN lower(COALESCE(i->>'isArchived','')) IN ('false','f','0') THEN false
    ELSE (NULLIF(i->>'archivedAt','') IS NOT NULL)
  END,
  NULLIF(i->>'archivedAt','')::timestamptz,
  (i - ARRAY['id','sku','category','sub_type','brand','model','name','spec','vendor','condition','status','qty_on_hand','cost_unit','costUnit','unit_cost','cogs_total','cogs','price_list','price_floor','inbound_date','last_moved_at','reorder_point','location','notes','isArchived','archivedAt','created_at','updated_at']::text[]),
  COALESCE(NULLIF(i->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(i->>'updated_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  sku = EXCLUDED.sku,
  category = EXCLUDED.category,
  sub_type = EXCLUDED.sub_type,
  brand = EXCLUDED.brand,
  model = EXCLUDED.model,
  name = EXCLUDED.name,
  spec = EXCLUDED.spec,
  vendor = EXCLUDED.vendor,
  condition = EXCLUDED.condition,
  status = EXCLUDED.status,
  qty_on_hand = EXCLUDED.qty_on_hand,
  price_list = EXCLUDED.price_list,
  price_floor = EXCLUDED.price_floor,
  inbound_date = EXCLUDED.inbound_date,
  last_moved_at = EXCLUDED.last_moved_at,
  reorder_point = EXCLUDED.reorder_point,
  location = EXCLUDED.location,
  notes = EXCLUDED.notes,
  is_archived = EXCLUDED.is_archived,
  archived_at = EXCLUDED.archived_at,
  extra = EXCLUDED.extra;

INSERT INTO public.inventory_costs (item_id, cost_unit, extra, created_at, updated_at)
SELECT
  it.id,
  COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0),
  '{}'::jsonb,
  COALESCE(NULLIF(i->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(i->>'updated_at','')::timestamptz, now())
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
INNER JOIN public.inventory_items it
  ON it.id = COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text))
WHERE d.id = 'default'
ON CONFLICT (item_id) DO UPDATE SET
  cost_unit = EXCLUDED.cost_unit;

INSERT INTO public.inventory_ledger (
  id, item_id, type, qty, ref_type, ref_id, note, extra, created_at
)
SELECT
  COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text)),
  NULLIF(e->>'item_id',''),
  COALESCE(NULLIF(e->>'type',''), 'ADJUST'),
  COALESCE(NULLIF(e->>'qty','')::numeric, 0),
  NULLIF(e->>'ref_type',''),
  NULLIF(e->>'ref_id',''),
  NULLIF(e->>'note',''),
  (e - ARRAY['id','item_id','type','qty','unit_cost','cost_unit','costUnit','cogs_total','ref_type','ref_id','note','created_at']::text[]),
  COALESCE(NULLIF(e->>'created_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  item_id = EXCLUDED.item_id,
  type = EXCLUDED.type,
  qty = EXCLUDED.qty,
  ref_type = EXCLUDED.ref_type,
  ref_id = EXCLUDED.ref_id,
  note = EXCLUDED.note,
  extra = EXCLUDED.extra;

INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost, extra)
SELECT
  l.id,
  COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0),
  '{}'::jsonb
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
INNER JOIN public.inventory_ledger l
  ON l.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
WHERE d.id = 'default'
ON CONFLICT (ledger_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost;

INSERT INTO public.orders (
  id, order_no, customer_name, sales_type, total_sale, shipping_income, discount,
  payment_method, status, shipped_at, date, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text)),
  NULLIF(o->>'order_no',''),
  NULLIF(o->>'customer_name',''),
  NULLIF(COALESCE(o->>'salesType', o->>'sales_type'), ''),
  COALESCE(NULLIF(o->>'total_sale','')::numeric, 0),
  COALESCE(NULLIF(o->>'shipping_income','')::numeric, 0),
  COALESCE(NULLIF(o->>'discount','')::numeric, 0),
  NULLIF(o->>'payment_method',''),
  NULLIF(o->>'status',''),
  NULLIF(o->>'shipped_at','')::timestamptz,
  NULLIF(left(COALESCE(o->>'date', o->>'created_at'), 10), '')::date,
  (o - ARRAY['id','order_no','customer_name','salesType','sales_type','total_sale','shipping_income','discount','payment_method','status','cogs_total','cogs','cost_unit','costUnit','created_at','updated_at','shipped_at','date','items']::text[]),
  COALESCE(NULLIF(o->>'created_at','')::timestamptz, NULLIF(o->>'date','')::timestamptz, now()),
  COALESCE(NULLIF(o->>'updated_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  order_no = EXCLUDED.order_no,
  customer_name = EXCLUDED.customer_name,
  sales_type = EXCLUDED.sales_type,
  total_sale = EXCLUDED.total_sale,
  shipping_income = EXCLUDED.shipping_income,
  discount = EXCLUDED.discount,
  payment_method = EXCLUDED.payment_method,
  status = EXCLUDED.status,
  shipped_at = EXCLUDED.shipped_at,
  date = EXCLUDED.date,
  extra = EXCLUDED.extra;

INSERT INTO public.order_costs (order_id, cogs_total, extra)
SELECT
  ord.id,
  COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0),
  '{}'::jsonb
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
INNER JOIN public.orders ord
  ON ord.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
WHERE d.id = 'default'
ON CONFLICT (order_id) DO UPDATE SET cogs_total = EXCLUDED.cogs_total;

INSERT INTO public.order_items (
  id, order_id, item_id, sku, name, spec, qty, unit_price, extra
)
SELECT
  COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
    || ':' || (line.ordinality::text),
  COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)),
  NULLIF(COALESCE(line.elem->>'item_id', line.elem->>'id'), ''),
  NULLIF(line.elem->>'sku',''),
  NULLIF(line.elem->>'name',''),
  NULLIF(line.elem->>'spec',''),
  COALESCE(NULLIF(line.elem->>'qty','')::numeric, 0),
  COALESCE(NULLIF(COALESCE(line.elem->>'unit_price', line.elem->>'unitPrice'),'')::numeric, 0),
  (line.elem - ARRAY['id','item_id','sku','name','spec','qty','unit_price','unitPrice','cost_unit','costUnit','unit_cost','cogs']::text[])
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  item_id = EXCLUDED.item_id,
  sku = EXCLUDED.sku,
  name = EXCLUDED.name,
  spec = EXCLUDED.spec,
  qty = EXCLUDED.qty,
  unit_price = EXCLUDED.unit_price,
  extra = EXCLUDED.extra;

INSERT INTO public.order_item_costs (order_item_id, cost_unit, extra)
SELECT
  src.order_item_id,
  COALESCE(NULLIF(COALESCE(src.line_elem->>'cost_unit', src.line_elem->>'costUnit'),'')::numeric, 0),
  '{}'::jsonb
FROM (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    line.elem AS line_elem
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
) src
INNER JOIN public.order_items oi
  ON oi.id = src.order_item_id
ON CONFLICT (order_item_id) DO UPDATE SET cost_unit = EXCLUDED.cost_unit;

INSERT INTO public.expenses (
  id, date, type, category, amount, note, ref_item_id, extra, created_at, updated_at
)
SELECT
  COALESCE(NULLIF(e->>'id',''), 'missing-exp-' || md5(e::text)),
  NULLIF(e->>'date','')::date,
  NULLIF(e->>'type',''),
  NULLIF(e->>'category',''),
  COALESCE(NULLIF(e->>'amount','')::numeric, 0),
  NULLIF(e->>'note',''),
  NULLIF(e->>'ref_item_id',''),
  (e - ARRAY['id','date','type','category','amount','note','ref_item_id','created_at','updated_at']::text[]),
  COALESCE(NULLIF(e->>'created_at','')::timestamptz, now()),
  COALESCE(NULLIF(e->>'updated_at','')::timestamptz, NULLIF(e->>'created_at','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'expenses','[]'::jsonb)) e
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  date = EXCLUDED.date,
  type = EXCLUDED.type,
  category = EXCLUDED.category,
  amount = EXCLUDED.amount,
  note = EXCLUDED.note,
  ref_item_id = EXCLUDED.ref_item_id,
  extra = EXCLUDED.extra;

INSERT INTO public.audit_logs (
  id, user_id, display_name, action, target_id, extra, created_at
)
SELECT
  COALESCE(NULLIF(a->>'id',''), 'missing-aud-' || md5(a::text)),
  NULLIF(a->>'userId',''),
  NULLIF(a->>'displayName',''),
  NULLIF(a->>'action',''),
  NULLIF(a->>'targetId',''),
  (a - ARRAY['id','userId','displayName','action','targetId','timestamp']::text[]),
  COALESCE(NULLIF(a->>'timestamp','')::timestamptz, now())
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) a
WHERE d.id = 'default'
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  display_name = EXCLUDED.display_name,
  action = EXCLUDED.action,
  target_id = EXCLUDED.target_id,
  extra = EXCLUDED.extra;

UPDATE public.inventory_items n
SET updated_at = NULLIF(i->>'updated_at','')::timestamptz
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
WHERE d.id = 'default'
  AND n.id = COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text))
  AND NULLIF(i->>'updated_at','') IS NOT NULL;

UPDATE public.inventory_costs c
SET updated_at = NULLIF(i->>'updated_at','')::timestamptz
FROM public.v2_data d
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
INNER JOIN public.inventory_items it
  ON it.id = COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text))
WHERE d.id = 'default'
  AND c.item_id = it.id
  AND NULLIF(i->>'updated_at','') IS NOT NULL;

UPDATE public.orders n
SET updated_at = NULLIF(o->>'updated_at','')::timestamptz
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
WHERE d.id = 'default'
  AND n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
  AND NULLIF(o->>'updated_at','') IS NOT NULL;

UPDATE public.expenses n
SET updated_at = NULLIF(e->>'updated_at','')::timestamptz
FROM public.v2_data d,
     LATERAL jsonb_array_elements(COALESCE(d.data->'expenses','[]'::jsonb)) e
WHERE d.id = 'default'
  AND n.id = COALESCE(NULLIF(e->>'id',''), 'missing-exp-' || md5(e::text))
  AND NULLIF(e->>'updated_at','') IS NOT NULL;

ALTER TABLE public.inventory_items ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.inventory_costs ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.orders ENABLE TRIGGER trg_dk_stage7_set_updated_at;
ALTER TABLE public.expenses ENABLE TRIGGER trg_dk_stage7_set_updated_at;

COMMIT;

*/


-- ============================================================
-- SECTION RESYNC_POSTCHECK（只讀；M1_INCREMENTAL_RESYNC 成功後立刻跑）
-- 契約與 SECTION M2_VERIFY 相同，避免兩份驗收 SQL 漂移。
-- 本區可整段執行；每一列 verdict 必須 PASS。
-- 通過後視為可重跑 M2_VERIFY；禁止進 M3。
-- 不輸出成本金額、客戶姓名、電話、note。
-- ============================================================
/*

WITH
legacy AS (
  SELECT
    jsonb_array_length(COALESCE(data->'items','[]'::jsonb)) AS items,
    jsonb_array_length(COALESCE(data->'ledger','[]'::jsonb)) AS ledger,
    jsonb_array_length(COALESCE(data->'orders','[]'::jsonb)) AS orders,
    jsonb_array_length(COALESCE(data->'expenses','[]'::jsonb)) AS expenses,
    jsonb_array_length(COALESCE(data->'auditLogs','[]'::jsonb)) AS audit,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
    ) AS order_lines
  FROM public.v2_data
  WHERE id = 'default'
),
tables AS (
  SELECT unnest(ARRAY[
    'inventory_items','inventory_costs','inventory_ledger','inventory_ledger_costs',
    'orders','order_costs','order_items','order_item_costs','expenses','audit_logs'
  ]) AS table_name
),
table_meta AS (
  SELECT
    t.table_name,
    (c.oid IS NOT NULL AND c.relkind = 'r') AS exists,
    COALESCE(c.relrowsecurity, false) AS rls
  FROM tables t
  LEFT JOIN pg_class c
    ON c.relname = t.table_name
   AND c.relkind = 'r'
  LEFT JOIN pg_namespace n
    ON n.oid = c.relnamespace
   AND n.nspname = 'public'
),
qty_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND COALESCE(NULLIF(i->>'qty_on_hand','')::numeric, 0) IS DISTINCT FROM n.qty_on_hand
),
archive_mismatch AS (
  SELECT COUNT(*) AS n
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
  INNER JOIN public.inventory_items n ON n.id = i->>'id'
  WHERE d.id = 'default'
    AND (
      CASE
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('true','t','1') THEN true
        WHEN lower(COALESCE(i->>'isArchived','')) IN ('false','f','0') THEN false
        ELSE (NULLIF(i->>'archivedAt','') IS NOT NULL)
      END
    ) IS DISTINCT FROM n.is_archived
),
numeric_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      INNER JOIN public.inventory_ledger n
        ON n.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(e->>'qty','')::numeric, 0) IS DISTINCT FROM n.qty
    ) AS ledger_qty,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'total_sale','')::numeric, 0) IS DISTINCT FROM n.total_sale
    ) AS order_total_sale,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'shipping_income','')::numeric, 0) IS DISTINCT FROM n.shipping_income
    ) AS order_shipping,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(o->>'discount','')::numeric, 0) IS DISTINCT FROM n.discount
    ) AS order_discount,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      INNER JOIN public.order_items n
        ON n.id = COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      WHERE d.id = 'default'
        AND COALESCE(NULLIF(COALESCE(line.elem->>'unit_price', line.elem->>'unitPrice'),'')::numeric, 0) IS DISTINCT FROM n.unit_price
    ) AS line_unit_price
),
ts_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'created_at','') IS NOT NULL
        AND NULLIF(i->>'created_at','')::timestamptz IS DISTINCT FROM n.created_at
    ) AS item_created_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'updated_at','') IS NOT NULL
        AND NULLIF(i->>'updated_at','')::timestamptz IS DISTINCT FROM n.updated_at
    ) AS item_updated_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '') IS NOT NULL
        AND NULLIF(left(COALESCE(i->>'inbound_date',''), 10), '')::date IS DISTINCT FROM n.inbound_date
    ) AS item_inbound_date,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'last_moved_at','') IS NOT NULL
        AND NULLIF(i->>'last_moved_at','')::timestamptz IS DISTINCT FROM n.last_moved_at
    ) AS item_last_moved_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND NULLIF(i->>'archivedAt','')::timestamptz IS DISTINCT FROM n.archived_at
    ) AS item_archived_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND NULLIF(left(COALESCE(o->>'date', o->>'created_at'), 10), '')::date IS DISTINCT FROM n.date
    ) AS order_date,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND NULLIF(o->>'shipped_at','')::timestamptz IS DISTINCT FROM n.shipped_at
    ) AS order_shipped_at,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'auditLogs','[]'::jsonb)) AS a
      INNER JOIN public.audit_logs n
        ON n.id = COALESCE(NULLIF(a->>'id',''), 'missing-aud-' || md5(a::text))
      WHERE d.id = 'default'
        AND NULLIF(a->>'timestamp','') IS NOT NULL
        AND NULLIF(a->>'timestamp','')::timestamptz IS DISTINCT FROM n.created_at
    ) AS audit_timestamp
),
extra_mismatch AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      INNER JOIN public.inventory_items n ON n.id = i->>'id'
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          i - ARRAY['id','sku','category','sub_type','brand','model','name','spec','vendor','condition','status','qty_on_hand','cost_unit','costUnit','unit_cost','cogs_total','cogs','price_list','price_floor','inbound_date','last_moved_at','reorder_point','location','notes','isArchived','archivedAt','created_at','updated_at']::text[]
        )
    ) AS items_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      INNER JOIN public.inventory_ledger n
        ON n.id = COALESCE(NULLIF(e->>'id',''), 'missing-ledger-' || md5(e::text))
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          e - ARRAY['id','item_id','type','qty','unit_cost','cost_unit','costUnit','cogs_total','ref_type','ref_id','note','created_at']::text[]
        )
    ) AS ledger_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      INNER JOIN public.orders n
        ON n.id = COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          o - ARRAY['id','order_no','customer_name','salesType','sales_type','total_sale','shipping_income','discount','payment_method','status','cogs_total','cogs','cost_unit','costUnit','created_at','updated_at','shipped_at','date','items']::text[]
        )
    ) AS orders_extra,
    (
      SELECT COUNT(*)
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      INNER JOIN public.order_items n
        ON n.id = COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      WHERE d.id = 'default'
        AND n.extra IS DISTINCT FROM (
          line.elem - ARRAY['id','item_id','sku','name','spec','qty','unit_price','unitPrice','cost_unit','costUnit','unit_cost','cogs']::text[]
        )
    ) AS order_items_extra
),
line_ids AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) AS order_id
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
orphans AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
      WHERE COALESCE(e->>'item_id','') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = e->>'item_id'
        )
    ) AS legacy_ledger_orphan,
    (
      SELECT COUNT(*) FROM public.inventory_ledger l
      WHERE COALESCE(l.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = l.item_id)
    ) AS new_ledger_orphan,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) line
      WHERE COALESCE(line->>'item_id', line->>'id', '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
          WHERE i->>'id' = COALESCE(line->>'item_id', line->>'id')
        )
    ) AS legacy_order_line_orphan,
    (
      SELECT COUNT(*) FROM public.order_items oi
      WHERE COALESCE(oi.item_id,'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = oi.item_id)
    ) AS new_order_line_orphan,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) e
      WHERE COALESCE(e->>'item_id','') = ''
    ) AS legacy_ledger_empty_item_id,
    (
      SELECT COUNT(*) FROM public.inventory_ledger WHERE COALESCE(item_id,'') = ''
    ) AS new_ledger_empty_item_id
  FROM public.v2_data d
  WHERE d.id = 'default'
),
checksums AS (
  SELECT
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY item_id) FROM public.inventory_costs)) AS new_item_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY i->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      WHERE d.id = 'default'
    )) AS legacy_item_cost,
    md5((SELECT string_agg(to_char(COALESCE(unit_cost,0), 'FM9999999990.00'), ',' ORDER BY ledger_id) FROM public.inventory_ledger_costs)) AS new_ledger_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY e->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      WHERE d.id = 'default'
    )) AS legacy_ledger_cost,
    md5((SELECT string_agg(to_char(COALESCE(cogs_total,0), 'FM9999999990.00'), ',' ORDER BY order_id) FROM public.order_costs)) AS new_cogs,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY o->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      WHERE d.id = 'default'
    )) AS legacy_cogs,
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY order_item_id) FROM public.order_item_costs)) AS new_line_cost,
    md5((
      SELECT string_agg(
        to_char(COALESCE(NULLIF(COALESCE(line.elem->>'cost_unit', line.elem->>'costUnit'),'')::numeric, 0), 'FM9999999990.00'),
        ',' ORDER BY COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      )
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      WHERE d.id = 'default'
    )) AS legacy_line_cost
)
SELECT 10 AS seq, 'v2_data.row_count'::text AS check_name,
       (SELECT COUNT(*) FROM public.v2_data)::text AS actual, '1'::text AS expected,
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'v2_data.default_id',
       (SELECT COUNT(*)::text FROM public.v2_data WHERE id = 'default'), '1',
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data WHERE id = 'default') = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'count.items',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_items), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'count.inventory_costs',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_costs), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'count.ledger',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger), 'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'count.inventory_ledger_costs',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs), 'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'count.orders',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.orders), 'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.orders) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'count.order_costs',
       (SELECT orders::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_costs), 'equal',
       CASE WHEN (SELECT orders FROM legacy) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'count.order_items',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_items), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'count.order_item_costs',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_item_costs), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'count.expenses',
       (SELECT expenses::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.expenses), 'equal',
       CASE WHEN (SELECT expenses FROM legacy) = (SELECT COUNT(*) FROM public.expenses) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'count.audit_logs',
       (SELECT audit::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.audit_logs), 'equal',
       CASE WHEN (SELECT audit FROM legacy) = (SELECT COUNT(*) FROM public.audit_logs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'coverage.items_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_items) || '=' || (SELECT COUNT(*)::text FROM public.inventory_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_items) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'coverage.ledger_eq_costs',
       (SELECT COUNT(*)::text FROM public.inventory_ledger) || '=' || (SELECT COUNT(*)::text FROM public.inventory_ledger_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.inventory_ledger) = (SELECT COUNT(*) FROM public.inventory_ledger_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'coverage.orders_eq_costs',
       (SELECT COUNT(*)::text FROM public.orders) || '=' || (SELECT COUNT(*)::text FROM public.order_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.orders) = (SELECT COUNT(*) FROM public.order_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'coverage.order_items_eq_costs',
       (SELECT COUNT(*)::text FROM public.order_items) || '=' || (SELECT COUNT(*)::text FROM public.order_item_costs), 'equal',
       CASE WHEN (SELECT COUNT(*) FROM public.order_items) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'integrity.qty_mismatch',
       (SELECT n::text FROM qty_mismatch), '0',
       CASE WHEN (SELECT n FROM qty_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'integrity.archive_mismatch',
       (SELECT n::text FROM archive_mismatch), '0',
       CASE WHEN (SELECT n FROM archive_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'numeric.ledger_qty_mismatch',
       (SELECT ledger_qty::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT ledger_qty FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'numeric.order_total_sale_mismatch',
       (SELECT order_total_sale::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_total_sale FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'numeric.order_shipping_mismatch',
       (SELECT order_shipping::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_shipping FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'numeric.order_discount_mismatch',
       (SELECT order_discount::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT order_discount FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'numeric.line_unit_price_mismatch',
       (SELECT line_unit_price::text FROM numeric_mismatch), '0',
       CASE WHEN (SELECT line_unit_price FROM numeric_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'ts.item_created_at_present_mismatch',
       (SELECT item_created_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_created_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'ts.item_updated_at_present_mismatch',
       (SELECT item_updated_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_updated_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'ts.item_inbound_date_present_mismatch',
       (SELECT item_inbound_date::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_inbound_date FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'ts.item_last_moved_at_present_mismatch',
       (SELECT item_last_moved_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_last_moved_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'ts.item_archived_at_mismatch',
       (SELECT item_archived_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT item_archived_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'ts.order_date_mismatch',
       (SELECT order_date::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT order_date FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'ts.order_shipped_at_mismatch',
       (SELECT order_shipped_at::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT order_shipped_at FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'ts.audit_timestamp_present_mismatch',
       (SELECT audit_timestamp::text FROM ts_mismatch), '0',
       CASE WHEN (SELECT audit_timestamp FROM ts_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'id.order_item_generated_missing_in_table',
       (SELECT COUNT(*)::text FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'id.order_item_table_not_in_generated',
       (SELECT COUNT(*)::text FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 62, 'id.order_item_generated_dups',
       (SELECT COUNT(*)::text FROM (SELECT order_item_id FROM line_ids GROUP BY 1 HAVING COUNT(*) > 1) s), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM line_ids GROUP BY order_item_id HAVING COUNT(*) > 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 63, 'id.order_item_parent_matches_generated',
       (SELECT COUNT(*)::text FROM public.order_items oi JOIN line_ids g ON g.order_item_id = oi.id WHERE oi.order_id IS DISTINCT FROM g.order_id), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi JOIN line_ids g ON g.order_item_id = oi.id WHERE oi.order_id IS DISTINCT FROM g.order_id) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'orphan.ledger_equal_nonzero',
       (SELECT legacy_ledger_orphan::text || '=' || new_ledger_orphan::text FROM orphans), 'equal and <> 0',
       CASE WHEN (SELECT legacy_ledger_orphan = new_ledger_orphan AND legacy_ledger_orphan <> 0 FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'orphan.order_line_equal_nonzero',
       (SELECT legacy_order_line_orphan::text || '=' || new_order_line_orphan::text FROM orphans), 'equal and <> 0',
       CASE WHEN (SELECT legacy_order_line_orphan = new_order_line_orphan AND legacy_order_line_orphan <> 0 FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'orphan.ledger_empty_item_id_equal',
       (SELECT legacy_ledger_empty_item_id::text || '=' || new_ledger_empty_item_id::text FROM orphans), 'equal',
       CASE WHEN (SELECT legacy_ledger_empty_item_id = new_ledger_empty_item_id FROM orphans) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 80, 'iso.staff_columns_no_cost',
       (SELECT COUNT(*)::text FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('inventory_items','inventory_ledger','orders','order_items')
           AND column_name IN ('cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost')), '0',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('inventory_items','inventory_ledger','orders','order_items')
           AND column_name IN ('cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost')
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 81, 'iso.extra_cost_keys_items',
       (SELECT COUNT(*)::text FROM public.inventory_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 82, 'iso.extra_cost_keys_ledger',
       (SELECT COUNT(*)::text FROM public.inventory_ledger WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_ledger WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 83, 'iso.extra_cost_keys_orders',
       (SELECT COUNT(*)::text FROM public.orders WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 84, 'iso.extra_cost_keys_order_items',
       (SELECT COUNT(*)::text FROM public.order_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items WHERE extra ?| ARRAY['cost_unit','costUnit','unit_cost','unitCost','cogs_total','cogs','cost']) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 85, 'extra.typeof_object_all',
       (
         (SELECT COUNT(*) FROM public.inventory_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.inventory_ledger WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.orders WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
         + (SELECT COUNT(*) FROM public.order_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
       )::text, '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.inventory_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.inventory_ledger WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.orders WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
             AND NOT EXISTS (SELECT 1 FROM public.order_items WHERE jsonb_typeof(extra) IS DISTINCT FROM 'object')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 86, 'extra.items_unknown_json_mismatch',
       (SELECT items_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT items_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 87, 'extra.ledger_unknown_json_mismatch',
       (SELECT ledger_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT ledger_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 88, 'extra.orders_unknown_json_mismatch',
       (SELECT orders_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT orders_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 89, 'extra.order_items_unknown_json_mismatch',
       (SELECT order_items_extra::text FROM extra_mismatch), '0',
       CASE WHEN (SELECT order_items_extra FROM extra_mismatch) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 90, 'checksum.item_cost_match',
       (SELECT (new_item_cost = legacy_item_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_item_cost = legacy_item_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 91, 'checksum.ledger_cost_match',
       (SELECT (new_ledger_cost = legacy_ledger_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_ledger_cost = legacy_ledger_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 92, 'checksum.cogs_match',
       (SELECT (new_cogs = legacy_cogs)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_cogs = legacy_cogs FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 93, 'checksum.order_line_cost_match',
       (SELECT (new_line_cost = legacy_line_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_line_cost = legacy_line_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 120, 'trigger.enabled_count',
       (SELECT COUNT(*)::text FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_dk_stage7_set_updated_at' AND t.tgenabled = 'O'
           AND c.relname IN ('inventory_items','inventory_costs','orders','expenses')), '4',
       CASE WHEN (
         SELECT COUNT(*) FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_dk_stage7_set_updated_at' AND t.tgenabled = 'O'
           AND c.relname IN ('inventory_items','inventory_costs','orders','expenses')
       ) = 4 THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/


-- ============================================================
-- SECTION STALE_ROW_DIAGNOSIS（只讀）
-- RESYNC 後 items/order_items 超集。禁止 DELETE。
-- ID 公式與 M1 / M2 相同。不輸出成本、客戶姓名、note。
-- ============================================================
/*

WITH
src_items AS (
  SELECT COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text)) AS id
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
  WHERE d.id = 'default'
),
src_order_items AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) AS order_id,
    line.ordinality::integer AS ordinality
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
src_orders AS (
  SELECT COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text)) AS id
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
  WHERE d.id = 'default'
),
stale_items AS (
  SELECT i.id
  FROM public.inventory_items i
  WHERE NOT EXISTS (SELECT 1 FROM src_items s WHERE s.id = i.id)
),
missing_items AS (
  SELECT s.id
  FROM src_items s
  WHERE NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = s.id)
),
stale_order_items AS (
  SELECT oi.id, oi.order_id
  FROM public.order_items oi
  WHERE NOT EXISTS (SELECT 1 FROM src_order_items s WHERE s.order_item_id = oi.id)
),
missing_order_items AS (
  SELECT s.order_item_id
  FROM src_order_items s
  WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = s.order_item_id)
)
SELECT 10 AS seq, 'summary.v2_data.default'::text AS check_name,
       (SELECT COUNT(*)::text FROM public.v2_data WHERE id = 'default'), '1'
UNION ALL SELECT 11, 'summary.items.legacy_array',
       (SELECT jsonb_array_length(COALESCE(data->'items','[]'::jsonb))::text FROM public.v2_data WHERE id = 'default'), NULL
UNION ALL SELECT 12, 'summary.items.src_id_rows',
       (SELECT COUNT(*)::text FROM src_items), NULL
UNION ALL SELECT 13, 'summary.items.src_id_distinct',
       (SELECT COUNT(DISTINCT id)::text FROM src_items), NULL
UNION ALL SELECT 14, 'summary.items.table',
       (SELECT COUNT(*)::text FROM public.inventory_items), NULL
UNION ALL SELECT 15, 'summary.items.stale_table_minus_src',
       (SELECT COUNT(*)::text FROM stale_items), '1 expected from POSTCHECK'
UNION ALL SELECT 16, 'summary.items.src_minus_table',
       (SELECT COUNT(*)::text FROM missing_items), '0'
UNION ALL SELECT 17, 'summary.items.v2_blank_id',
       (
         SELECT COUNT(*)::text
         FROM public.v2_data d,
              LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
         WHERE d.id = 'default' AND NULLIF(i->>'id','') IS NULL
       ), '0'
UNION ALL SELECT 20, 'summary.order_items.legacy_lines',
       (
         SELECT COUNT(*)::text
         FROM public.v2_data d,
              LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
              LATERAL jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
         WHERE d.id = 'default'
       ), NULL
UNION ALL SELECT 21, 'summary.order_items.src_generated',
       (SELECT COUNT(*)::text FROM src_order_items), NULL
UNION ALL SELECT 22, 'summary.order_items.src_generated_distinct',
       (SELECT COUNT(DISTINCT order_item_id)::text FROM src_order_items), NULL
UNION ALL SELECT 23, 'summary.order_items.table',
       (SELECT COUNT(*)::text FROM public.order_items), NULL
UNION ALL SELECT 24, 'summary.order_items.stale_table_minus_src',
       (SELECT COUNT(*)::text FROM stale_order_items), '2 expected from POSTCHECK'
UNION ALL SELECT 25, 'summary.order_items.src_minus_table',
       (SELECT COUNT(*)::text FROM missing_order_items), '0'
UNION ALL SELECT 30, 'summary.inventory_costs.table',
       (SELECT COUNT(*)::text FROM public.inventory_costs), NULL
UNION ALL SELECT 31, 'summary.order_item_costs.table',
       (SELECT COUNT(*)::text FROM public.order_item_costs), NULL
ORDER BY 1;

WITH
src_items AS (
  SELECT COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text)) AS id
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
  WHERE d.id = 'default'
),
stale_items AS (
  SELECT i.id
  FROM public.inventory_items i
  WHERE NOT EXISTS (SELECT 1 FROM src_items s WHERE s.id = i.id)
)
SELECT
  left(md5(s.id), 12) AS id_hash,
  left(s.id, 10) AS id_prefix,
  (s.id LIKE 'missing-item-%') AS is_missing_item_fallback,
  EXISTS (
    SELECT 1 FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default' AND (i->>'id') = s.id
  ) AS raw_json_id_still_in_v2,
  (SELECT COUNT(*) FROM public.inventory_ledger l WHERE l.item_id = s.id) AS ledger_ref_count,
  (SELECT COUNT(*) FROM public.order_items oi WHERE oi.item_id = s.id) AS order_item_ref_count,
  EXISTS (SELECT 1 FROM public.inventory_costs c WHERE c.item_id = s.id) AS has_inventory_costs_child,
  (
    NOT EXISTS (
      SELECT 1 FROM public.v2_data d,
           LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
      WHERE d.id = 'default' AND (i->>'id') = s.id
    )
    AND s.id NOT LIKE 'missing-item-%'
  ) AS is_hard_deleted_from_current_v2_items
FROM stale_items s
ORDER BY 1;

WITH
src_order_items AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id,
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) AS order_id
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
src_orders AS (
  SELECT COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text)) AS id
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
  WHERE d.id = 'default'
),
stale_order_items AS (
  SELECT oi.id, oi.order_id
  FROM public.order_items oi
  WHERE NOT EXISTS (SELECT 1 FROM src_order_items s WHERE s.order_item_id = oi.id)
)
SELECT
  left(md5(s.id), 12) AS id_hash,
  left(s.id, 10) AS id_prefix,
  left(md5(s.order_id), 12) AS order_id_hash,
  left(s.order_id, 10) AS order_id_prefix,
  substring(s.id from ':([0-9]+)$') AS ordinal_part,
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = s.order_id) AS parent_order_in_table,
  EXISTS (SELECT 1 FROM src_orders o WHERE o.id = s.order_id) AS parent_order_in_v2,
  (SELECT COUNT(*) FROM src_order_items x WHERE x.order_id = s.order_id) AS v2_line_count_for_order,
  (SELECT COUNT(*) FROM public.order_items x WHERE x.order_id = s.order_id) AS table_line_count_for_order,
  EXISTS (SELECT 1 FROM public.order_item_costs c WHERE c.order_item_id = s.id) AS has_order_item_costs_child,
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM src_orders o WHERE o.id = s.order_id)
      THEN 'parent_order_removed_from_v2'
    WHEN COALESCE(substring(s.id from ':([0-9]+)$')::int, 0)
         > (SELECT COUNT(*) FROM src_order_items x WHERE x.order_id = s.order_id)
      THEN 'ordinal_beyond_current_line_count'
    WHEN (SELECT COUNT(*) FROM public.order_items x WHERE x.order_id = s.order_id)
         > (SELECT COUNT(*) FROM src_order_items x WHERE x.order_id = s.order_id)
      THEN 'same_order_line_count_dropped_or_reordered'
    ELSE 'id_no_longer_in_generated_set'
  END AS likely_cause
FROM stale_order_items s
ORDER BY 1;

*/


-- ============================================================
-- SECTION STALE_ROW_RECONCILIATION
-- 只刪「normalized 有、目前 v2_data generated set 沒有」的殘列。
-- 不准碰 v2_data / inventory_ledger / orders。
-- inventory_costs / order_item_costs 走既定 ON DELETE CASCADE。
-- 不寫死 ID 或 count。可重跑。
-- ============================================================
/*

BEGIN;

DO $$
DECLARE
  v2_cnt integer;
  dup_item integer;
  dup_order integer;
  src_item_n integer;
  src_line_n integer;
BEGIN
  SELECT COUNT(*) INTO v2_cnt FROM public.v2_data WHERE id = 'default';
  IF v2_cnt <> 1 THEN
    RAISE EXCEPTION 'RECONCILE 中止：v2_data id=default 必須恰好 1 列（目前 %）', v2_cnt;
  END IF;
  IF (SELECT COUNT(*) FROM public.v2_data) <> 1 THEN
    RAISE EXCEPTION 'RECONCILE 中止：v2_data 必須恰好 1 列';
  END IF;

  SELECT COUNT(*) INTO dup_item FROM (
    SELECT COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text))
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  SELECT COUNT(*) INTO dup_order FROM (
    SELECT COALESCE(NULLIF(o->>'id',''), 'missing-order-' || md5(o::text))
    FROM public.v2_data d,
         LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o
    WHERE d.id = 'default'
    GROUP BY 1 HAVING COUNT(*) > 1
  ) s;
  IF dup_item > 0 OR dup_order > 0 THEN
    RAISE EXCEPTION 'RECONCILE 中止：來源 PK 重複（item=% order=%）', dup_item, dup_order;
  END IF;

  SELECT jsonb_array_length(COALESCE(data->'items','[]'::jsonb))
    INTO src_item_n FROM public.v2_data WHERE id = 'default';
  IF src_item_n IS NULL OR src_item_n = 0 THEN
    RAISE EXCEPTION 'RECONCILE 中止：v2_data.items 不可為空';
  END IF;

  SELECT COUNT(*) INTO src_line_n
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) o,
       LATERAL jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
  WHERE d.id = 'default';
  IF src_line_n = 0 AND (SELECT COUNT(*) FROM public.order_items) > 0 THEN
    RAISE EXCEPTION 'RECONCILE 中止：generated order_items 為 0 但表內有列，拒絕 prune';
  END IF;
END $$;

WITH
src_items AS (
  SELECT COALESCE(NULLIF(i->>'id',''), 'missing-item-' || md5(i::text)) AS id
  FROM public.v2_data d,
       LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) i
  WHERE d.id = 'default'
),
src_order_items AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
del_lines AS (
  DELETE FROM public.order_items oi
  WHERE NOT EXISTS (
    SELECT 1 FROM src_order_items s WHERE s.order_item_id = oi.id
  )
  RETURNING id
),
del_items AS (
  DELETE FROM public.inventory_items i
  WHERE NOT EXISTS (
    SELECT 1 FROM src_items s WHERE s.id = i.id
  )
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM del_items) AS deleted_stale_inventory_items,
  (SELECT COUNT(*) FROM del_lines) AS deleted_stale_order_items;

COMMIT;

*/


-- ============================================================
-- SECTION RECONCILE_POSTCHECK（只讀；STALE_ROW_RECONCILIATION 成功後立刻跑）
-- 至少驗 items / costs / order_items 對齊、generated ID、checksum。
-- ledger / COGS 不得倒退。每一列 verdict 必須 PASS。禁止進 M3。
-- ============================================================
/*

WITH
legacy AS (
  SELECT
    jsonb_array_length(COALESCE(data->'items','[]'::jsonb)) AS items,
    jsonb_array_length(COALESCE(data->'ledger','[]'::jsonb)) AS ledger,
    jsonb_array_length(COALESCE(data->'orders','[]'::jsonb)) AS orders,
    jsonb_array_length(COALESCE(data->'expenses','[]'::jsonb)) AS expenses,
    jsonb_array_length(COALESCE(data->'auditLogs','[]'::jsonb)) AS audit,
    (
      SELECT COUNT(*)
      FROM jsonb_array_elements(COALESCE(data->'orders','[]'::jsonb)) o,
           jsonb_array_elements(COALESCE(o->'items','[]'::jsonb))
    ) AS order_lines
  FROM public.v2_data
  WHERE id = 'default'
),
line_ids AS (
  SELECT
    COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text))
      || ':' || (line.ordinality::text) AS order_item_id
  FROM public.v2_data d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
  WHERE d.id = 'default'
),
checksums AS (
  SELECT
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY item_id) FROM public.inventory_costs)) AS new_item_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(i->>'cost_unit','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY i->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'items','[]'::jsonb)) AS i
      WHERE d.id = 'default'
    )) AS legacy_item_cost,
    md5((SELECT string_agg(to_char(COALESCE(unit_cost,0), 'FM9999999990.00'), ',' ORDER BY ledger_id) FROM public.inventory_ledger_costs)) AS new_ledger_cost,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(e->>'unit_cost','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY e->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'ledger','[]'::jsonb)) AS e
      WHERE d.id = 'default'
    )) AS legacy_ledger_cost,
    md5((SELECT string_agg(to_char(COALESCE(cogs_total,0), 'FM9999999990.00'), ',' ORDER BY order_id) FROM public.order_costs)) AS new_cogs,
    md5((
      SELECT string_agg(to_char(COALESCE(NULLIF(o->>'cogs_total','')::numeric, 0), 'FM9999999990.00'), ',' ORDER BY o->>'id')
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) AS o
      WHERE d.id = 'default'
    )) AS legacy_cogs,
    md5((SELECT string_agg(to_char(COALESCE(cost_unit,0), 'FM9999999990.00'), ',' ORDER BY order_item_id) FROM public.order_item_costs)) AS new_line_cost,
    md5((
      SELECT string_agg(
        to_char(COALESCE(NULLIF(COALESCE(line.elem->>'cost_unit', line.elem->>'costUnit'),'')::numeric, 0), 'FM9999999990.00'),
        ',' ORDER BY COALESCE(NULLIF(ord.elem->>'id',''), 'missing-order-' || md5(ord.elem::text)) || ':' || (line.ordinality::text)
      )
      FROM public.v2_data d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data->'orders','[]'::jsonb)) WITH ORDINALITY AS ord(elem, ordinality)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'items','[]'::jsonb)) WITH ORDINALITY AS line(elem, ordinality)
      WHERE d.id = 'default'
    )) AS legacy_line_cost
)
SELECT 10 AS seq, 'v2_data.row_count'::text AS check_name,
       (SELECT COUNT(*) FROM public.v2_data)::text AS actual, '1'::text AS expected,
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 11, 'v2_data.default_id',
       (SELECT COUNT(*)::text FROM public.v2_data WHERE id = 'default'), '1',
       CASE WHEN (SELECT COUNT(*) FROM public.v2_data WHERE id = 'default') = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'count.items',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_items), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'count.inventory_costs',
       (SELECT items::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_costs), 'equal',
       CASE WHEN (SELECT items FROM legacy) = (SELECT COUNT(*) FROM public.inventory_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'count.ledger',
       (SELECT ledger::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.inventory_ledger), 'equal',
       CASE WHEN (SELECT ledger FROM legacy) = (SELECT COUNT(*) FROM public.inventory_ledger) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'count.order_items',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_items), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_items) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'count.order_item_costs',
       (SELECT order_lines::text FROM legacy) || ' -> ' || (SELECT COUNT(*)::text FROM public.order_item_costs), 'equal',
       CASE WHEN (SELECT order_lines FROM legacy) = (SELECT COUNT(*) FROM public.order_item_costs) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'id.order_item_generated_missing_in_table',
       (SELECT COUNT(*)::text FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM line_ids g WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = g.order_item_id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'id.order_item_table_not_in_generated',
       (SELECT COUNT(*)::text FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)), '0',
       CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE NOT EXISTS (SELECT 1 FROM line_ids g WHERE g.order_item_id = oi.id)) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'checksum.item_cost_match',
       (SELECT (new_item_cost = legacy_item_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_item_cost = legacy_item_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'checksum.ledger_cost_match',
       (SELECT (new_ledger_cost = legacy_ledger_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_ledger_cost = legacy_ledger_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'checksum.cogs_match',
       (SELECT (new_cogs = legacy_cogs)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_cogs = legacy_cogs FROM checksums) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'checksum.order_line_cost_match',
       (SELECT (new_line_cost = legacy_line_cost)::text FROM checksums), 'true',
       CASE WHEN (SELECT new_line_cost = legacy_line_cost FROM checksums) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/


-- ============================================================
-- SECTION M3_RLS  ★ Production live = SUCCESS。不要重跑。
-- M0 已 ENABLE RLS 且 REVOKE client。本 SECTION 才 GRANT + policy。不改 v2_data。
-- ============================================================
/*

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_ledger_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.inventory_items FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.inventory_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.inventory_ledger FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.inventory_ledger_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.orders FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_items FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_item_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.expenses FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon;

GRANT SELECT ON TABLE public.inventory_items TO authenticated;
GRANT SELECT ON TABLE public.inventory_ledger TO authenticated;
GRANT SELECT ON TABLE public.orders TO authenticated;
GRANT SELECT ON TABLE public.order_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_ledger TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_ledger_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_item_costs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.expenses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_logs TO authenticated;
-- 實際 row 權限由 policy 再縮：staff 對成本表 DENY；對 items 僅 SELECT。

DROP POLICY IF EXISTS inventory_items_select_backoffice ON public.inventory_items;
DROP POLICY IF EXISTS inventory_items_write_admin ON public.inventory_items;
CREATE POLICY inventory_items_select_backoffice
  ON public.inventory_items FOR SELECT TO authenticated
  USING (public.is_enabled_backoffice_user());
CREATE POLICY inventory_items_write_admin
  ON public.inventory_items FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS inventory_costs_admin ON public.inventory_costs;
CREATE POLICY inventory_costs_admin
  ON public.inventory_costs FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS inventory_ledger_select_backoffice ON public.inventory_ledger;
DROP POLICY IF EXISTS inventory_ledger_write_admin ON public.inventory_ledger;
CREATE POLICY inventory_ledger_select_backoffice
  ON public.inventory_ledger FOR SELECT TO authenticated
  USING (public.is_enabled_backoffice_user());
CREATE POLICY inventory_ledger_write_admin
  ON public.inventory_ledger FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS inventory_ledger_costs_admin ON public.inventory_ledger_costs;
CREATE POLICY inventory_ledger_costs_admin
  ON public.inventory_ledger_costs FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS orders_select_backoffice ON public.orders;
DROP POLICY IF EXISTS orders_write_admin ON public.orders;
CREATE POLICY orders_select_backoffice
  ON public.orders FOR SELECT TO authenticated
  USING (public.is_enabled_backoffice_user());
CREATE POLICY orders_write_admin
  ON public.orders FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS order_costs_admin ON public.order_costs;
CREATE POLICY order_costs_admin
  ON public.order_costs FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS order_items_select_backoffice ON public.order_items;
DROP POLICY IF EXISTS order_items_write_admin ON public.order_items;
CREATE POLICY order_items_select_backoffice
  ON public.order_items FOR SELECT TO authenticated
  USING (public.is_enabled_backoffice_user());
CREATE POLICY order_items_write_admin
  ON public.order_items FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS order_item_costs_admin ON public.order_item_costs;
CREATE POLICY order_item_costs_admin
  ON public.order_item_costs FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS expenses_admin ON public.expenses;
CREATE POLICY expenses_admin
  ON public.expenses FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS audit_logs_admin ON public.audit_logs;
CREATE POLICY audit_logs_admin
  ON public.audit_logs FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 注意：inventory_ledger / orders / order_items 基表不含成本欄。
-- 成本在 *_costs 表。staff 可 SELECT 基表，不能 SELECT *_costs。
-- 這是「拆成本表」而不是 column RLS。

*/


-- ============================================================
-- SECTION M4_RPC  ★ Production live = SUCCESS。不要重跑。
-- SECURITY DEFINER + 固定 search_path + 驗證 auth.uid() / enabled role
-- staff 參數不得含 cost；回傳不得含 cost / cogs
-- 建單必須單一 function 原子：先鎖庫存、先寫 orders、再寫 lines / 扣庫存 / ledger
-- 禁止 create_order 內呼叫 adjust_stock（避免雙重扣庫與 FK 順序錯誤）
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.inventory_costs') IS NULL
     OR to_regclass('public.inventory_ledger') IS NULL
     OR to_regclass('public.inventory_ledger_costs') IS NULL
     OR to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_costs') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.order_item_costs') IS NULL
  THEN
    RAISE EXCEPTION 'M4_RPC blocked: Stage 7 tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M4_RPC blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_require_backoffice()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r TEXT;
  uid uuid;
BEGIN
  uid := (SELECT auth.uid());
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_enabled_backoffice_user() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  SELECT p.role INTO r
  FROM public.profiles p
  WHERE p.id = uid
    AND p.enabled = true
    AND p.role IN ('admin', 'staff');
  IF r IS NULL THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_require_backoffice() FROM PUBLIC, anon, authenticated;

-- staff/admin 補貨或扣庫。不接受 cost。不更新 inventory_costs.cost_unit。
-- server 讀既有成本，只把 snapshot 寫入 inventory_ledger_costs。
CREATE OR REPLACE FUNCTION public.backoffice_adjust_stock(
  p_item_id TEXT,
  p_qty_delta NUMERIC,
  p_operation_type TEXT,
  p_note TEXT DEFAULT NULL,
  p_inbound_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  cur_qty NUMERIC;
  new_qty NUMERIC;
  cur_cost NUMERIC;
  ledger_id TEXT;
  abs_qty NUMERIC;
  ledger_qty NUMERIC;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'item_id required';
  END IF;
  IF p_operation_type NOT IN ('IN', 'OUT', 'ADJUST') THEN
    RAISE EXCEPTION 'invalid operation_type';
  END IF;
  abs_qty := ABS(COALESCE(p_qty_delta, 0));
  IF p_operation_type <> 'ADJUST' AND abs_qty <= 0 THEN
    RAISE EXCEPTION 'qty_delta must be > 0';
  END IF;

  SELECT qty_on_hand INTO cur_qty
  FROM public.inventory_items
  WHERE id = p_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT COALESCE(cost_unit, 0) INTO cur_cost
  FROM public.inventory_costs
  WHERE item_id = p_item_id;
  IF NOT FOUND THEN
    cur_cost := 0;
  END IF;

  IF p_operation_type = 'IN' THEN
    new_qty := COALESCE(cur_qty, 0) + abs_qty;
    ledger_qty := abs_qty;
  ELSIF p_operation_type = 'OUT' THEN
    IF abs_qty > COALESCE(cur_qty, 0) THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;
    new_qty := COALESCE(cur_qty, 0) - abs_qty;
    ledger_qty := -abs_qty;
  ELSE
    new_qty := GREATEST(COALESCE(p_qty_delta, 0), 0);
    ledger_qty := new_qty - COALESCE(cur_qty, 0);
  END IF;

  UPDATE public.inventory_items
  SET qty_on_hand = new_qty,
      last_moved_at = pg_catalog.now(),
      inbound_date = CASE
        WHEN p_operation_type = 'IN' AND p_inbound_date IS NOT NULL THEN p_inbound_date
        ELSE inbound_date
      END,
      is_archived = CASE WHEN new_qty > 0 THEN false ELSE true END,
      archived_at = CASE
        WHEN COALESCE(cur_qty, 0) > 0 AND new_qty <= 0 THEN pg_catalog.now()
        WHEN new_qty > 0 THEN NULL
        ELSE archived_at
      END,
      updated_at = pg_catalog.now()
  WHERE id = p_item_id;

  -- staff/admin 此 RPC 都不改成本；缺 row 才補 0，不覆蓋既有 cost_unit。
  INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
  VALUES (p_item_id, COALESCE(cur_cost, 0), pg_catalog.now())
  ON CONFLICT (item_id) DO NOTHING;

  ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');

  INSERT INTO public.inventory_ledger (id, item_id, type, qty, ref_type, note, created_at)
  VALUES (
    ledger_id,
    p_item_id,
    p_operation_type,
    ledger_qty,
    CASE WHEN p_operation_type = 'IN' THEN 'PURCHASE'
         WHEN p_operation_type = 'OUT' THEN 'ORDER'
         ELSE 'ADJUST' END,
    p_note,
    pg_catalog.now()
  );

  INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
  VALUES (ledger_id, COALESCE(cur_cost, 0));

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_on_hand', new_qty,
    'ledger_id', ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE) TO authenticated;

-- admin 補貨可傳新單位成本並更新加權平均。staff 必須 DENY。
CREATE OR REPLACE FUNCTION public.backoffice_admin_adjust_stock(
  p_item_id TEXT,
  p_qty_delta NUMERIC,
  p_operation_type TEXT,
  p_unit_cost NUMERIC DEFAULT NULL,
  p_note TEXT DEFAULT NULL,
  p_inbound_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  cur_qty NUMERIC;
  new_qty NUMERIC;
  cur_cost NUMERIC;
  in_cost NUMERIC;
  new_cost NUMERIC;
  ledger_id TEXT;
  ledger_qty NUMERIC;
  abs_qty NUMERIC;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'item_id required';
  END IF;
  IF p_operation_type NOT IN ('IN', 'OUT', 'ADJUST') THEN
    RAISE EXCEPTION 'invalid operation_type';
  END IF;
  abs_qty := ABS(COALESCE(p_qty_delta, 0));
  IF p_operation_type <> 'ADJUST' AND abs_qty <= 0 THEN
    RAISE EXCEPTION 'qty_delta must be > 0';
  END IF;

  SELECT qty_on_hand INTO cur_qty
  FROM public.inventory_items
  WHERE id = p_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'item not found';
  END IF;

  SELECT COALESCE(cost_unit, 0) INTO cur_cost
  FROM public.inventory_costs
  WHERE item_id = p_item_id;
  IF NOT FOUND THEN
    cur_cost := 0;
  END IF;

  in_cost := COALESCE(p_unit_cost, cur_cost);

  IF p_operation_type = 'IN' THEN
    new_qty := COALESCE(cur_qty, 0) + abs_qty;
    IF abs_qty > 0 AND in_cost > 0 THEN
      new_cost := (COALESCE(cur_qty, 0) * cur_cost + abs_qty * in_cost) / new_qty;
    ELSE
      new_cost := cur_cost;
    END IF;
    ledger_qty := abs_qty;
  ELSIF p_operation_type = 'OUT' THEN
    IF abs_qty > COALESCE(cur_qty, 0) THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;
    new_qty := COALESCE(cur_qty, 0) - abs_qty;
    new_cost := cur_cost;
    in_cost := cur_cost;
    ledger_qty := -abs_qty;
  ELSE
    new_qty := GREATEST(COALESCE(p_qty_delta, 0), 0);
    new_cost := COALESCE(p_unit_cost, cur_cost);
    ledger_qty := new_qty - COALESCE(cur_qty, 0);
  END IF;

  UPDATE public.inventory_items
  SET qty_on_hand = new_qty,
      last_moved_at = pg_catalog.now(),
      inbound_date = CASE
        WHEN p_operation_type = 'IN' AND p_inbound_date IS NOT NULL THEN p_inbound_date
        ELSE inbound_date
      END,
      is_archived = CASE WHEN new_qty > 0 THEN false ELSE true END,
      archived_at = CASE
        WHEN COALESCE(cur_qty, 0) > 0 AND new_qty <= 0 THEN pg_catalog.now()
        WHEN new_qty > 0 THEN NULL
        ELSE archived_at
      END,
      updated_at = pg_catalog.now()
  WHERE id = p_item_id;

  INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
  VALUES (p_item_id, new_cost, pg_catalog.now())
  ON CONFLICT (item_id) DO UPDATE SET
    cost_unit = EXCLUDED.cost_unit,
    updated_at = pg_catalog.now();

  ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  INSERT INTO public.inventory_ledger (id, item_id, type, qty, ref_type, note, created_at)
  VALUES (
    ledger_id,
    p_item_id,
    p_operation_type,
    ledger_qty,
    CASE WHEN p_operation_type = 'IN' THEN 'PURCHASE'
         WHEN p_operation_type = 'OUT' THEN 'ORDER'
         ELSE 'ADJUST' END,
    p_note,
    pg_catalog.now()
  );
  INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
  VALUES (ledger_id, COALESCE(in_cost, 0));

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_on_hand', new_qty,
    'ledger_id', ledger_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE) TO authenticated;

-- 建單：p_lines = [{item_id, qty, unit_price}]，不得含 cost。
-- 回傳不含 cogs / cost_unit。單一 function 原子；不呼叫 adjust_stock。
CREATE OR REPLACE FUNCTION public.backoffice_create_order(
  p_order_no TEXT,
  p_customer_name TEXT,
  p_sales_type TEXT,
  p_shipping_income NUMERIC,
  p_discount NUMERIC,
  p_payment_method TEXT,
  p_status TEXT,
  p_lines JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_order_id TEXT;
  v_line JSONB;
  rec RECORD;
  v_item_id TEXT;
  v_need NUMERIC;
  v_price NUMERIC;
  v_on_hand NUMERIC;
  v_unit_cost NUMERIC;
  v_cogs NUMERIC := 0;
  v_total_sale NUMERIC := 0;
  v_line_id TEXT;
  v_line_ord BIGINT;
  v_ledger_id TEXT;
  v_new_qty NUMERIC;
  v_order_status TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_order_no IS NULL OR p_order_no = '' THEN
    RAISE EXCEPTION 'order_no required';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_lines) < 1 THEN
    RAISE EXCEPTION 'lines required';
  END IF;

  v_order_status := COALESCE(NULLIF(p_status, ''), 'pending');

  FOR v_line IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  LOOP
    IF v_line ?| ARRAY['cost_unit', 'costUnit', 'unit_cost', 'unitCost', 'cogs', 'cogs_total', 'cogsTotal'] THEN
      RAISE EXCEPTION 'line must not contain cost fields';
    END IF;
    v_item_id := COALESCE(v_line->>'item_id', '');
    v_need := COALESCE((v_line->>'qty')::numeric, 0);
    IF v_item_id = '' OR v_need <= 0 THEN
      RAISE EXCEPTION 'invalid line';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.order_no = p_order_no) THEN
    RAISE EXCEPTION 'duplicate order_no';
  END IF;

  -- 依 item_id 排序加總後 FOR UPDATE，避免同品多行漏檢與死鎖。
  FOR rec IN
    SELECT
      COALESCE(t.elem->>'item_id', '') AS item_id,
      SUM(COALESCE((t.elem->>'qty')::numeric, 0)) AS need
    FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
    GROUP BY 1
    ORDER BY 1
  LOOP
    SELECT it.qty_on_hand INTO v_on_hand
    FROM public.inventory_items it
    WHERE it.id = rec.item_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found';
    END IF;
    IF rec.need > COALESCE(v_on_hand, 0) THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(
           COALESCE((t.elem->>'qty')::numeric, 0) * COALESCE((t.elem->>'unit_price')::numeric, 0)
         ), 0)
  INTO v_total_sale
  FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem);

  SELECT COALESCE(SUM(
           COALESCE((t.elem->>'qty')::numeric, 0) * COALESCE(ic.cost_unit, 0)
         ), 0)
  INTO v_cogs
  FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  LEFT JOIN public.inventory_costs ic ON ic.item_id = t.elem->>'item_id';

  v_order_id := 'ord-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');

  INSERT INTO public.orders (
    id, order_no, customer_name, sales_type, total_sale, shipping_income, discount,
    payment_method, status, date, created_at, updated_at
  ) VALUES (
    v_order_id,
    p_order_no,
    p_customer_name,
    p_sales_type,
    v_total_sale,
    COALESCE(p_shipping_income, 0),
    COALESCE(p_discount, 0),
    p_payment_method,
    v_order_status,
    (pg_catalog.now())::date,
    pg_catalog.now(),
    pg_catalog.now()
  );

  FOR rec IN
    SELECT e.elem, e.ord
    FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS e(elem, ord)
  LOOP
    v_line := rec.elem;
    v_line_ord := rec.ord;
    v_item_id := v_line->>'item_id';
    v_need := (v_line->>'qty')::numeric;
    v_price := COALESCE((v_line->>'unit_price')::numeric, 0);

    SELECT COALESCE(ic.cost_unit, 0) INTO v_unit_cost
    FROM public.inventory_costs ic
    WHERE ic.item_id = v_item_id;
    IF NOT FOUND THEN
      v_unit_cost := 0;
    END IF;

    v_line_id := v_order_id || ':' || v_line_ord::text;

    INSERT INTO public.order_items (id, order_id, item_id, sku, name, spec, qty, unit_price)
    SELECT v_line_id, v_order_id, it.id, it.sku, it.name, it.spec, v_need, v_price
    FROM public.inventory_items it
    WHERE it.id = v_item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found';
    END IF;

    INSERT INTO public.order_item_costs (order_item_id, cost_unit)
    VALUES (v_line_id, COALESCE(v_unit_cost, 0));

    UPDATE public.inventory_items
    SET qty_on_hand = qty_on_hand - v_need,
        last_moved_at = pg_catalog.now(),
        is_archived = CASE WHEN qty_on_hand - v_need > 0 THEN false ELSE true END,
        archived_at = CASE
          WHEN qty_on_hand > 0 AND qty_on_hand - v_need <= 0 THEN pg_catalog.now()
          WHEN qty_on_hand - v_need > 0 THEN NULL
          ELSE archived_at
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_item_id
      AND qty_on_hand >= v_need
    RETURNING qty_on_hand INTO v_new_qty;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;

    v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    INSERT INTO public.inventory_ledger (id, item_id, type, qty, ref_type, ref_id, note, created_at)
    VALUES (
      v_ledger_id,
      v_item_id,
      'OUT',
      -v_need,
      'ORDER',
      v_order_id,
      '訂單 ' || p_order_no,
      pg_catalog.now()
    );
    INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
    VALUES (v_ledger_id, COALESCE(v_unit_cost, 0));
  END LOOP;

  INSERT INTO public.order_costs (order_id, cogs_total) VALUES (v_order_id, v_cogs);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_order_id,
    'order_no', p_order_no,
    'total_sale', v_total_sale,
    'status', v_order_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_create_order(TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_order(TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) TO authenticated;

*/


-- ============================================================
-- SECTION M5_CUTOVER  ★ Production live = SUCCESS（SQL Editor 已執行）。不要重跑。
-- 前端已切 normalized tables + M4/M5 RPC。本 SECTION 只補
-- M4 沒有的 staff-safe 品項 upsert 與訂單更新 RPC。
-- 禁止 DROP / UPDATE / DELETE v2_data。v2_data 改為 archive。
-- 禁止兩邊永久雙寫。
-- ============================================================
/*

CREATE OR REPLACE FUNCTION public.backoffice_upsert_item(
  p_item JSONB,
  p_unit_cost NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id TEXT;
  v_qty NUMERIC;
  v_exists BOOLEAN;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_item IS NULL OR pg_catalog.jsonb_typeof(p_item) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'item required';
  END IF;
  IF p_item ?| ARRAY['cost_unit', 'costUnit', 'unit_cost', 'unitCost', 'cogs', 'cogs_total', 'cogsTotal'] THEN
    RAISE EXCEPTION 'item must not contain cost fields';
  END IF;

  v_id := COALESCE(NULLIF(p_item->>'id', ''), '');
  IF v_id = '' THEN
    v_id := 'i-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  END IF;

  SELECT true, it.qty_on_hand INTO v_exists, v_qty
  FROM public.inventory_items it
  WHERE it.id = v_id
  FOR UPDATE;
  IF NOT FOUND THEN
    v_exists := false;
    v_qty := 0;
  END IF;

  IF v_exists THEN
    UPDATE public.inventory_items
    SET sku = COALESCE(NULLIF(p_item->>'sku', ''), sku),
        category = COALESCE(p_item->>'category', category),
        sub_type = COALESCE(p_item->>'sub_type', sub_type),
        brand = COALESCE(p_item->>'brand', brand),
        model = COALESCE(p_item->>'model', model),
        name = COALESCE(NULLIF(p_item->>'name', ''), name),
        spec = COALESCE(p_item->>'spec', spec),
        vendor = COALESCE(p_item->>'vendor', vendor),
        condition = COALESCE(p_item->>'condition', condition),
        status = COALESCE(p_item->>'status', status),
        price_list = CASE WHEN p_item ? 'price_list' THEN NULLIF(p_item->>'price_list', '')::numeric ELSE price_list END,
        price_floor = CASE WHEN p_item ? 'price_floor' THEN NULLIF(p_item->>'price_floor', '')::numeric ELSE price_floor END,
        inbound_date = CASE WHEN p_item ? 'inbound_date' THEN NULLIF(p_item->>'inbound_date', '')::date ELSE inbound_date END,
        reorder_point = CASE WHEN p_item ? 'reorder_point' THEN COALESCE(NULLIF(p_item->>'reorder_point', '')::numeric, 0) ELSE reorder_point END,
        location = CASE WHEN p_item ? 'location' THEN NULLIF(p_item->>'location', '') ELSE location END,
        notes = CASE WHEN p_item ? 'notes' THEN NULLIF(p_item->>'notes', '') ELSE notes END,
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSE
    INSERT INTO public.inventory_items (
      id, sku, category, sub_type, brand, model, name, spec, vendor, condition, status,
      qty_on_hand, price_list, price_floor, inbound_date, last_moved_at, reorder_point,
      location, notes, is_archived, archived_at, extra, created_at, updated_at
    ) VALUES (
      v_id,
      NULLIF(p_item->>'sku', ''),
      NULLIF(p_item->>'category', ''),
      NULLIF(p_item->>'sub_type', ''),
      NULLIF(p_item->>'brand', ''),
      NULLIF(p_item->>'model', ''),
      COALESCE(NULLIF(p_item->>'name', ''), '未命名'),
      NULLIF(p_item->>'spec', ''),
      NULLIF(p_item->>'vendor', ''),
      COALESCE(NULLIF(p_item->>'condition', ''), 'USED'),
      COALESCE(NULLIF(p_item->>'status', ''), 'READY'),
      0,
      NULLIF(p_item->>'price_list', '')::numeric,
      NULLIF(p_item->>'price_floor', '')::numeric,
      NULLIF(p_item->>'inbound_date', '')::date,
      NULL,
      COALESCE(NULLIF(p_item->>'reorder_point', '')::numeric, 0),
      NULLIF(p_item->>'location', ''),
      NULLIF(p_item->>'notes', ''),
      false,
      NULL,
      '{}'::jsonb,
      pg_catalog.now(),
      pg_catalog.now()
    );
    INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
    VALUES (v_id, 0, pg_catalog.now())
    ON CONFLICT (item_id) DO NOTHING;
  END IF;

  IF v_role = 'admin' AND public.is_admin() AND p_unit_cost IS NOT NULL THEN
    INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
    VALUES (v_id, p_unit_cost, pg_catalog.now())
    ON CONFLICT (item_id) DO UPDATE SET
      cost_unit = EXCLUDED.cost_unit,
      updated_at = pg_catalog.now();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'qty_on_hand', COALESCE(v_qty, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_upsert_item(JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_item(JSONB, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_update_order(
  p_order_id TEXT,
  p_order_no TEXT,
  p_customer_name TEXT,
  p_sales_type TEXT,
  p_shipping_income NUMERIC,
  p_discount NUMERIC,
  p_payment_method TEXT,
  p_status TEXT,
  p_lines JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  rec RECORD;
  v_line JSONB;
  v_item_id TEXT;
  v_need NUMERIC;
  v_price NUMERIC;
  v_on_hand NUMERIC;
  v_unit_cost NUMERIC;
  v_old_qty NUMERIC;
  v_delta NUMERIC;
  v_cogs NUMERIC := 0;
  v_total_sale NUMERIC := 0;
  v_line_id TEXT;
  v_ledger_id TEXT;
  v_order_status TEXT;
  v_order_no TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF p_order_id IS NULL OR p_order_id = '' THEN
    RAISE EXCEPTION 'order_id required';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_lines) < 1 THEN
    RAISE EXCEPTION 'lines required';
  END IF;
  v_order_no := COALESCE(NULLIF(p_order_no, ''), '');
  IF v_order_no = '' THEN
    RAISE EXCEPTION 'order_no required';
  END IF;
  v_order_status := COALESCE(NULLIF(p_status, ''), 'pending');

  PERFORM 1 FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.order_no = v_order_no AND o.id <> p_order_id
  ) THEN
    RAISE EXCEPTION 'duplicate order_no';
  END IF;

  FOR v_line IN SELECT elem FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  LOOP
    IF v_line ?| ARRAY['cost_unit', 'costUnit', 'unit_cost', 'unitCost', 'cogs', 'cogs_total', 'cogsTotal'] THEN
      RAISE EXCEPTION 'line must not contain cost fields';
    END IF;
    IF COALESCE(v_line->>'item_id', '') = '' OR COALESCE((v_line->>'qty')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid line';
    END IF;
  END LOOP;

  FOR rec IN
    SELECT x.item_id, SUM(x.need) AS need
    FROM (
      SELECT oi.item_id, COALESCE(oi.qty, 0) * -1 AS need
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
      UNION ALL
      SELECT t.elem->>'item_id', COALESCE((t.elem->>'qty')::numeric, 0)
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
    ) x
    WHERE COALESCE(x.item_id, '') <> ''
    GROUP BY 1
    ORDER BY 1
  LOOP
    SELECT it.qty_on_hand INTO v_on_hand
    FROM public.inventory_items it
    WHERE it.id = rec.item_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item not found';
    END IF;
    IF rec.need > 0 AND rec.need > COALESCE(v_on_hand, 0) THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(
           COALESCE((t.elem->>'qty')::numeric, 0) * COALESCE((t.elem->>'unit_price')::numeric, 0)
         ), 0)
  INTO v_total_sale
  FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem);

  SELECT COALESCE(SUM(
           COALESCE((t.elem->>'qty')::numeric, 0) * COALESCE(ic.cost_unit, 0)
         ), 0)
  INTO v_cogs
  FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
  LEFT JOIN public.inventory_costs ic ON ic.item_id = t.elem->>'item_id';

  FOR rec IN
    SELECT x.item_id, SUM(x.need) AS delta
    FROM (
      SELECT oi.item_id, COALESCE(oi.qty, 0) * -1 AS need
      FROM public.order_items oi
      WHERE oi.order_id = p_order_id
      UNION ALL
      SELECT t.elem->>'item_id', COALESCE((t.elem->>'qty')::numeric, 0)
      FROM pg_catalog.jsonb_array_elements(p_lines) AS t(elem)
    ) x
    WHERE COALESCE(x.item_id, '') <> ''
    GROUP BY 1
  LOOP
    v_delta := COALESCE(rec.delta, 0);
    IF v_delta = 0 THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(ic.cost_unit, 0) INTO v_unit_cost
    FROM public.inventory_costs ic
    WHERE ic.item_id = rec.item_id;
    IF NOT FOUND THEN
      v_unit_cost := 0;
    END IF;

    UPDATE public.inventory_items
    SET qty_on_hand = qty_on_hand - v_delta,
        last_moved_at = pg_catalog.now(),
        is_archived = CASE WHEN qty_on_hand - v_delta > 0 THEN false ELSE true END,
        archived_at = CASE
          WHEN qty_on_hand > 0 AND qty_on_hand - v_delta <= 0 THEN pg_catalog.now()
          WHEN qty_on_hand - v_delta > 0 THEN NULL
          ELSE archived_at
        END,
        updated_at = pg_catalog.now()
    WHERE id = rec.item_id
      AND (v_delta <= 0 OR qty_on_hand >= v_delta);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient stock';
    END IF;

    v_ledger_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    INSERT INTO public.inventory_ledger (id, item_id, type, qty, ref_type, ref_id, note, created_at)
    VALUES (
      v_ledger_id,
      rec.item_id,
      CASE WHEN v_delta > 0 THEN 'OUT' ELSE 'IN' END,
      -v_delta,
      'ORDER',
      p_order_id,
      '訂單編輯 ' || v_order_no,
      pg_catalog.now()
    );
    INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
    VALUES (v_ledger_id, COALESCE(v_unit_cost, 0));
  END LOOP;

  UPDATE public.orders
  SET order_no = v_order_no,
      customer_name = p_customer_name,
      sales_type = p_sales_type,
      total_sale = v_total_sale,
      shipping_income = COALESCE(p_shipping_income, 0),
      discount = COALESCE(p_discount, 0),
      payment_method = p_payment_method,
      status = v_order_status,
      updated_at = pg_catalog.now()
  WHERE id = p_order_id;

  DELETE FROM public.order_items WHERE order_id = p_order_id;

  FOR rec IN
    SELECT e.elem, e.ord
    FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS e(elem, ord)
  LOOP
    v_line := rec.elem;
    v_item_id := v_line->>'item_id';
    v_need := (v_line->>'qty')::numeric;
    v_price := COALESCE((v_line->>'unit_price')::numeric, 0);
    SELECT COALESCE(ic.cost_unit, 0) INTO v_unit_cost
    FROM public.inventory_costs ic
    WHERE ic.item_id = v_item_id;
    IF NOT FOUND THEN
      v_unit_cost := 0;
    END IF;
    v_line_id := p_order_id || ':' || rec.ord::text;
    INSERT INTO public.order_items (id, order_id, item_id, sku, name, spec, qty, unit_price)
    SELECT v_line_id, p_order_id, it.id, it.sku, it.name, it.spec, v_need, v_price
    FROM public.inventory_items it
    WHERE it.id = v_item_id;
    INSERT INTO public.order_item_costs (order_item_id, cost_unit)
    VALUES (v_line_id, COALESCE(v_unit_cost, 0));
  END LOOP;

  INSERT INTO public.order_costs (order_id, cogs_total)
  VALUES (p_order_id, v_cogs)
  ON CONFLICT (order_id) DO UPDATE SET cogs_total = EXCLUDED.cogs_total;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_order_id,
    'order_no', v_order_no,
    'total_sale', v_total_sale,
    'status', v_order_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_update_order(TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_order(TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) TO authenticated;

*/


-- ============================================================
-- SECTION ROLLBACK / ARCHIVE
-- 預設不執行。禁止 DROP public.v2_data。
-- Production live 已 cutover：正規表為 SoT，v2_data 為 archive。
-- R-M1：M1 之後、尚未 cutover、v2_data 仍是 SoT 時，只清新表資料。
-- R-M0：連 schema 一起撤（trigger → child → parent → function）。
-- ============================================================
/*

-- R-M4：只撤 RPC（保留表與資料）
-- DROP FUNCTION IF EXISTS public.backoffice_update_order(TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS public.backoffice_upsert_item(JSONB, NUMERIC);
-- DROP FUNCTION IF EXISTS public.backoffice_create_order(TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE);
-- DROP FUNCTION IF EXISTS public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE);
-- DROP FUNCTION IF EXISTS public.dk_require_backoffice();

-- R-M3：撤 RLS policies（表仍在）
-- （逐張 DROP POLICY IF EXISTS ...）

-- R-M1：只清 10 張新表資料，保留 M0 schema。禁止碰 v2_data。
-- TRUNCATE TABLE
--   public.order_item_costs,
--   public.order_items,
--   public.order_costs,
--   public.orders,
--   public.inventory_ledger_costs,
--   public.inventory_ledger,
--   public.inventory_costs,
--   public.inventory_items,
--   public.expenses,
--   public.audit_logs
-- RESTART IDENTITY CASCADE;

-- R-M0：僅在尚未 cutover、且確認 v2_data 仍是 SoT 時
-- DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.expenses;
-- DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.orders;
-- DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.inventory_costs;
-- DROP TRIGGER IF EXISTS trg_dk_stage7_set_updated_at ON public.inventory_items;
-- DROP TABLE IF EXISTS public.order_item_costs;
-- DROP TABLE IF EXISTS public.order_items;
-- DROP TABLE IF EXISTS public.order_costs;
-- DROP TABLE IF EXISTS public.orders;
-- DROP TABLE IF EXISTS public.inventory_ledger_costs;
-- DROP TABLE IF EXISTS public.inventory_ledger;
-- DROP TABLE IF EXISTS public.inventory_costs;
-- DROP TABLE IF EXISTS public.inventory_items;
-- DROP TABLE IF EXISTS public.expenses;
-- DROP TABLE IF EXISTS public.audit_logs;
-- DROP FUNCTION IF EXISTS public.dk_stage7_set_updated_at();
-- 禁止 DROP public.v2_data。

*/
