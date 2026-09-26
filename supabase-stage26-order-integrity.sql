-- Stage 26: 訂單完成、報表認列與叫貨流水一致性
-- 執行後只影響新操作；不批次改寫既有正式訂單或既有庫存流水。

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL
     OR to_regprocedure('public.dk_profit_require_admin()') IS NULL
     OR to_regprocedure('public.dk_order_business_date(date,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'Stage 26 preflight failed: prerequisite functions are missing';
  END IF;
  IF to_regclass('public.orders') IS NULL
     OR to_regclass('public.order_items') IS NULL
     OR to_regclass('public.inventory_ledger') IS NULL THEN
    RAISE EXCEPTION 'Stage 26 preflight failed: prerequisite tables are missing';
  END IF;
END
$$;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.completed_at IS
  'Stage 26: completion recognition timestamp. Historical NULL rows fall back to the original order date.';

CREATE OR REPLACE FUNCTION public.dk_stamp_order_completed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'completed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    NEW.completed_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_order_completed_at ON public.orders;
CREATE TRIGGER trg_stamp_order_completed_at
BEFORE INSERT OR UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.dk_stamp_order_completed_at();

CREATE OR REPLACE FUNCTION public.dk_guard_completed_procurement_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'completed' AND EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = NEW.id
      AND COALESCE(oi.extra->>'fulfillment_type','') = 'procurement'
  ) THEN
    RAISE EXCEPTION 'procurement receipt required before completing order';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_completed_procurement_cost ON public.orders;
CREATE CONSTRAINT TRIGGER trg_guard_completed_procurement_cost
AFTER INSERT OR UPDATE OF status ON public.orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.dk_guard_completed_procurement_cost();

-- 依既有 ref_type 精準分類新流水，避免叫貨到貨被算成手動入庫，
-- 並讓「客戶專用 -> 一般庫存」只視為退回，不重複增加入庫金額。
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
    IF COALESCE(NEW.ref_type, '') = 'PURCHASE_RECEIPT' AND NEW.type = 'IN' THEN
      NEW.movement_type := 'PURCHASE_RECEIPT';
    ELSIF COALESCE(NEW.ref_type, '') = 'PURCHASE_DESTINATION' AND NEW.type = 'OUT' THEN
      NEW.movement_type := 'SALE';
    ELSIF COALESCE(NEW.ref_type, '') = 'PURCHASE_DESTINATION' AND NEW.type = 'IN' THEN
      NEW.movement_type := 'SALE_RETURN';
    ELSIF COALESCE(NEW.ref_type, '') = 'ORDER' AND NEW.type = 'OUT' THEN
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

  IF NEW.business_date IS NULL AND NEW.ref_type = 'PURCHASE_RECEIPT' THEN
    SELECT it.inbound_date INTO NEW.business_date
    FROM public.inventory_items it WHERE it.id = NEW.item_id;
  ELSIF NEW.business_date IS NULL AND NEW.ref_type = 'PURCHASE_DESTINATION' THEN
    SELECT l.business_date INTO NEW.business_date
    FROM public.inventory_ledger l
    WHERE l.ref_type = 'PURCHASE_RECEIPT' AND l.ref_id = NEW.ref_id
    ORDER BY l.created_at LIMIT 1;
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

CREATE OR REPLACE FUNCTION public.dk_compute_profit_for_range(
  p_from DATE,
  p_to_exclusive DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revenue NUMERIC;
  v_cogs_orders NUMERIC;
  v_gross NUMERIC;
  v_opex NUMERIC;
  v_cogs_exp NUMERIC;
  v_dist NUMERIC;
  v_base NUMERIC;
  v_s35 NUMERIC;
  v_s40 NUMERIC;
  v_co NUMERIC;
BEGIN
  PERFORM public.dk_profit_require_admin();
  IF p_from IS NULL OR p_to_exclusive IS NULL OR p_to_exclusive <= p_from THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;

  SELECT
    COALESCE(ROUND(SUM(COALESCE(o.total_sale,0) + COALESCE(o.shipping_income,0) - COALESCE(o.discount,0)),0),0),
    COALESCE(ROUND(SUM(COALESCE(oc.cogs_total,0)),0),0)
  INTO v_revenue, v_cogs_orders
  FROM public.orders o
  LEFT JOIN public.order_costs oc ON oc.order_id=o.id
  WHERE COALESCE((o.completed_at AT TIME ZONE 'Asia/Taipei')::date,
                 public.dk_order_business_date(o.date,o.created_at)) >= p_from
    AND COALESCE((o.completed_at AT TIME ZONE 'Asia/Taipei')::date,
                 public.dk_order_business_date(o.date,o.created_at)) < p_to_exclusive
    AND o.status = 'completed';

  v_gross := v_revenue - v_cogs_orders;
  SELECT COALESCE(ROUND(SUM(COALESCE(e.amount,0)),0),0) INTO v_opex
  FROM public.expenses e
  WHERE e.date>=p_from AND e.date<p_to_exclusive AND e.type IN ('OPEX','OTHER');
  SELECT COALESCE(ROUND(SUM(COALESCE(e.amount,0)),0),0) INTO v_cogs_exp
  FROM public.expenses e
  WHERE e.date>=p_from AND e.date<p_to_exclusive AND e.type='COGS';

  v_dist := v_gross-v_opex;
  v_base := GREATEST(v_dist,0);
  v_s35 := ROUND(v_base*35/100,0);
  v_s40 := ROUND(v_base*40/100,0);
  v_co := v_base-v_s35-v_s40;
  RETURN pg_catalog.jsonb_build_object(
    'revenue_snapshot',v_revenue,'gross_profit_snapshot',v_gross,
    'operating_expense_snapshot',v_opex,'cogs_expense_snapshot',v_cogs_exp,
    'distributable_profit_snapshot',v_dist,'share_35_amount',v_s35,
    'share_40_amount',v_s40,'company_retained_amount',v_co,
    'formula_version','v2_completed_at'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_compute_profit_for_range(DATE,DATE) FROM PUBLIC,anon,authenticated;

COMMIT;

SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='orders' AND column_name='completed_at') AS completed_at_ready,
  to_regprocedure('public.dk_compute_profit_for_range(date,date)') IS NOT NULL AS profit_ready,
  to_regprocedure('public.inventory_ledger_before_insert()') IS NOT NULL AS ledger_classification_ready;
