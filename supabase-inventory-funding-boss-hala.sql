-- DK 電競電腦：庫存出資來源（BOSS / HALA）
-- 執行前提：已完成 Stage 17 入庫追蹤。
-- 規則：執行本檔當下的現有庫存歸 BOSS；之後由後台入庫時指定，預設 HALA。
-- 出庫依 BOSS 優先、再依入庫日期 FIFO 扣除。BOSS 返還只算本金，不列為營業支出。

BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_funding_lots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES public.inventory_items(id),
  source_ledger_id TEXT UNIQUE REFERENCES public.inventory_ledger(id),
  source_key TEXT UNIQUE NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('boss', 'hala')),
  qty_received NUMERIC NOT NULL CHECK (qty_received >= 0),
  qty_remaining NUMERIC NOT NULL CHECK (qty_remaining >= 0),
  unit_cost NUMERIC NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  business_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  created_by UUID DEFAULT auth.uid()
);

CREATE INDEX IF NOT EXISTS inventory_funding_lots_fifo_idx
  ON public.inventory_funding_lots(item_id, owner, business_date, created_at, id)
  WHERE qty_remaining > 0;

CREATE TABLE IF NOT EXISTS public.inventory_funding_allocations (
  id TEXT PRIMARY KEY,
  outbound_ledger_id TEXT NOT NULL REFERENCES public.inventory_ledger(id),
  lot_id TEXT NOT NULL REFERENCES public.inventory_funding_lots(id),
  owner TEXT NOT NULL CHECK (owner IN ('boss', 'hala')),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  reversed_qty NUMERIC NOT NULL DEFAULT 0 CHECK (reversed_qty >= 0 AND reversed_qty <= qty),
  unit_cost NUMERIC NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  principal_amount NUMERIC GENERATED ALWAYS AS (qty * unit_cost) STORED,
  repayment_eligible BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE(outbound_ledger_id, lot_id)
);

CREATE INDEX IF NOT EXISTS inventory_funding_allocations_ledger_idx
  ON public.inventory_funding_allocations(outbound_ledger_id);

