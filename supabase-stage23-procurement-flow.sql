-- Stage 23: 採購成本反向同步、成本快照與完成訂單防呆
-- 先執行本檔，再發布相同版本前端。

BEGIN;

DO $$
DECLARE
  missing TEXT;
BEGIN
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 23 preflight failed: dk_require_backoffice() is missing';
  END IF;
  SELECT pg_catalog.string_agg(req.tbl || '.' || req.col, ', ' ORDER BY req.tbl, req.col)
  INTO missing
  FROM (VALUES
    ('orders','id'),('orders','status'),
    ('order_items','id'),('order_items','order_id'),('order_items','qty'),('order_items','extra'),
    ('order_item_costs','order_item_id'),('order_item_costs','cost_unit'),
    ('order_costs','order_id'),('order_costs','cogs_total')
  ) AS req(tbl,col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=req.tbl AND c.column_name=req.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 23 preflight failed: missing %', missing;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.procurement_cost_snapshots (
  order_id TEXT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  unit_cost NUMERIC NOT NULL CHECK (unit_cost > 0),
  vendor TEXT,
  quote_id TEXT,
  quoted_at DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (order_id, line_key)
);

ALTER TABLE public.procurement_cost_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.procurement_cost_snapshots FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.procurement_cost_snapshots TO authenticated;

DROP POLICY IF EXISTS procurement_cost_snapshots_backoffice ON public.procurement_cost_snapshots;
CREATE POLICY procurement_cost_snapshots_backoffice
  ON public.procurement_cost_snapshots
  FOR ALL TO authenticated
  USING (public.dk_require_backoffice() IN ('admin','staff'))
  WITH CHECK (public.dk_require_backoffice() IN ('admin','staff'));

CREATE OR REPLACE FUNCTION public.dk_apply_procurement_cost_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_id TEXT;
  v_line_key TEXT;
  v_type TEXT;
  v_snapshot NUMERIC;
BEGIN
  SELECT oi.order_id,
         COALESCE(NULLIF(oi.extra->>'line_key',''), pg_catalog.split_part(oi.id, ':', 2)),
         COALESCE(NULLIF(oi.extra->>'fulfillment_type',''), CASE WHEN oi.item_id IS NULL THEN 'service' ELSE 'inventory' END)
  INTO v_order_id, v_line_key, v_type
  FROM public.order_items oi
  WHERE oi.id = NEW.order_item_id;

  IF v_type = 'procurement' AND COALESCE(NEW.cost_unit, 0) <= 0 AND COALESCE(v_line_key, '') <> '' THEN
    SELECT pcs.unit_cost INTO v_snapshot
    FROM public.procurement_cost_snapshots pcs
    WHERE pcs.order_id = v_order_id AND pcs.line_key = v_line_key;
    IF FOUND THEN NEW.cost_unit := v_snapshot; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_procurement_cost_snapshot ON public.order_item_costs;
CREATE TRIGGER trg_apply_procurement_cost_snapshot
BEFORE INSERT OR UPDATE OF cost_unit ON public.order_item_costs
FOR EACH ROW EXECUTE FUNCTION public.dk_apply_procurement_cost_snapshot();

CREATE OR REPLACE FUNCTION public.dk_recalculate_order_cost_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  SELECT COALESCE(SUM(COALESCE(oic.cost_unit,0) * COALESCE(oi.qty,0)),0)
  INTO NEW.cogs_total
  FROM public.order_items oi
  LEFT JOIN public.order_item_costs oic ON oic.order_item_id = oi.id
  WHERE oi.order_id = NEW.order_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalculate_order_cost_before_write ON public.order_costs;
CREATE TRIGGER trg_recalculate_order_cost_before_write
BEFORE INSERT OR UPDATE OF cogs_total ON public.order_costs
FOR EACH ROW EXECUTE FUNCTION public.dk_recalculate_order_cost_before_write();

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
    LEFT JOIN public.order_item_costs oic ON oic.order_item_id = oi.id
    WHERE oi.order_id = NEW.id
      AND COALESCE(oi.extra->>'fulfillment_type','') = 'procurement'
      AND COALESCE(oic.cost_unit,0) <= 0
  ) THEN
    RAISE EXCEPTION 'procurement cost required';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_completed_procurement_cost ON public.orders;
CREATE CONSTRAINT TRIGGER trg_guard_completed_procurement_cost
AFTER INSERT OR UPDATE OF status ON public.orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.dk_guard_completed_procurement_cost();

