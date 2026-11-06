DO $$
DECLARE
  v_item text := 'i-1792378926791-6zobb5t';
  v_orig text := 'L-9b7987b76ba0419ebfed6b31792b4e31';
  v_qty_fix text;
  v_cost_fix text;
  v_replay jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.inventory_items WHERE id=v_item) THEN
    RAISE EXCEPTION 'RTX2060 item missing';
  END IF;
  v_qty_fix := public.dk_inbound_write_ledger(v_item,'OUT',-1998,'ADJUST',v_orig,'修正 RTX 2060 初始入庫誤植：2000 張更正為 2 張',2,'INBOUND_CORRECTION',DATE '2026-10-19','inbound_correction','fix-rtx2060-qty-20261106',v_orig,'confirmed');
  v_cost_fix := public.dk_inbound_write_ledger(v_item,'ADJUST',0,'ADJUST',v_orig,'修正 RTX 2060 單位成本誤植：NT$2 更正為 NT$2000',2000,'INBOUND_COST_CORRECTION',DATE '2026-10-19','inbound_cost_correction','fix-rtx2060-cost-20261106',v_orig,'confirmed');
  v_replay := public.dk_inbound_replay_item_cost(v_item);
  IF (v_replay->>'qty_on_hand')::numeric <> 2 OR (v_replay->>'cost_unit')::numeric <> 2000 THEN RAISE EXCEPTION 'replay validation failed: %',v_replay; END IF;
  UPDATE public.inventory_funding_lots SET qty_received=2, qty_remaining=2, unit_cost=2000 WHERE item_id=v_item AND source_ledger_id=v_orig;
  IF NOT FOUND THEN RAISE EXCEPTION 'funding lot missing'; END IF;
END $$;
