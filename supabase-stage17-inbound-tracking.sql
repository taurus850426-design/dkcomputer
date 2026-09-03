-- ============================================================
-- DK Computer Stage 17-1：正式入庫流水 + 入庫更正 + 期間入庫金額
-- 到 Supabase Dashboard → SQL Editor
--
-- 本檔尚未在 Production 執行。禁止本對話／agent 對正式 DB Run。
--
-- 安全分區：整份檔案預設不可執行。
-- 開頭 abort guard 為唯一未註解區塊；其餘每一 SECTION 均包在 /* */。
-- 誤貼整份到 SQL Editor 時只會 abort，不會改 schema／RLS／RPC／資料。
--
-- 使用方式：只複製「一個」SECTION，刪除該區包圍的 /* 與 */ 後執行。
-- 建議順序：PREFLIGHT → M0_SCHEMA → M1_SECURITY → M2_FUNCTIONS → M3_VERIFY
--
-- Additive only：
--   + inventory_ledger.movement_type / business_date / source_* /
--     corrects_ledger_id / created_by / cost_status
--   + inventory_inbound_settings（go-live 追蹤起始日）
--   + 入庫更正／入庫金額／補成本 RPC
--   + 既有 adjust_stock 寫入正式 movement_type
--
-- RPC 相容（PostgREST named params）：
--   舊 signature 會 DROP，改成加 DEFAULT 的新參數。
--   不可同時保留 5-arg 與 8-arg overload（PGRST203 ambiguous）。
--   舊前端只送 p_item_id/p_qty_delta/p_operation_type/p_note/p_inbound_date
--   仍可打到新函式（後 3 個參數 DEFAULT NULL）。
--   部署順序：先 M2 SQL，再 push 新 frontend。
--
-- 禁止：
--   新平行 movement 表
--   把舊 ledger 自動分類成 MANUAL_IN
--   用 created_at 假裝 business_date
--   改 Stage 16 分潤／庫存總成本公式
--   改 AP / PO / purchase-orders 業務
--   把 PO received 當入庫
--   service_role 前端
--
-- 入庫 KPI（go-live 起，restatement）：
--   每個正式 inbound original：
--     effective_qty = original.qty + SUM(INBOUND_CORRECTION.qty)
--     effective_cost = 最近一筆 INBOUND_COST_CORRECTION.unit_cost
--                      否則 original ledger_costs.unit_cost
--     amount = effective_qty × effective_cost
--     歸屬 original.business_date
--
-- 數量／成本更正後：
--   server 以 go-live opening snapshot + 正式 ledger
--   restatement replay 重建 qty_on_hand 與 weighted-average cost_unit。
--   LEGACY 不重播。
--
-- 禁止：
--   UPDATE/DELETE 原始 ledger qty 或已確認 cost snapshot
--   把庫存更正成負數（INBOUND_CORRECTION_STOCK_CONFLICT）
-- ============================================================

DO $$
BEGIN
  RAISE EXCEPTION '禁止整份執行。請只複製單一 SECTION（去掉包圍的 /* */）後執行。本檔尚未在 Production 執行。';
END $$;


-- ============================================================
-- SECTION PREFLIGHT
-- 只讀。確認 Stage 7 ledger / Stage 16 物件，以及尚未誤建的 Stage 17 物件。
-- ============================================================
/*

SELECT 'inventory_ledger' AS obj,
       (to_regclass('public.inventory_ledger') IS NOT NULL)::text AS present,
       'true' AS expected,
       CASE WHEN to_regclass('public.inventory_ledger') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 'inventory_ledger_costs',
       (to_regclass('public.inventory_ledger_costs') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_ledger_costs') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'inventory_items.qty_on_hand',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'qty_on_hand'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'inventory_costs.cost_unit',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_costs' AND column_name = 'cost_unit'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_costs' AND column_name = 'cost_unit'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'exclude_from_inventory_value',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'monthly_profit_distributions',
       (to_regclass('public.monthly_profit_distributions') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.adjust_stock',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.admin_adjust_stock',
       (to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.create_order',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'rpc.update_order',
       (to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_update_order(text,text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'is_admin()',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'dk_require_backoffice()',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 'stage17.settings_absent_or_rerun',
       (to_regclass('public.inventory_inbound_settings') IS NULL)::text, 'true_or_rerun',
       CASE WHEN to_regclass('public.inventory_inbound_settings') IS NULL THEN 'PASS' ELSE 'INFO_EXISTS' END
UNION ALL SELECT 'stage17.movement_type_absent_or_rerun',
       (NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'movement_type'
       ))::text, 'true_or_rerun',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'movement_type'
       ) THEN 'PASS' ELSE 'INFO_EXISTS' END
ORDER BY 1;

-- PREFLIGHT END
*/


