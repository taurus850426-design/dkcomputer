-- DK 電競電腦：BOSS / HALA 出資報表排除「不計資產」庫存
-- 可安全重複執行；不刪除庫存、不改數量，只更新統計函式。

BEGIN;

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
    COALESCE(sum(f.qty_remaining * f.unit_cost) FILTER (WHERE f.owner = 'boss'), 0),
    COALESCE(sum(f.qty_remaining * f.unit_cost) FILTER (WHERE f.owner = 'hala'), 0)
  INTO v_boss_stock, v_hala_stock
  FROM public.inventory_funding_lots f
  JOIN public.inventory_items i ON i.id = f.item_id
  WHERE NOT COALESCE(i.exclude_from_inventory_value, false);

  SELECT COALESCE(sum((a.qty - a.reversed_qty) * a.unit_cost), 0)
  INTO v_boss_sold
  FROM public.inventory_funding_allocations a
  JOIN public.inventory_funding_lots f ON f.id = a.lot_id
  JOIN public.inventory_items i ON i.id = f.item_id
  WHERE a.owner = 'boss'
    AND a.repayment_eligible
    AND NOT COALESCE(i.exclude_from_inventory_value, false);

  SELECT COALESCE(sum(amount), 0)
  INTO v_boss_repaid
  FROM public.inventory_funding_repayments
  WHERE owner = 'boss';

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

COMMIT;