CREATE OR REPLACE FUNCTION public.backoffice_sync_procurement_cost(
  p_order_id TEXT,
  p_line_key TEXT,
  p_unit_cost NUMERIC,
  p_vendor TEXT DEFAULT NULL,
  p_quote_id TEXT DEFAULT NULL,
  p_quoted_at DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_line_id TEXT;
  v_cogs NUMERIC;
  v_total NUMERIC;
  v_shipping NUMERIC;
  v_discount NUMERIC;
BEGIN
  v_role := public.dk_require_backoffice();
  IF COALESCE(NULLIF(p_order_id,''),'') = '' OR COALESCE(NULLIF(p_line_key,''),'') = '' THEN
    RAISE EXCEPTION 'order id and line key required';
  END IF;
  IF COALESCE(p_unit_cost,0) <= 0 THEN RAISE EXCEPTION 'unit cost must be > 0'; END IF;

  SELECT oi.id INTO v_line_id
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND COALESCE(oi.extra->>'fulfillment_type','') = 'procurement'
    AND (oi.extra->>'line_key' = p_line_key OR oi.id = p_order_id || ':' || p_line_key)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'linked procurement order line not found'; END IF;

  INSERT INTO public.procurement_cost_snapshots(order_id,line_key,unit_cost,vendor,quote_id,quoted_at,updated_at)
  VALUES(p_order_id,p_line_key,p_unit_cost,NULLIF(p_vendor,''),NULLIF(p_quote_id,''),p_quoted_at,pg_catalog.now())
  ON CONFLICT(order_id,line_key) DO UPDATE SET
    unit_cost=EXCLUDED.unit_cost,
    vendor=EXCLUDED.vendor,
    quote_id=EXCLUDED.quote_id,
    quoted_at=EXCLUDED.quoted_at,
    updated_at=pg_catalog.now();

  INSERT INTO public.order_item_costs(order_item_id,cost_unit)
  VALUES(v_line_id,p_unit_cost)
  ON CONFLICT(order_item_id) DO UPDATE SET cost_unit=EXCLUDED.cost_unit;

  UPDATE public.order_items
  SET extra = COALESCE(extra,'{}'::jsonb) || pg_catalog.jsonb_build_object(
    'procurement_vendor',COALESCE(p_vendor,''),
    'procurement_quote_id',COALESCE(p_quote_id,''),
    'procurement_quoted_at',COALESCE(p_quoted_at::text,'')
  )
  WHERE id=v_line_id;

  SELECT COALESCE(SUM(COALESCE(oic.cost_unit,0)*COALESCE(oi.qty,0)),0)
  INTO v_cogs
  FROM public.order_items oi
  LEFT JOIN public.order_item_costs oic ON oic.order_item_id=oi.id
  WHERE oi.order_id=p_order_id;

  INSERT INTO public.order_costs(order_id,cogs_total) VALUES(p_order_id,v_cogs)
  ON CONFLICT(order_id) DO UPDATE SET cogs_total=EXCLUDED.cogs_total;

  SELECT COALESCE(o.total_sale,0),COALESCE(o.shipping_income,0),COALESCE(o.discount,0)
  INTO v_total,v_shipping,v_discount FROM public.orders o WHERE o.id=p_order_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok',true,'order_id',p_order_id,'line_key',p_line_key,'cost_unit',p_unit_cost,
    'cogs_total',v_cogs,'gross_profit',v_total+v_shipping-v_discount-v_cogs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_sync_procurement_cost(TEXT,TEXT,NUMERIC,TEXT,TEXT,DATE) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_sync_procurement_cost(TEXT,TEXT,NUMERIC,TEXT,TEXT,DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_clear_procurement_cost(
  p_order_id TEXT,
  p_line_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_line_id TEXT;
  v_status TEXT;
  v_cogs NUMERIC;
BEGIN
  v_role := public.dk_require_backoffice();
  SELECT o.status INTO v_status FROM public.orders o WHERE o.id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status='completed' THEN RAISE EXCEPTION 'completed order procurement cost is locked'; END IF;

  SELECT oi.id INTO v_line_id
  FROM public.order_items oi
  WHERE oi.order_id=p_order_id
    AND COALESCE(oi.extra->>'fulfillment_type','')='procurement'
    AND (oi.extra->>'line_key'=p_line_key OR oi.id=p_order_id || ':' || p_line_key)
  FOR UPDATE;

  DELETE FROM public.procurement_cost_snapshots pcs
  WHERE pcs.order_id=p_order_id AND pcs.line_key=p_line_key;

  IF v_line_id IS NOT NULL THEN
    INSERT INTO public.order_item_costs(order_item_id,cost_unit) VALUES(v_line_id,0)
    ON CONFLICT(order_item_id) DO UPDATE SET cost_unit=0;
  END IF;

  SELECT COALESCE(SUM(COALESCE(oic.cost_unit,0)*COALESCE(oi.qty,0)),0)
  INTO v_cogs
  FROM public.order_items oi
  LEFT JOIN public.order_item_costs oic ON oic.order_item_id=oi.id
  WHERE oi.order_id=p_order_id;
  INSERT INTO public.order_costs(order_id,cogs_total) VALUES(p_order_id,v_cogs)
  ON CONFLICT(order_id) DO UPDATE SET cogs_total=EXCLUDED.cogs_total;

  RETURN pg_catalog.jsonb_build_object('ok',true,'order_id',p_order_id,'line_key',p_line_key,'cogs_total',v_cogs);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_clear_procurement_cost(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_clear_procurement_cost(TEXT,TEXT) TO authenticated;

COMMIT;

SELECT
  to_regprocedure('public.backoffice_sync_procurement_cost(text,text,numeric,text,text,date)') IS NOT NULL AS cost_sync_ready,
  to_regprocedure('public.backoffice_clear_procurement_cost(text,text)') IS NOT NULL AS cost_clear_ready,
  to_regclass('public.procurement_cost_snapshots') IS NOT NULL AS snapshot_ready;
