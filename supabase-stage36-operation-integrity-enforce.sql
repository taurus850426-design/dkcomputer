-- Stage 36 phase B: run AFTER frontend version 20261017integrity36 is deployed.
-- Old open tabs will need a refresh; no existing business rows are changed.
BEGIN;
DO $$ BEGIN
  IF to_regprocedure('public.backoffice_purchase_operation(jsonb,text,jsonb)') IS NULL
     OR to_regprocedure('public.backoffice_update_order_checked(text,jsonb)') IS NULL
     OR to_regprocedure('public.backoffice_create_order_checked(jsonb)') IS NULL
     OR to_regprocedure('public.backoffice_set_order_operations_checked(text,jsonb)') IS NULL
    THEN RAISE EXCEPTION 'Install Stage 36 phase A before enforcing'; END IF;
END $$;
-- Retire unversioned client write paths. Existing readers remain available.
REVOKE INSERT,UPDATE,DELETE ON public.purchase_orders FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_update_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_sync_procurement_cost(TEXT,TEXT,NUMERIC,TEXT,TEXT,DATE) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_clear_procurement_cost(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_receive_purchase_item(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,DATE,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_set_purchase_receipt_destination(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_create_order_v2(TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_set_order_operations(TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,DATE,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_set_order_quote_note(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.backoffice_set_order_customer_source(TEXT,TEXT) FROM PUBLIC,anon,authenticated;
COMMIT;