CREATE TABLE IF NOT EXISTS public.inventory_funding_repayments (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT 'boss' CHECK (owner = 'boss'),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  paid_at DATE NOT NULL,
  note TEXT,
  created_by UUID DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.inventory_funding_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_funding_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_funding_repayments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_funding_lots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_funding_allocations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_funding_repayments FROM PUBLIC, anon, authenticated;

-- 第一次執行時，將當下仍在庫的數量建立為 BOSS 期初批次。重跑不會重複。
INSERT INTO public.inventory_funding_lots (
  id, item_id, source_ledger_id, source_key, owner,
  qty_received, qty_remaining, unit_cost, business_date
)
SELECT
  'FL-OPEN-' || i.id,
  i.id,
  NULL,
  'opening:' || i.id,
  'boss',
  COALESCE(i.qty_on_hand, 0),
  COALESCE(i.qty_on_hand, 0),
  COALESCE(c.cost_unit, 0),
  COALESCE(i.inbound_date, public.dk_taiwan_today())
FROM public.inventory_items i
LEFT JOIN public.inventory_costs c ON c.item_id = i.id
WHERE COALESCE(i.qty_on_hand, 0) > 0
ON CONFLICT (source_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.backoffice_assign_inbound_funding(
  p_ledger_id TEXT,
  p_owner TEXT DEFAULT 'hala'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_ledger public.inventory_ledger%ROWTYPE;
  v_cost NUMERIC := 0;
  v_owner TEXT;
  v_id TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  v_owner := lower(btrim(COALESCE(p_owner, 'hala')));
  IF v_role IS DISTINCT FROM 'admin' AND v_owner IS DISTINCT FROM 'hala' THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  IF v_owner NOT IN ('boss', 'hala') THEN RAISE EXCEPTION 'invalid funding owner'; END IF;

  SELECT * INTO v_ledger FROM public.inventory_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger not found'; END IF;
  IF v_ledger.movement_type NOT IN ('MANUAL_IN', 'PURCHASE_RECEIPT', 'INITIAL_STOCK') OR v_ledger.qty <= 0 THEN
    RAISE EXCEPTION 'ledger is not an inbound record';
  END IF;
  SELECT COALESCE(unit_cost, 0) INTO v_cost
  FROM public.inventory_ledger_costs WHERE ledger_id = v_ledger.id;

  v_id := 'FL-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  INSERT INTO public.inventory_funding_lots (
    id, item_id, source_ledger_id, source_key, owner,
    qty_received, qty_remaining, unit_cost, business_date
  ) VALUES (
    v_id, v_ledger.item_id, v_ledger.id, 'ledger:' || v_ledger.id, v_owner,
    v_ledger.qty, v_ledger.qty, COALESCE(v_cost, 0),
    COALESCE(v_ledger.business_date, public.dk_taiwan_today())
  )
  ON CONFLICT (source_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.inventory_funding_lots
    WHERE source_key = 'ledger:' || v_ledger.id;
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'lot_id', v_id, 'owner', v_owner);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_assign_inbound_funding(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_assign_inbound_funding(TEXT, TEXT) TO authenticated;

-- 員工先入庫、管理員稍後確認成本時，同步更新該出資批次成本。
CREATE OR REPLACE FUNCTION public.dk_sync_funding_lot_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_funding_lots
  SET unit_cost = COALESCE(NEW.unit_cost, 0)
  WHERE source_ledger_id = NEW.ledger_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_sync_funding_lot_cost() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_inventory_funding_lot_cost ON public.inventory_ledger_costs;
CREATE TRIGGER trg_inventory_funding_lot_cost
  AFTER INSERT OR UPDATE OF unit_cost ON public.inventory_ledger_costs
  FOR EACH ROW EXECUTE PROCEDURE public.dk_sync_funding_lot_cost();

CREATE OR REPLACE FUNCTION public.dk_apply_inventory_funding_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_need NUMERIC;
  v_take NUMERIC;
  v_cost NUMERIC := 0;
  rec RECORD;
BEGIN
  IF NEW.movement_type IN ('SALE', 'MANUAL_OUT', 'ADJUSTMENT_OUT') AND NEW.qty < 0 THEN
    v_need := abs(NEW.qty);
    FOR rec IN
      SELECT * FROM public.inventory_funding_lots
      WHERE item_id = NEW.item_id AND qty_remaining > 0
      ORDER BY CASE owner WHEN 'boss' THEN 0 ELSE 1 END, business_date, created_at, id
      FOR UPDATE
    LOOP
      EXIT WHEN v_need <= 0;
      v_take := LEAST(v_need, rec.qty_remaining);
      UPDATE public.inventory_funding_lots SET qty_remaining = qty_remaining - v_take WHERE id = rec.id;
      INSERT INTO public.inventory_funding_allocations (
        id, outbound_ledger_id, lot_id, owner, qty, unit_cost, repayment_eligible
      ) VALUES (
        'FA-' || replace(pg_catalog.gen_random_uuid()::text, '-', ''),
        NEW.id, rec.id, rec.owner, v_take, rec.unit_cost, NEW.movement_type = 'SALE'
      ) ON CONFLICT (outbound_ledger_id, lot_id) DO NOTHING;
      v_need := v_need - v_take;
    END LOOP;

    -- 防止舊資料或人工調整造成批次缺口：缺口依既定規則歸 BOSS，交易不中斷。
    IF v_need > 0 THEN
      SELECT COALESCE(cost_unit, 0) INTO v_cost FROM public.inventory_costs WHERE item_id = NEW.item_id;
      INSERT INTO public.inventory_funding_lots (
        id, item_id, source_key, owner, qty_received, qty_remaining, unit_cost, business_date
      ) VALUES (
        'FL-GAP-' || NEW.id, NEW.item_id, 'gap:' || NEW.id, 'boss', v_need, 0,
        COALESCE(v_cost, 0), COALESCE(NEW.business_date, public.dk_taiwan_today())
      ) ON CONFLICT (source_key) DO NOTHING;
      INSERT INTO public.inventory_funding_allocations (
        id, outbound_ledger_id, lot_id, owner, qty, unit_cost, repayment_eligible
      ) VALUES (
        'FA-GAP-' || NEW.id, NEW.id, 'FL-GAP-' || NEW.id, 'boss', v_need,
        COALESCE(v_cost, 0), NEW.movement_type = 'SALE'
      ) ON CONFLICT (outbound_ledger_id, lot_id) DO NOTHING;
    END IF;
  ELSIF NEW.movement_type = 'SALE_RETURN' AND NEW.qty > 0 THEN
    v_need := NEW.qty;
    FOR rec IN
      SELECT a.id AS allocation_id, a.lot_id, a.qty, a.reversed_qty
      FROM public.inventory_funding_allocations a
      JOIN public.inventory_ledger l ON l.id = a.outbound_ledger_id
      WHERE l.item_id = NEW.item_id
        AND l.ref_id IS NOT DISTINCT FROM NEW.ref_id
        AND a.repayment_eligible
        AND a.reversed_qty < a.qty
      ORDER BY a.created_at DESC, a.id DESC
      FOR UPDATE OF a
    LOOP
      EXIT WHEN v_need <= 0;
      v_take := LEAST(v_need, rec.qty - rec.reversed_qty);
      UPDATE public.inventory_funding_allocations
      SET reversed_qty = reversed_qty + v_take WHERE id = rec.allocation_id;
      UPDATE public.inventory_funding_lots
      SET qty_remaining = qty_remaining + v_take WHERE id = rec.lot_id;
      v_need := v_need - v_take;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_apply_inventory_funding_movement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_inventory_funding_movement ON public.inventory_ledger;
CREATE TRIGGER trg_inventory_funding_movement
  AFTER INSERT ON public.inventory_ledger
  FOR EACH ROW EXECUTE PROCEDURE public.dk_apply_inventory_funding_movement();

CREATE OR REPLACE FUNCTION public.backoffice_inventory_funding_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_boss_stock NUMERIC := 0;
  v_hala_stock NUMERIC := 0;
  v_boss_sold NUMERIC := 0;
  v_boss_repaid NUMERIC := 0;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  SELECT
    COALESCE(sum(qty_remaining * unit_cost) FILTER (WHERE owner = 'boss'), 0),
    COALESCE(sum(qty_remaining * unit_cost) FILTER (WHERE owner = 'hala'), 0)
  INTO v_boss_stock, v_hala_stock FROM public.inventory_funding_lots;
  SELECT COALESCE(sum((qty - reversed_qty) * unit_cost), 0)
  INTO v_boss_sold FROM public.inventory_funding_allocations
  WHERE owner = 'boss' AND repayment_eligible;
  SELECT COALESCE(sum(amount), 0) INTO v_boss_repaid
  FROM public.inventory_funding_repayments WHERE owner = 'boss';
  RETURN pg_catalog.jsonb_build_object(
    'boss_inventory_cost', v_boss_stock,
    'hala_inventory_cost', v_hala_stock,
    'boss_sold_principal', v_boss_sold,
    'boss_repaid_principal', v_boss_repaid,
    'boss_pending_principal', GREATEST(v_boss_sold - v_boss_repaid, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_inventory_funding_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_inventory_funding_summary() TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_record_boss_repayment(
  p_amount NUMERIC,
  p_paid_at DATE DEFAULT NULL,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_id TEXT;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN RAISE EXCEPTION 'amount must be greater than zero'; END IF;
  v_id := 'FR-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  INSERT INTO public.inventory_funding_repayments(id, owner, amount, paid_at, note)
  VALUES (v_id, 'boss', p_amount, COALESCE(p_paid_at, public.dk_taiwan_today()), NULLIF(btrim(COALESCE(p_note, '')), ''));
  RETURN pg_catalog.jsonb_build_object('ok', true, 'repayment_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_record_boss_repayment(NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_record_boss_repayment(NUMERIC, DATE, TEXT) TO authenticated;

COMMIT;
