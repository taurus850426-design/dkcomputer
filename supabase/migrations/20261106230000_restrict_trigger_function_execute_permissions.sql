REVOKE EXECUTE ON FUNCTION public.dk_apply_procurement_cost_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dk_guard_completed_procurement_cost() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dk_prevent_ordered_item_hard_delete() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dk_recalculate_order_cost_before_write() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inventory_items_protect_exclude_flag() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inventory_ledger_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inventory_ledger_costs_protect() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inventory_ledger_protect_append_only() FROM PUBLIC, anon, authenticated;
