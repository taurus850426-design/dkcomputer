-- Stage 38: serial numbers for purchase receipts / order-bound parts
-- Additive and idempotent. Does not rewrite historical receipt rows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_serials (
  serial_no TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  purchase_order_id TEXT,
  purchase_item_id TEXT,
  order_id TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  order_line_key TEXT,
  received_at DATE,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','reserved','sold','returned','void')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS inventory_serials_item_idx ON public.inventory_serials(item_id);
CREATE INDEX IF NOT EXISTS inventory_serials_order_idx ON public.inventory_serials(order_id);
CREATE INDEX IF NOT EXISTS inventory_serials_purchase_idx ON public.inventory_serials(purchase_order_id,purchase_item_id);

ALTER TABLE public.inventory_serials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_serials FROM PUBLIC,anon;
GRANT SELECT,INSERT,UPDATE ON TABLE public.inventory_serials TO authenticated;
DROP POLICY IF EXISTS inventory_serials_backoffice ON public.inventory_serials;
CREATE POLICY inventory_serials_backoffice ON public.inventory_serials
  FOR ALL TO authenticated
  USING (public.dk_require_backoffice() IN ('admin','staff'))
  WITH CHECK (public.dk_require_backoffice() IN ('admin','staff'));

CREATE OR REPLACE FUNCTION public.backoffice_register_receipt_serials(
  p_item_id TEXT,p_purchase_order_id TEXT,p_purchase_item_id TEXT,p_order_id TEXT,p_order_line_key TEXT,
  p_received_at DATE,p_serials JSONB,p_note TEXT DEFAULT ''
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serial TEXT; v_status TEXT; v_count INTEGER:=0;
BEGIN
  PERFORM public.dk_require_backoffice();
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items i WHERE i.id=p_item_id) THEN RAISE EXCEPTION 'inventory item not found'; END IF;
  IF pg_catalog.jsonb_typeof(COALESCE(p_serials,'[]'::jsonb)) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'serials must be array'; END IF;
  v_status:=CASE WHEN COALESCE(NULLIF(p_order_id,''),'')<>'' THEN 'reserved' ELSE 'in_stock' END;
  FOR v_serial IN SELECT pg_catalog.btrim(value) FROM pg_catalog.jsonb_array_elements_text(COALESCE(p_serials,'[]'::jsonb))
  LOOP
    IF v_serial='' THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.inventory_serials s WHERE pg_catalog.upper(s.serial_no)=pg_catalog.upper(v_serial)) THEN
      RAISE EXCEPTION 'duplicate serial number: %',v_serial;
    END IF;
    INSERT INTO public.inventory_serials(serial_no,item_id,purchase_order_id,purchase_item_id,order_id,order_line_key,received_at,status,note)
    VALUES(v_serial,p_item_id,NULLIF(p_purchase_order_id,''),NULLIF(p_purchase_item_id,''),NULLIF(p_order_id,''),NULLIF(p_order_line_key,''),p_received_at,v_status,COALESCE(p_note,''));
    v_count:=v_count+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('ok',true,'count',v_count);
END $$;

REVOKE ALL ON FUNCTION public.backoffice_register_receipt_serials(TEXT,TEXT,TEXT,TEXT,TEXT,DATE,JSONB,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_register_receipt_serials(TEXT,TEXT,TEXT,TEXT,TEXT,DATE,JSONB,TEXT) TO authenticated;

COMMIT;

SELECT to_regclass('public.inventory_serials') IS NOT NULL AS serial_table_ready,
       to_regprocedure('public.backoffice_register_receipt_serials(text,text,text,text,text,date,jsonb,text)') IS NOT NULL AS serial_rpc_ready;
