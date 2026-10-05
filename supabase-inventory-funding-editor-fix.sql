-- DK 電競電腦：修正編輯庫存時 HALA／BOSS 成本與出資方不同步
-- 可安全重複執行；不改庫存數量、不改已售出批次的歷史本金。

BEGIN;

-- 管理員修改品項單位成本時，同步目前仍在庫的出資批次成本。
CREATE OR REPLACE FUNCTION public.dk_sync_open_funding_lot_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.inventory_funding_lots
  SET unit_cost = COALESCE(NEW.cost_unit, 0)
  WHERE item_id = NEW.item_id
    AND qty_remaining > 0;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_sync_open_funding_lot_cost() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_inventory_funding_item_cost ON public.inventory_costs;
CREATE TRIGGER trg_inventory_funding_item_cost
  AFTER INSERT OR UPDATE OF cost_unit ON public.inventory_costs
  FOR EACH ROW EXECUTE PROCEDURE public.dk_sync_open_funding_lot_cost();

-- 先校正既有未售庫存：批次成本採目前品項成本，並補齊過去人工增加數量造成的批次缺口。
UPDATE public.inventory_funding_lots f
SET unit_cost = COALESCE(c.cost_unit, 0)
FROM public.inventory_costs c
WHERE c.item_id = f.item_id
  AND f.qty_remaining > 0;

WITH funded AS (
  SELECT
    i.id AS item_id,
    GREATEST(COALESCE(i.qty_on_hand, 0) - COALESCE(sum(f.qty_remaining), 0), 0) AS missing_qty,
    COALESCE(sum(f.qty_remaining) FILTER (WHERE f.owner = 'boss'), 0) AS boss_qty,
    COALESCE(sum(f.qty_remaining) FILTER (WHERE f.owner = 'hala'), 0) AS hala_qty,
    COALESCE(c.cost_unit, 0) AS unit_cost,
    COALESCE(i.inbound_date, public.dk_taiwan_today()) AS business_date
  FROM public.inventory_items i
  LEFT JOIN public.inventory_funding_lots f ON f.item_id = i.id AND f.qty_remaining > 0
  LEFT JOIN public.inventory_costs c ON c.item_id = i.id
  GROUP BY i.id, i.qty_on_hand, c.cost_unit, i.inbound_date
)
INSERT INTO public.inventory_funding_lots (
  id, item_id, source_key, owner, qty_received, qty_remaining, unit_cost, business_date
)
SELECT
  'FL-EDITOR-RECON-' || item_id,
  item_id,
  'editor-reconcile:' || item_id,
  CASE
    WHEN hala_qty > 0 AND boss_qty = 0 THEN 'hala'
    WHEN boss_qty > 0 AND hala_qty = 0 THEN 'boss'
    WHEN hala_qty > 0 THEN 'hala'
    ELSE 'boss'
  END,
  missing_qty,
  missing_qty,
  unit_cost,
  business_date
FROM funded
WHERE missing_qty > 0
ON CONFLICT (source_key) DO UPDATE SET
  qty_received = EXCLUDED.qty_received,
  qty_remaining = EXCLUDED.qty_remaining,
  unit_cost = EXCLUDED.unit_cost;

-- 讀取品項目前剩餘庫存的出資方；管理員可把剩餘庫存統一改為 HALA 或 BOSS。
CREATE OR REPLACE FUNCTION public.backoffice_inventory_item_funding(
  p_item_id TEXT,
  p_owner TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT;
  v_owner TEXT;
  v_boss_qty NUMERIC := 0;
  v_hala_qty NUMERIC := 0;
BEGIN
  v_role := public.dk_require_backoffice();
  IF v_role IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR btrim(p_item_id) = '' THEN
    RAISE EXCEPTION 'item_id required';
  END IF;

  IF p_owner IS NOT NULL THEN
    v_owner := lower(btrim(p_owner));
    IF v_owner NOT IN ('boss', 'hala') THEN
      RAISE EXCEPTION 'invalid funding owner';
    END IF;
    UPDATE public.inventory_funding_lots
    SET owner = v_owner
    WHERE item_id = p_item_id
      AND qty_remaining > 0;
  END IF;

  SELECT
    COALESCE(sum(qty_remaining) FILTER (WHERE owner = 'boss'), 0),
    COALESCE(sum(qty_remaining) FILTER (WHERE owner = 'hala'), 0)
  INTO v_boss_qty, v_hala_qty
  FROM public.inventory_funding_lots
  WHERE item_id = p_item_id
    AND qty_remaining > 0;

  v_owner := CASE
    WHEN v_boss_qty > 0 AND v_hala_qty > 0 THEN 'mixed'
    WHEN v_boss_qty > 0 THEN 'boss'
    ELSE 'hala'
  END;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'owner', v_owner,
    'boss_qty', v_boss_qty,
    'hala_qty', v_hala_qty
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_inventory_item_funding(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_inventory_item_funding(TEXT, TEXT) TO authenticated;

COMMIT;
