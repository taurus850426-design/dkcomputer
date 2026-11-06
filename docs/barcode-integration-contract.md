# Barcode / serial integration contract (work in progress)

## Verified against production RPC definitions (read-only, 2026-11-06)
- `backoffice_create_order_v2` and `backoffice_update_order_v2` both delegate to `dk_save_order_v2`.
- `dk_save_order_v2` decrements `inventory_items.qty_on_hand` for **inventory** lines when an order enters `confirmed`, `pending`, `paid`, `shipped`, or `completed`. It reverses the delta when leaving an affecting state or changing lines.
- This is **order-time allocation**, not shipment-time decrement. A scan-to-ship operation MUST NOT decrement stock again.
- Existing `backoffice_receive_purchase_item` already uses an advisory transaction lock and receipt key `purchase-order:<purchase_order_id>:<purchase_item_id>` to avoid duplicate receiving. Linked customer orders may consume the receipt quantity in the same transaction.
- Existing receipt key identifies a purchase line, not an individual partial-receipt event. Do not implement multi-partial quantity receipts by repeatedly calling this RPC with the same line ID.

## Required before production
1. Check actual production PK/FK column types and existing RLS policies; this migration is **unapplied** and must be revised if any FK type differs.
2. Implement role-checked, transactional, idempotent server-side RPCs for barcode lookup, serial receiving, serial reservation/shipping, and stocktake.
3. Ensure serial assignments are tied to existing order/receipt ledgers and funding lots without modifying inventory quantities a second time.
4. Add a scanner panel to existing admin flows, not a parallel inventory source of truth.
5. Add a camera fallback for browsers without BarcodeDetector (notably some Safari versions).
6. Test on an isolated staging database with synthetic records; verify duplicate requests, concurrent scans, partial receiving, order cancellation, HALA/BOSS, RLS, and desktop/mobile.
7. Complete smoke tests before merge and deployment. Never execute tests against real production inventory/orders.

## Safety note
The migration currently enables RLS but defines no client policies. Direct table access will be denied by default. Do not deploy it as a finished feature or assume a service-role key belongs in the frontend.