-- ============================================================
-- SECTION M0_SCHEMA
-- Additive columns + settings row。既有 ledger 只標 LEGACY，不假裝成正式入庫。
-- 不 UPDATE inventory_items。不改 Stage 16 表。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.inventory_ledger') IS NULL
     OR to_regclass('public.inventory_ledger_costs') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: inventory_ledger / costs missing';
  END IF;
  IF to_regclass('public.inventory_items') IS NULL
     OR to_regclass('public.inventory_costs') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: inventory_items / costs missing';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: auth helpers missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = 'exclude_from_inventory_value'
  ) THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: Stage 16 exclude_from_inventory_value missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.inventory_inbound_settings (
  id TEXT PRIMARY KEY,
  tracking_start_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_inbound_settings IS
  'Stage 17: inbound KPI tracking starts on tracking_start_date (Taiwan business date at SQL apply).';

INSERT INTO public.inventory_inbound_settings (id, tracking_start_date)
VALUES ('default', (pg_catalog.timezone('Asia/Taipei', pg_catalog.now()))::date)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.inventory_inbound_opening (
  item_id TEXT PRIMARY KEY,
  qty_on_hand NUMERIC NOT NULL DEFAULT 0,
  cost_unit NUMERIC NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inventory_inbound_opening IS
  'Stage 17 go-live opening snapshot for weighted-average restatement. First M0 insert wins.';

INSERT INTO public.inventory_inbound_opening (item_id, qty_on_hand, cost_unit, captured_at)
SELECT it.id,
       COALESCE(it.qty_on_hand, 0),
       COALESCE(ic.cost_unit, 0),
       pg_catalog.now()
FROM public.inventory_items it
LEFT JOIN public.inventory_costs ic ON ic.item_id = it.id
ON CONFLICT (item_id) DO NOTHING;

ALTER TABLE public.inventory_ledger
  ADD COLUMN IF NOT EXISTS movement_type TEXT,
  ADD COLUMN IF NOT EXISTS business_date DATE,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS corrects_ledger_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'confirmed';

COMMENT ON COLUMN public.inventory_ledger.movement_type IS
  'Stage 17 movement class. Pre-go-live rows are LEGACY and excluded from inbound KPI.';
COMMENT ON COLUMN public.inventory_ledger.business_date IS
  'Taiwan calendar date for inbound KPI. Corrections copy the original inbound date.';
COMMENT ON COLUMN public.inventory_ledger.corrects_ledger_id IS
  'INBOUND_CORRECTION must point at the original inbound ledger id. No FK (orphan ledger technical debt).';
COMMENT ON COLUMN public.inventory_ledger.cost_status IS
  'confirmed = official snapshot; pending = Staff inbound awaiting Admin cost. Pending excluded from KPI.';

UPDATE public.inventory_ledger
SET movement_type = 'LEGACY'
WHERE movement_type IS NULL;

DO $$
BEGIN
  ALTER TABLE public.inventory_ledger
    DROP CONSTRAINT IF EXISTS inventory_ledger_movement_type_chk;
  ALTER TABLE public.inventory_ledger
    ADD CONSTRAINT inventory_ledger_movement_type_chk
    CHECK (movement_type IS NULL OR movement_type IN (
      'INITIAL_STOCK',
      'MANUAL_IN',
      'PURCHASE_RECEIPT',
      'INBOUND_CORRECTION',
      'INBOUND_COST_CORRECTION',
      'MANUAL_OUT',
      'SALE',
      'SALE_RETURN',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'LEGACY'
    ));
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_ledger_cost_status_chk'
  ) THEN
    ALTER TABLE public.inventory_ledger
      ADD CONSTRAINT inventory_ledger_cost_status_chk
      CHECK (cost_status IN ('confirmed', 'pending'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_ledger_source_uidx
  ON public.inventory_ledger (source_type, source_id)
  WHERE source_id IS NOT NULL AND btrim(source_id) <> '';

CREATE INDEX IF NOT EXISTS inventory_ledger_business_date_idx
  ON public.inventory_ledger (business_date);

CREATE INDEX IF NOT EXISTS inventory_ledger_movement_type_idx
  ON public.inventory_ledger (movement_type);

CREATE INDEX IF NOT EXISTS inventory_ledger_corrects_idx
  ON public.inventory_ledger (corrects_ledger_id)
  WHERE corrects_ledger_id IS NOT NULL;

-- M0_SCHEMA END
*/


-- ============================================================
-- SECTION M1_SECURITY
-- settings Admin-only SELECT。ledger 寫入改走 SECURITY DEFINER RPC。
-- 不降低既有 SELECT。不改 Stage 16 RLS。
-- ============================================================
/*

ALTER TABLE public.inventory_inbound_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_inbound_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inventory_inbound_settings TO authenticated;

DROP POLICY IF EXISTS inventory_inbound_settings_admin_select ON public.inventory_inbound_settings;
CREATE POLICY inventory_inbound_settings_admin_select
  ON public.inventory_inbound_settings FOR SELECT TO authenticated
  USING (public.is_admin());

ALTER TABLE public.inventory_inbound_opening ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_inbound_opening FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.inventory_inbound_opening TO authenticated;
DROP POLICY IF EXISTS inventory_inbound_opening_admin_select ON public.inventory_inbound_opening;
CREATE POLICY inventory_inbound_opening_admin_select
  ON public.inventory_inbound_opening FOR SELECT TO authenticated
  USING (public.is_admin());

REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_ledger FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_ledger_costs FROM authenticated;
GRANT SELECT ON TABLE public.inventory_ledger TO authenticated;
GRANT SELECT ON TABLE public.inventory_ledger_costs TO authenticated;

-- M1_SECURITY END
*/


-- ============================================================
-- SECTION M2_FUNCTIONS
-- Helpers + 改寫 adjust_stock + 入庫數量／成本更正／補成本／報表 RPC。
-- 數量或成本更正後 server-side restatement replay 重建 qty 與 weighted average。
-- create_order / update_order 不改簽名；INSERT 缺欄由 trigger 補 SALE／SALE_RETURN。
-- 本 SECTION 包在單一交易：DROP 舊 adjust_stock 與 CREATE 新簽名之間
-- 不可被 autocommit 切開，否則舊前端會短暫打不到 RPC。
-- ============================================================
/*

BEGIN;

CREATE OR REPLACE FUNCTION public.dk_taiwan_today()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT (pg_catalog.timezone('Asia/Taipei', pg_catalog.now()))::date;
$$;

REVOKE ALL ON FUNCTION public.dk_taiwan_today() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_require_admin()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_require_admin() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_tracking_start_date()
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_d DATE;
BEGIN
  SELECT s.tracking_start_date INTO v_d
  FROM public.inventory_inbound_settings s
  WHERE s.id = 'default';
  IF v_d IS NULL THEN
    RAISE EXCEPTION 'inbound tracking start date missing';
  END IF;
  RETURN v_d;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_tracking_start_date() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_effective_qty(p_original_id TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_orig NUMERIC;
  v_corr NUMERIC;
BEGIN
  SELECT COALESCE(l.qty, 0) INTO v_orig
  FROM public.inventory_ledger l
  WHERE l.id = p_original_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original ledger not found';
  END IF;
  SELECT COALESCE(SUM(c.qty), 0) INTO v_corr
  FROM public.inventory_ledger c
  WHERE c.corrects_ledger_id = p_original_id
    AND c.movement_type = 'INBOUND_CORRECTION';
  RETURN COALESCE(v_orig, 0) + COALESCE(v_corr, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_effective_qty(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_effective_unit_cost(p_original_id TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_corr NUMERIC;
  v_orig NUMERIC;
BEGIN
  SELECT c.unit_cost INTO v_corr
  FROM public.inventory_ledger x
  INNER JOIN public.inventory_ledger_costs c ON c.ledger_id = x.id
  WHERE x.corrects_ledger_id = p_original_id
    AND x.movement_type = 'INBOUND_COST_CORRECTION'
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT 1;
  IF v_corr IS NOT NULL THEN
    RETURN v_corr;
  END IF;
  SELECT COALESCE(c.unit_cost, 0) INTO v_orig
  FROM public.inventory_ledger_costs c
  WHERE c.ledger_id = p_original_id;
  RETURN COALESCE(v_orig, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_effective_unit_cost(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_lock_item(p_item_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id TEXT;
BEGIN
  SELECT it.id INTO v_id
  FROM public.inventory_items it
  WHERE it.id = p_item_id
  FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'item not found';
  END IF;
  INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
  VALUES (p_item_id, 0, pg_catalog.now())
  ON CONFLICT (item_id) DO NOTHING;
  PERFORM 1 FROM public.inventory_costs WHERE item_id = p_item_id FOR UPDATE;
  PERFORM 1 FROM public.inventory_ledger WHERE item_id = p_item_id FOR UPDATE;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_lock_item(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_replay_item_cost(p_item_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_qty NUMERIC := 0;
  v_cost NUMERIC := 0;
  rec RECORD;
  v_eff_qty NUMERIC;
  v_eff_cost NUMERIC;
  v_new NUMERIC;
  v_snap NUMERIC;
  v_found BOOLEAN;
BEGIN
  PERFORM public.dk_inbound_lock_item(p_item_id);

  SELECT true, o.qty_on_hand, o.cost_unit
    INTO v_found, v_qty, v_cost
  FROM public.inventory_inbound_opening o
  WHERE o.item_id = p_item_id;
  IF NOT COALESCE(v_found, false) THEN
    v_qty := 0;
    v_cost := 0;
  END IF;

  FOR rec IN
    SELECT l.id, l.movement_type, l.qty, l.cost_status
    FROM public.inventory_ledger l
    WHERE l.item_id = p_item_id
      AND COALESCE(l.movement_type, 'LEGACY') NOT IN (
        'LEGACY', 'INBOUND_CORRECTION', 'INBOUND_COST_CORRECTION'
      )
    ORDER BY l.created_at, l.id
  LOOP
    IF rec.movement_type IN ('INITIAL_STOCK', 'MANUAL_IN', 'PURCHASE_RECEIPT') THEN
      IF rec.cost_status IS DISTINCT FROM 'confirmed' THEN
        v_qty := COALESCE(v_qty, 0) + COALESCE(rec.qty, 0);
      ELSE
        v_eff_qty := public.dk_inbound_effective_qty(rec.id);
        v_eff_cost := public.dk_inbound_effective_unit_cost(rec.id);
        v_new := COALESCE(v_qty, 0) + COALESCE(v_eff_qty, 0);
        IF COALESCE(v_eff_qty, 0) > 0 THEN
          IF COALESCE(v_qty, 0) <= 0 THEN
            v_cost := v_eff_cost;
          ELSIF v_new > 0 THEN
            v_cost := (COALESCE(v_qty, 0) * COALESCE(v_cost, 0) + v_eff_qty * v_eff_cost) / v_new;
          END IF;
        END IF;
        v_qty := v_new;
      END IF;
    ELSIF rec.movement_type IN ('SALE', 'MANUAL_OUT', 'ADJUSTMENT_OUT') THEN
      v_qty := COALESCE(v_qty, 0) + COALESCE(rec.qty, 0);
    ELSIF rec.movement_type IN ('SALE_RETURN', 'ADJUSTMENT_IN') THEN
      v_qty := COALESCE(v_qty, 0) + COALESCE(rec.qty, 0);
      IF rec.movement_type = 'ADJUSTMENT_IN' THEN
        SELECT COALESCE(c.unit_cost, 0) INTO v_snap
        FROM public.inventory_ledger_costs c
        WHERE c.ledger_id = rec.id;
        IF COALESCE(v_snap, 0) > 0 THEN
          v_cost := v_snap;
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF COALESCE(v_qty, 0) < 0 THEN
    RAISE EXCEPTION 'INBOUND_CORRECTION_STOCK_CONFLICT';
  END IF;

  UPDATE public.inventory_items
  SET qty_on_hand = COALESCE(v_qty, 0),
      last_moved_at = pg_catalog.now(),
      is_archived = CASE WHEN COALESCE(v_qty, 0) > 0 THEN false ELSE true END,
      archived_at = CASE
        WHEN COALESCE(v_qty, 0) > 0 THEN NULL
        ELSE COALESCE(archived_at, pg_catalog.now())
      END,
      updated_at = pg_catalog.now()
  WHERE id = p_item_id;

  INSERT INTO public.inventory_costs (item_id, cost_unit, updated_at)
  VALUES (p_item_id, COALESCE(v_cost, 0), pg_catalog.now())
  ON CONFLICT (item_id) DO UPDATE SET
    cost_unit = EXCLUDED.cost_unit,
    updated_at = pg_catalog.now();

  RETURN pg_catalog.jsonb_build_object(
    'qty_on_hand', COALESCE(v_qty, 0),
    'cost_unit', COALESCE(v_cost, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_replay_item_cost(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_inbound_write_ledger(
  p_item_id TEXT,
  p_type TEXT,
  p_qty NUMERIC,
  p_ref_type TEXT,
  p_ref_id TEXT,
  p_note TEXT,
  p_unit_cost NUMERIC,
  p_movement_type TEXT,
  p_business_date DATE,
  p_source_type TEXT,
  p_source_id TEXT,
  p_corrects_ledger_id TEXT,
  p_cost_status TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id TEXT;
  v_src_id TEXT;
BEGIN
  v_src_id := NULLIF(btrim(COALESCE(p_source_id, '')), '');
  IF v_src_id IS NOT NULL THEN
    SELECT l.id INTO v_id
    FROM public.inventory_ledger l
    WHERE l.source_type IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(p_source_type, '')), '')
      AND l.source_id = v_src_id
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  v_id := 'L-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  INSERT INTO public.inventory_ledger (
    id, item_id, type, qty, ref_type, ref_id, note, extra, created_at,
    movement_type, business_date, source_type, source_id, corrects_ledger_id,
    created_by, cost_status
  ) VALUES (
    v_id,
    p_item_id,
    p_type,
    p_qty,
    p_ref_type,
    p_ref_id,
    p_note,
    '{}'::jsonb,
    pg_catalog.now(),
    p_movement_type,
    p_business_date,
    NULLIF(btrim(COALESCE(p_source_type, '')), ''),
    v_src_id,
    p_corrects_ledger_id,
    auth.uid(),
    COALESCE(NULLIF(p_cost_status, ''), 'confirmed')
  );

  INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
  VALUES (v_id, COALESCE(p_unit_cost, 0))
  ON CONFLICT (ledger_id) DO NOTHING;

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    IF v_src_id IS NULL THEN
      RAISE;
    END IF;
    SELECT l.id INTO v_id
    FROM public.inventory_ledger l
    WHERE l.source_type IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(p_source_type, '')), '')
      AND l.source_id = v_src_id
    LIMIT 1;
    IF v_id IS NULL THEN
      RAISE;
    END IF;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_inbound_write_ledger(TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.inventory_ledger_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;

  IF NEW.movement_type IS NULL THEN
    IF COALESCE(NEW.ref_type, '') = 'ORDER' AND NEW.type = 'OUT' THEN
      NEW.movement_type := 'SALE';
    ELSIF COALESCE(NEW.ref_type, '') = 'ORDER' AND NEW.type = 'IN' THEN
      NEW.movement_type := 'SALE_RETURN';
    ELSIF NEW.type = 'IN' THEN
      NEW.movement_type := 'MANUAL_IN';
    ELSIF NEW.type = 'OUT' THEN
      NEW.movement_type := 'MANUAL_OUT';
    ELSIF NEW.type = 'ADJUST' AND COALESCE(NEW.qty, 0) >= 0 THEN
      NEW.movement_type := 'ADJUSTMENT_IN';
    ELSIF NEW.type = 'ADJUST' THEN
      NEW.movement_type := 'ADJUSTMENT_OUT';
    ELSE
      NEW.movement_type := 'LEGACY';
    END IF;
  END IF;

  IF NEW.movement_type IS DISTINCT FROM 'LEGACY' AND NEW.business_date IS NULL THEN
    NEW.business_date := public.dk_taiwan_today();
  END IF;

  IF NEW.cost_status IS NULL THEN
    IF NEW.movement_type IN ('MANUAL_IN', 'INITIAL_STOCK', 'PURCHASE_RECEIPT')
       AND NOT public.is_admin() THEN
      NEW.cost_status := 'pending';
    ELSE
      NEW.cost_status := 'confirmed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_ledger_before_insert ON public.inventory_ledger;
CREATE TRIGGER trg_inventory_ledger_before_insert
  BEFORE INSERT ON public.inventory_ledger
  FOR EACH ROW
  EXECUTE PROCEDURE public.inventory_ledger_before_insert();

CREATE OR REPLACE FUNCTION public.inventory_ledger_protect_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_ledger is append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.qty IS DISTINCT FROM OLD.qty
     OR NEW.ref_type IS DISTINCT FROM OLD.ref_type
     OR NEW.ref_id IS DISTINCT FROM OLD.ref_id
     OR NEW.movement_type IS DISTINCT FROM OLD.movement_type
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.corrects_ledger_id IS DISTINCT FROM OLD.corrects_ledger_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'inventory_ledger is append-only';
  END IF;
  IF NEW.cost_status IS DISTINCT FROM OLD.cost_status THEN
    IF NOT (OLD.cost_status = 'pending' AND NEW.cost_status = 'confirmed') THEN
      RAISE EXCEPTION 'invalid cost_status transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_ledger_append_only ON public.inventory_ledger;
CREATE TRIGGER trg_inventory_ledger_append_only
  BEFORE UPDATE OR DELETE ON public.inventory_ledger
  FOR EACH ROW
  EXECUTE PROCEDURE public.inventory_ledger_protect_append_only();

CREATE OR REPLACE FUNCTION public.inventory_ledger_costs_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_ledger_costs is append-only';
  END IF;
  IF NEW.ledger_id IS DISTINCT FROM OLD.ledger_id THEN
    RAISE EXCEPTION 'inventory_ledger_costs is append-only';
  END IF;
  IF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    SELECT l.cost_status INTO v_status
    FROM public.inventory_ledger l
    WHERE l.id = OLD.ledger_id;
    IF v_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'confirmed cost snapshot cannot be updated';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_ledger_costs_protect ON public.inventory_ledger_costs;
CREATE TRIGGER trg_inventory_ledger_costs_protect
  BEFORE UPDATE OR DELETE ON public.inventory_ledger_costs
  FOR EACH ROW
  EXECUTE PROCEDURE public.inventory_ledger_costs_protect();

-- 只留新 signature（後 3 個參數 DEFAULT NULL）。舊前端 named-param 呼叫仍可命中。
-- 若保留舊 5-arg overload，PostgREST 會對舊 payload 報 ambiguous。
DROP FUNCTION IF EXISTS public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE);

CREATE OR REPLACE FUNCTION public.backoffice_adjust_stock(
  p_item_id TEXT,
  p_qty_delta NUMERIC,
  p_operation_type TEXT,
  p_note TEXT DEFAULT NULL,
  p_inbound_date DATE DEFAULT NULL,
  p_movement_type TEXT DEFAULT NULL,
  p_source_type TEXT DEFAULT NULL,
  p_source_id TEXT DEFAULT NULL
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
  ledger_id TEXT;
  abs_qty NUMERIC;
  ledger_qty NUMERIC;
  v_move TEXT;
  v_biz DATE;
  v_cost_status TEXT;
  v_existing TEXT;
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

  v_existing := NULLIF(btrim(COALESCE(p_source_id, '')), '');
  IF v_existing IS NOT NULL THEN
    SELECT l.id INTO ledger_id
    FROM public.inventory_ledger l
    WHERE l.source_type IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(p_source_type, '')), '')
      AND l.source_id = v_existing
    LIMIT 1;
    IF ledger_id IS NOT NULL THEN
      new_qty := COALESCE((public.dk_inbound_replay_item_cost(p_item_id)->>'qty_on_hand')::numeric, 0);
      RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'item_id', p_item_id,
        'qty_on_hand', COALESCE(new_qty, 0),
        'ledger_id', ledger_id,
        'idempotent', true
      );
    END IF;
  END IF;

  PERFORM public.dk_inbound_lock_item(p_item_id);
  SELECT qty_on_hand INTO cur_qty
  FROM public.inventory_items
  WHERE id = p_item_id;

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

  IF p_operation_type = 'ADJUST' AND ledger_qty = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'item_id', p_item_id,
      'qty_on_hand', new_qty,
      'ledger_id', NULL
    );
  END IF;

  v_move := NULLIF(btrim(COALESCE(p_movement_type, '')), '');
  IF v_move IS NULL THEN
    IF p_operation_type = 'IN' THEN
      v_move := 'MANUAL_IN';
    ELSIF p_operation_type = 'OUT' THEN
      v_move := 'MANUAL_OUT';
    ELSIF ledger_qty >= 0 THEN
      v_move := 'ADJUSTMENT_IN';
    ELSE
      v_move := 'ADJUSTMENT_OUT';
    END IF;
  END IF;
  IF v_move IN ('INBOUND_CORRECTION', 'INBOUND_COST_CORRECTION', 'SALE', 'SALE_RETURN', 'PURCHASE_RECEIPT') THEN
    RAISE EXCEPTION 'invalid movement_type for adjust_stock';
  END IF;
  IF p_operation_type = 'IN' AND v_move NOT IN ('MANUAL_IN', 'INITIAL_STOCK') THEN
    RAISE EXCEPTION 'invalid movement_type for IN';
  END IF;
  IF p_operation_type = 'OUT' AND v_move IS DISTINCT FROM 'MANUAL_OUT' THEN
    RAISE EXCEPTION 'invalid movement_type for OUT';
  END IF;
  IF p_operation_type = 'ADJUST' AND v_move NOT IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') THEN
    RAISE EXCEPTION 'invalid movement_type for ADJUST';
  END IF;

  v_biz := COALESCE(p_inbound_date, public.dk_taiwan_today());
  IF v_biz > public.dk_taiwan_today() THEN
    RAISE EXCEPTION 'business_date cannot be in the future';
  END IF;
  IF p_operation_type <> 'IN' THEN
    v_biz := public.dk_taiwan_today();
  END IF;

  IF v_move IN ('MANUAL_IN', 'INITIAL_STOCK') THEN
    v_cost_status := 'pending';
  ELSE
    v_cost_status := 'confirmed';
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
  VALUES (p_item_id, 0, pg_catalog.now())
  ON CONFLICT (item_id) DO NOTHING;

  ledger_id := public.dk_inbound_write_ledger(
    p_item_id,
    p_operation_type,
    ledger_qty,
    CASE WHEN p_operation_type = 'IN' THEN 'PURCHASE'
         WHEN p_operation_type = 'OUT' THEN 'ORDER'
         ELSE 'ADJUST' END,
    NULL,
    p_note,
    0,
    v_move,
    v_biz,
    p_source_type,
    p_source_id,
    NULL,
    v_cost_status
  );

  new_qty := COALESCE((public.dk_inbound_replay_item_cost(p_item_id)->>'qty_on_hand')::numeric, new_qty);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_on_hand', new_qty,
    'ledger_id', ledger_id,
    'idempotent', false,
    'cost_status', v_cost_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_adjust_stock(TEXT, NUMERIC, TEXT, TEXT, DATE, TEXT, TEXT, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_admin_adjust_stock(
  p_item_id TEXT,
  p_qty_delta NUMERIC,
  p_operation_type TEXT,
  p_unit_cost NUMERIC DEFAULT NULL,
  p_note TEXT DEFAULT NULL,
  p_inbound_date DATE DEFAULT NULL,
  p_movement_type TEXT DEFAULT NULL,
  p_source_type TEXT DEFAULT NULL,
  p_source_id TEXT DEFAULT NULL
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
  v_move TEXT;
  v_biz DATE;
  v_existing TEXT;
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

  v_existing := NULLIF(btrim(COALESCE(p_source_id, '')), '');
  IF v_existing IS NOT NULL THEN
    SELECT l.id INTO ledger_id
    FROM public.inventory_ledger l
    WHERE l.source_type IS NOT DISTINCT FROM NULLIF(btrim(COALESCE(p_source_type, '')), '')
      AND l.source_id = v_existing
    LIMIT 1;
    IF ledger_id IS NOT NULL THEN
      new_qty := COALESCE((public.dk_inbound_replay_item_cost(p_item_id)->>'qty_on_hand')::numeric, 0);
      RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'item_id', p_item_id,
        'qty_on_hand', COALESCE(new_qty, 0),
        'ledger_id', ledger_id,
        'idempotent', true
      );
    END IF;
  END IF;

  PERFORM public.dk_inbound_lock_item(p_item_id);
  SELECT qty_on_hand INTO cur_qty
  FROM public.inventory_items
  WHERE id = p_item_id;

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

  IF p_operation_type = 'ADJUST' AND ledger_qty = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'item_id', p_item_id,
      'qty_on_hand', new_qty,
      'ledger_id', NULL
    );
  END IF;

  v_move := NULLIF(btrim(COALESCE(p_movement_type, '')), '');
  IF v_move IS NULL THEN
    IF p_operation_type = 'IN' THEN
      v_move := 'MANUAL_IN';
    ELSIF p_operation_type = 'OUT' THEN
      v_move := 'MANUAL_OUT';
    ELSIF ledger_qty >= 0 THEN
      v_move := 'ADJUSTMENT_IN';
    ELSE
      v_move := 'ADJUSTMENT_OUT';
    END IF;
  END IF;
  IF v_move IN ('INBOUND_CORRECTION', 'INBOUND_COST_CORRECTION', 'SALE', 'SALE_RETURN', 'PURCHASE_RECEIPT') THEN
    RAISE EXCEPTION 'invalid movement_type for adjust_stock';
  END IF;
  IF p_operation_type = 'IN' AND v_move NOT IN ('MANUAL_IN', 'INITIAL_STOCK') THEN
    RAISE EXCEPTION 'invalid movement_type for IN';
  END IF;
  IF p_operation_type = 'OUT' AND v_move IS DISTINCT FROM 'MANUAL_OUT' THEN
    RAISE EXCEPTION 'invalid movement_type for OUT';
  END IF;
  IF p_operation_type = 'ADJUST' AND v_move NOT IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT') THEN
    RAISE EXCEPTION 'invalid movement_type for ADJUST';
  END IF;

  v_biz := COALESCE(p_inbound_date, public.dk_taiwan_today());
  IF v_biz > public.dk_taiwan_today() THEN
    RAISE EXCEPTION 'business_date cannot be in the future';
  END IF;
  IF p_operation_type <> 'IN' THEN
    v_biz := public.dk_taiwan_today();
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

  ledger_id := public.dk_inbound_write_ledger(
    p_item_id,
    p_operation_type,
    ledger_qty,
    CASE WHEN p_operation_type = 'IN' THEN 'PURCHASE'
         WHEN p_operation_type = 'OUT' THEN 'ORDER'
         ELSE 'ADJUST' END,
    NULL,
    p_note,
    COALESCE(in_cost, 0),
    v_move,
    v_biz,
    p_source_type,
    p_source_id,
    NULL,
    'confirmed'
  );

  new_qty := COALESCE((public.dk_inbound_replay_item_cost(p_item_id)->>'qty_on_hand')::numeric, new_qty);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'qty_on_hand', new_qty,
    'ledger_id', ledger_id,
    'idempotent', false,
    'cost_status', 'confirmed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_admin_adjust_stock(TEXT, NUMERIC, TEXT, NUMERIC, TEXT, DATE, TEXT, TEXT, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_correct_inventory_inbound(
  p_original_ledger_id TEXT,
  p_qty_delta NUMERIC,
  p_reason TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_orig public.inventory_ledger%ROWTYPE;
  v_unit NUMERIC;
  v_eff NUMERIC;
  v_new_eff NUMERIC;
  cur_qty NUMERIC;
  new_qty NUMERIC;
  v_delta NUMERIC;
  v_ledger_id TEXT;
  v_key TEXT;
  v_existing TEXT;
  v_item_id TEXT;
  v_replay JSONB;
BEGIN
  PERFORM public.dk_inbound_require_admin();
  v_delta := COALESCE(p_qty_delta, 0);
  IF v_delta = 0 THEN
    RAISE EXCEPTION 'qty_delta must not be 0';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key required';
  END IF;

  SELECT l.item_id INTO v_item_id
  FROM public.inventory_ledger l
  WHERE l.id = p_original_ledger_id;
  IF v_item_id IS NULL OR v_item_id = '' THEN
    RAISE EXCEPTION 'original ledger not found';
  END IF;

  PERFORM public.dk_inbound_lock_item(v_item_id);

  SELECT * INTO v_orig
  FROM public.inventory_ledger
  WHERE id = p_original_ledger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original ledger not found';
  END IF;
  IF v_orig.movement_type NOT IN ('INITIAL_STOCK', 'MANUAL_IN', 'PURCHASE_RECEIPT') THEN
    RAISE EXCEPTION 'original is not a formal inbound';
  END IF;
  IF v_orig.cost_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'original cost is pending';
  END IF;
  IF v_orig.business_date IS NULL THEN
    RAISE EXCEPTION 'original business_date missing';
  END IF;

  SELECT l.id INTO v_existing
  FROM public.inventory_ledger l
  WHERE l.source_type = 'inbound_correction'
    AND l.source_id = v_key
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    v_replay := public.dk_inbound_replay_item_cost(v_orig.item_id);
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'ledger_id', v_existing,
      'item_id', v_orig.item_id,
      'qty_on_hand', COALESCE((v_replay->>'qty_on_hand')::numeric, 0),
      'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
      'idempotent', true
    );
  END IF;

  SELECT COALESCE(c.unit_cost, 0) INTO v_unit
  FROM public.inventory_ledger_costs c
  WHERE c.ledger_id = v_orig.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original cost snapshot missing';
  END IF;

  v_eff := public.dk_inbound_effective_qty(v_orig.id);
  v_new_eff := v_eff + v_delta;
  IF v_new_eff < 0 THEN
    RAISE EXCEPTION 'effective inbound qty cannot be negative';
  END IF;

  SELECT it.qty_on_hand INTO cur_qty
  FROM public.inventory_items it
  WHERE it.id = v_orig.item_id;
  IF COALESCE(cur_qty, 0) + v_delta < 0 THEN
    RAISE EXCEPTION 'INBOUND_CORRECTION_STOCK_CONFLICT';
  END IF;

  v_ledger_id := public.dk_inbound_write_ledger(
    v_orig.item_id,
    CASE WHEN v_delta > 0 THEN 'IN' ELSE 'OUT' END,
    v_delta,
    'ADJUST',
    v_orig.id,
    p_reason,
    v_unit,
    'INBOUND_CORRECTION',
    v_orig.business_date,
    'inbound_correction',
    v_key,
    v_orig.id,
    'confirmed'
  );

  v_replay := public.dk_inbound_replay_item_cost(v_orig.item_id);
  new_qty := COALESCE((v_replay->>'qty_on_hand')::numeric, 0);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'ledger_id', v_ledger_id,
    'item_id', v_orig.item_id,
    'qty_on_hand', new_qty,
    'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
    'effective_inbound_qty', v_new_eff,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_correct_inventory_inbound(TEXT, NUMERIC, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_correct_inventory_inbound(TEXT, NUMERIC, TEXT, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_confirm_inbound_cost(
  p_ledger_id TEXT,
  p_unit_cost NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.inventory_ledger%ROWTYPE;
  v_cost NUMERIC;
  v_item_id TEXT;
  v_replay JSONB;
BEGIN
  PERFORM public.dk_inbound_require_admin();
  v_cost := COALESCE(p_unit_cost, 0);
  IF v_cost < 0 THEN
    RAISE EXCEPTION 'unit_cost must be >= 0';
  END IF;

  SELECT l.item_id INTO v_item_id
  FROM public.inventory_ledger l
  WHERE l.id = p_ledger_id;
  IF v_item_id IS NULL OR v_item_id = '' THEN
    RAISE EXCEPTION 'ledger not found';
  END IF;

  PERFORM public.dk_inbound_lock_item(v_item_id);

  SELECT * INTO v_row
  FROM public.inventory_ledger
  WHERE id = p_ledger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger not found';
  END IF;
  IF v_row.movement_type NOT IN ('INITIAL_STOCK', 'MANUAL_IN', 'PURCHASE_RECEIPT') THEN
    RAISE EXCEPTION 'not a formal inbound';
  END IF;
  IF v_row.cost_status IS DISTINCT FROM 'pending' THEN
    IF v_row.cost_status = 'confirmed' THEN
      v_replay := public.dk_inbound_replay_item_cost(v_row.item_id);
      RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'ledger_id', v_row.id,
        'qty_on_hand', COALESCE((v_replay->>'qty_on_hand')::numeric, 0),
        'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
        'idempotent', true
      );
    END IF;
    RAISE EXCEPTION 'invalid cost_status';
  END IF;

  INSERT INTO public.inventory_ledger_costs (ledger_id, unit_cost)
  VALUES (v_row.id, v_cost)
  ON CONFLICT (ledger_id) DO UPDATE SET unit_cost = EXCLUDED.unit_cost;

  UPDATE public.inventory_ledger
  SET cost_status = 'confirmed'
  WHERE id = v_row.id;

  v_replay := public.dk_inbound_replay_item_cost(v_row.item_id);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'ledger_id', v_row.id,
    'unit_cost', v_cost,
    'qty_on_hand', COALESCE((v_replay->>'qty_on_hand')::numeric, 0),
    'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_confirm_inbound_cost(TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_confirm_inbound_cost(TEXT, NUMERIC)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_correct_inbound_cost(
  p_original_ledger_id TEXT,
  p_unit_cost NUMERIC,
  p_reason TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_orig public.inventory_ledger%ROWTYPE;
  v_cost NUMERIC;
  v_orig_cost NUMERIC;
  v_eff_cost NUMERIC;
  v_item_id TEXT;
  v_key TEXT;
  v_existing TEXT;
  v_ledger_id TEXT;
  v_replay JSONB;
BEGIN
  PERFORM public.dk_inbound_require_admin();
  v_cost := COALESCE(p_unit_cost, 0);
  IF v_cost < 0 THEN
    RAISE EXCEPTION 'unit_cost must be >= 0';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key required';
  END IF;

  SELECT l.item_id INTO v_item_id
  FROM public.inventory_ledger l
  WHERE l.id = p_original_ledger_id;
  IF v_item_id IS NULL OR v_item_id = '' THEN
    RAISE EXCEPTION 'original ledger not found';
  END IF;

  PERFORM public.dk_inbound_lock_item(v_item_id);

  SELECT * INTO v_orig
  FROM public.inventory_ledger
  WHERE id = p_original_ledger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original ledger not found';
  END IF;
  IF v_orig.movement_type NOT IN ('INITIAL_STOCK', 'MANUAL_IN', 'PURCHASE_RECEIPT') THEN
    RAISE EXCEPTION 'original is not a formal inbound';
  END IF;
  IF v_orig.cost_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'original cost is pending';
  END IF;
  IF v_orig.business_date IS NULL THEN
    RAISE EXCEPTION 'original business_date missing';
  END IF;

  SELECT l.id INTO v_existing
  FROM public.inventory_ledger l
  WHERE l.source_type = 'inbound_cost_correction'
    AND l.source_id = v_key
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    v_replay := public.dk_inbound_replay_item_cost(v_orig.item_id);
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'ledger_id', v_existing,
      'item_id', v_orig.item_id,
      'qty_on_hand', COALESCE((v_replay->>'qty_on_hand')::numeric, 0),
      'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
      'idempotent', true
    );
  END IF;

  SELECT COALESCE(c.unit_cost, 0) INTO v_orig_cost
  FROM public.inventory_ledger_costs c
  WHERE c.ledger_id = v_orig.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original cost snapshot missing';
  END IF;
  v_eff_cost := public.dk_inbound_effective_unit_cost(v_orig.id);

  v_ledger_id := public.dk_inbound_write_ledger(
    v_orig.item_id,
    'ADJUST',
    0,
    'ADJUST',
    v_orig.id,
    p_reason,
    v_cost,
    'INBOUND_COST_CORRECTION',
    v_orig.business_date,
    'inbound_cost_correction',
    v_key,
    v_orig.id,
    'confirmed'
  );

  v_replay := public.dk_inbound_replay_item_cost(v_orig.item_id);

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'ledger_id', v_ledger_id,
    'item_id', v_orig.item_id,
    'qty_on_hand', COALESCE((v_replay->>'qty_on_hand')::numeric, 0),
    'cost_unit', COALESCE((v_replay->>'cost_unit')::numeric, 0),
    'original_unit_cost', v_orig_cost,
    'previous_effective_unit_cost', v_eff_cost,
    'corrected_unit_cost', v_cost,
    'unit_cost_difference', v_cost - v_eff_cost,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_correct_inbound_cost(TEXT, NUMERIC, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_correct_inbound_cost(TEXT, NUMERIC, TEXT, TEXT)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_inventory_inbound_amount(
  p_from DATE,
  p_to DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start DATE;
  v_from DATE;
  v_to DATE;
  v_amount NUMERIC;
  v_coverage TEXT;
  v_meta TEXT;
BEGIN
  PERFORM public.dk_inbound_require_admin();
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'date range required';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;

  v_start := public.dk_inbound_tracking_start_date();
  v_to := p_to;

  IF p_to < v_start THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'amount', NULL,
      'from', p_from,
      'to', p_to,
      'effective_from', NULL,
      'tracking_start_date', v_start,
      'coverage', 'none',
      'meta', '完整入庫追蹤自 ' || v_start::text || ' 起'
    );
  END IF;

  IF p_from < v_start THEN
    v_from := v_start;
    v_coverage := 'partial';
    v_meta := '僅統計 ' || v_start::text || ' 起';
  ELSE
    v_from := p_from;
    v_coverage := 'full';
    v_meta := '依查詢期間實際入庫成本';
  END IF;

  -- restatement: original + INBOUND_CORRECTION qty, latest INBOUND_COST_CORRECTION cost;
  -- general ADJUSTMENT excluded from inbound KPI
  SELECT COALESCE(ROUND(SUM(
           public.dk_inbound_effective_qty(l.id)
           * public.dk_inbound_effective_unit_cost(l.id)
         ), 0), 0)
  INTO v_amount
  FROM public.inventory_ledger l
  LEFT JOIN public.inventory_items it ON it.id = l.item_id
  WHERE l.movement_type IN ('INITIAL_STOCK', 'MANUAL_IN', 'PURCHASE_RECEIPT')
    AND l.cost_status = 'confirmed'
    AND l.business_date >= v_from
    AND l.business_date <= v_to
    AND COALESCE(it.exclude_from_inventory_value, false) = false;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'amount', v_amount,
    'from', p_from,
    'to', p_to,
    'effective_from', v_from,
    'tracking_start_date', v_start,
    'coverage', v_coverage,
    'meta', v_meta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_inventory_inbound_amount(DATE, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_inventory_inbound_amount(DATE, DATE)
  TO authenticated;

COMMIT;

-- M2_FUNCTIONS END
*/


-- ============================================================
-- SECTION M3_VERIFY
-- 只讀驗證。
-- ============================================================
/*

SELECT 10 AS seq, 'col.movement_type'::text AS check_name,
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'movement_type'
       ))::text AS actual, 'true'::text AS expected,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'movement_type'
       ) THEN 'PASS' ELSE 'FAIL' END AS status
UNION ALL SELECT 11, 'col.business_date',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger'
           AND column_name = 'business_date' AND data_type = 'date'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger'
           AND column_name = 'business_date' AND data_type = 'date'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'col.source_type',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'source_type'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'source_type'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'col.source_id',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'source_id'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'source_id'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'col.corrects_ledger_id',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'corrects_ledger_id'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'corrects_ledger_id'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'col.created_by',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'created_by'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'created_by'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'col.cost_status',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'cost_status'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_ledger' AND column_name = 'cost_status'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'table.settings',
       (to_regclass('public.inventory_inbound_settings') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_inbound_settings') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'unique.source',
       (EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'inventory_ledger_source_uidx'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'inventory_ledger_source_uidx'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'legacy_not_given_business_date',
       (NOT EXISTS (
         SELECT 1 FROM public.inventory_ledger
         WHERE movement_type = 'LEGACY' AND business_date IS NOT NULL
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.inventory_ledger
         WHERE movement_type = 'LEGACY' AND business_date IS NOT NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'formal_inbound_has_business_date',
       (NOT EXISTS (
         SELECT 1 FROM public.inventory_ledger
         WHERE movement_type IN ('INITIAL_STOCK','MANUAL_IN','PURCHASE_RECEIPT','INBOUND_CORRECTION','INBOUND_COST_CORRECTION')
           AND business_date IS NULL
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.inventory_ledger
         WHERE movement_type IN ('INITIAL_STOCK','MANUAL_IN','PURCHASE_RECEIPT','INBOUND_CORRECTION','INBOUND_COST_CORRECTION')
           AND business_date IS NULL
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 201, 'table.opening',
       (to_regclass('public.inventory_inbound_opening') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_inbound_opening') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'rpc.correct',
       (to_regprocedure('public.backoffice_correct_inventory_inbound(text,numeric,text,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_correct_inventory_inbound(text,numeric,text,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'rpc.inbound_amount',
       (to_regprocedure('public.backoffice_inventory_inbound_amount(date,date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_inventory_inbound_amount(date,date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'rpc.confirm_cost',
       (to_regprocedure('public.backoffice_confirm_inbound_cost(text,numeric)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_confirm_inbound_cost(text,numeric)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'rpc.adjust_stock_new_sig',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date,text,text,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date,text,text,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'rpc.old_adjust_dropped',
       (to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 251, 'rpc.old_admin_adjust_dropped',
       (to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_admin_adjust_stock(text,numeric,text,numeric,text,date)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 252, 'rpc.adjust_stock_has_defaults',
       (COALESCE((
         SELECT p.pronargdefaults >= 3
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.oid = to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date,text,text,text)')
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.pronargdefaults >= 3
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.oid = to_regprocedure('public.backoffice_adjust_stock(text,numeric,text,text,date,text,text,text)')
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'rpc.correct_cost',
       (to_regprocedure('public.backoffice_correct_inbound_cost(text,numeric,text,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_correct_inbound_cost(text,numeric,text,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'rpc.replay_helper',
       (to_regprocedure('public.dk_inbound_replay_item_cost(text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_inbound_replay_item_cost(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'chk.cost_correction_type',
       (EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'inventory_ledger_movement_type_chk'
           AND pg_get_constraintdef(oid) ILIKE '%INBOUND_COST_CORRECTION%'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'inventory_ledger_movement_type_chk'
           AND pg_get_constraintdef(oid) ILIKE '%INBOUND_COST_CORRECTION%'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'fn.correct_security_definer',
       (COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT p.prosecdef FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'fn.amount_search_path',
       (COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT (p.proconfig::text ILIKE '%search_path%')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'fn.correct_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_inbound_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_inbound_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'fn.amount_admin_guard',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_inbound_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%dk_inbound_require_admin%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'fn.staff_pending',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%pending%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_adjust_stock'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%pending%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_adjust_stock'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'fn.correction_uses_original_cost',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%inventory_ledger_costs%'
            AND pg_get_functiondef(p.oid) ILIKE '%effective inbound qty cannot be negative%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_orig.business_date%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%inventory_ledger_costs%'
            AND pg_get_functiondef(p.oid) ILIKE '%effective inbound qty cannot be negative%'
            AND pg_get_functiondef(p.oid) ILIKE '%v_orig.business_date%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'fn.kpi_types',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%INITIAL_STOCK%'
            AND pg_get_functiondef(p.oid) ILIKE '%INBOUND_CORRECTION%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_effective_qty%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%SALE_RETURN%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%INITIAL_STOCK%'
            AND pg_get_functiondef(p.oid) ILIKE '%INBOUND_CORRECTION%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_effective_qty%'
            AND pg_get_functiondef(p.oid) NOT ILIKE '%SALE_RETURN%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_inventory_inbound_amount'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 361, 'fn.correction_stock_conflict',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%INBOUND_CORRECTION_STOCK_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_lock_item%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_replay_item_cost%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%INBOUND_CORRECTION_STOCK_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_lock_item%'
            AND pg_get_functiondef(p.oid) ILIKE '%dk_inbound_replay_item_cost%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_correct_inventory_inbound'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'exec.helper_today_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_taiwan_today()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_taiwan_today()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'exec.helper_effective_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_effective_qty(text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_effective_qty(text)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'exec.helper_write_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_write_ledger(text,text,numeric,text,text,text,numeric,text,date,text,text,text,text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_write_ledger(text,text,numeric,text,text,text,numeric,text,date,text,text,text,text)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'exec.amount_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_inventory_inbound_amount(date,date)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_inventory_inbound_amount(date,date)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'exec.correct_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_correct_inventory_inbound(text,numeric,text,text)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_correct_inventory_inbound(text,numeric,text,text)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'exec.amount_anon_denied',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_inventory_inbound_amount(date,date)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_inventory_inbound_amount(date,date)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'exec.helper_admin_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_require_admin()', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_require_admin()', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'exec.helper_replay_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_replay_item_cost(text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_replay_item_cost(text)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'exec.helper_lock_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_lock_item(text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_lock_item(text)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'exec.helper_eff_cost_authenticated_denied',
       (NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_effective_unit_cost(text)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('authenticated', 'public.dk_inbound_effective_unit_cost(text)', 'EXECUTE'), true)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'exec.correct_cost_authenticated_allowed',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_correct_inbound_cost(text,numeric,text,text)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_correct_inbound_cost(text,numeric,text,text)', 'EXECUTE'), false)
         THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'stage16.exclude_untouched',
       (EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ))::text, 'true',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'inventory_items'
           AND column_name = 'exclude_from_inventory_value'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'stage16.distributions_untouched',
       (to_regclass('public.monthly_profit_distributions') IS NOT NULL)::text, 'true',
       CASE WHEN to_regclass('public.monthly_profit_distributions') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'stage16.settle_untouched',
       (to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_settle_monthly_profit(date)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'no_parallel_movements_table',
       (to_regclass('public.inventory_movements') IS NULL
        AND to_regclass('public.stock_movements') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.inventory_movements') IS NULL
             AND to_regclass('public.stock_movements') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'create_order_untouched_sig',
       (to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_create_order(text,text,text,numeric,numeric,text,text,jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

-- M3_VERIFY END
*/
