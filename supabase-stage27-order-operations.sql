-- Stage 27: 人工收款核對、交貨確認與客戶雲端主資料
BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 27 preflight failed: dk_require_backoffice missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.customer_records (
  id TEXT PRIMARY KEY,
  phone_key TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_records_phone_uidx
  ON public.customer_records(phone_key)
  WHERE phone_key IS NOT NULL AND phone_key <> '' AND deleted_at IS NULL;

ALTER TABLE public.customer_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_records FROM PUBLIC,anon;
GRANT SELECT,INSERT,UPDATE ON TABLE public.customer_records TO authenticated;
DROP POLICY IF EXISTS customer_records_backoffice ON public.customer_records;
CREATE POLICY customer_records_backoffice ON public.customer_records
  FOR ALL TO authenticated
  USING (public.dk_require_backoffice() IN ('admin','staff'))
  WITH CHECK (public.dk_require_backoffice() IN ('admin','staff'));

CREATE OR REPLACE FUNCTION public.backoffice_list_customer_records()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rows JSONB;
BEGIN
  PERFORM public.dk_require_backoffice();
  SELECT COALESCE(pg_catalog.jsonb_agg(
    COALESCE(c.data,'{}'::jsonb) || pg_catalog.jsonb_build_object('id',c.id)
    ORDER BY c.updated_at DESC
  ),'[]'::jsonb) INTO v_rows
  FROM public.customer_records c WHERE c.deleted_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('ok',true,'records',v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_upsert_customer_record(p_record JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_id TEXT := COALESCE(NULLIF(p_record->>'id',''),'cr-'||replace(pg_catalog.gen_random_uuid()::text,'-',''));
  v_phone TEXT := pg_catalog.regexp_replace(COALESCE(p_record->>'phone',''),'[^0-9]','','g');
  v_existing TEXT;
  v_data JSONB;
BEGIN
  PERFORM public.dk_require_backoffice();
  IF COALESCE(NULLIF(pg_catalog.btrim(p_record->>'name'),''),'')='' THEN RAISE EXCEPTION 'customer name required'; END IF;
  IF v_phone<>'' THEN
    SELECT c.id INTO v_existing FROM public.customer_records c
    WHERE c.phone_key=v_phone AND c.deleted_at IS NULL LIMIT 1 FOR UPDATE;
    IF v_existing IS NOT NULL THEN v_id:=v_existing; END IF;
  END IF;
  v_data := (COALESCE(p_record,'{}'::jsonb)-'id') || pg_catalog.jsonb_build_object('phone',COALESCE(p_record->>'phone',''));
  INSERT INTO public.customer_records(id,phone_key,data,created_at,updated_at,deleted_at)
  VALUES(v_id,NULLIF(v_phone,''),v_data,pg_catalog.now(),pg_catalog.now(),NULL)
  ON CONFLICT(id) DO UPDATE SET
    phone_key=COALESCE(EXCLUDED.phone_key,public.customer_records.phone_key),
    data=COALESCE(public.customer_records.data,'{}'::jsonb)||EXCLUDED.data,
    updated_at=pg_catalog.now(),deleted_at=NULL;
  RETURN pg_catalog.jsonb_build_object('ok',true,'record',
    (SELECT c.data||pg_catalog.jsonb_build_object('id',c.id) FROM public.customer_records c WHERE c.id=v_id));
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_delete_customer_record(p_customer_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF public.dk_require_backoffice()<>'admin' OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin only' USING ERRCODE='42501'; END IF;
  UPDATE public.customer_records SET deleted_at=pg_catalog.now(),updated_at=pg_catalog.now()
  WHERE id=p_customer_id AND deleted_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('ok',true,'id',p_customer_id);
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_set_order_operations(
  p_order_id TEXT,p_payment_status TEXT,p_received_amount NUMERIC,p_payment_date DATE,
  p_payment_reference TEXT,p_delivery_status TEXT,p_delivered_at DATE,p_delivery_note TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_due NUMERIC; v_extra JSONB;
BEGIN
  PERFORM public.dk_require_backoffice();
  IF p_payment_status NOT IN ('unpaid','partial','paid') THEN RAISE EXCEPTION 'invalid payment status'; END IF;
  IF p_delivery_status NOT IN ('pending','delivered') THEN RAISE EXCEPTION 'invalid delivery status'; END IF;
  SELECT GREATEST(COALESCE(o.total_sale,0)+COALESCE(o.shipping_income,0)-COALESCE(o.discount,0),0)
  INTO v_due FROM public.orders o WHERE o.id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF COALESCE(p_received_amount,0)<0 THEN RAISE EXCEPTION 'received amount cannot be negative'; END IF;
  IF p_payment_status='unpaid' AND COALESCE(p_received_amount,0)<>0 THEN RAISE EXCEPTION 'unpaid amount must be zero'; END IF;
  IF p_payment_status='partial' AND (COALESCE(p_received_amount,0)<=0 OR COALESCE(p_received_amount,0)>=v_due) THEN RAISE EXCEPTION 'partial payment amount invalid'; END IF;
  IF p_payment_status='paid' AND COALESCE(p_received_amount,0)<v_due THEN RAISE EXCEPTION 'paid amount is below order total'; END IF;
  IF p_payment_status<>'unpaid' AND p_payment_date IS NULL THEN RAISE EXCEPTION 'payment date required'; END IF;
  IF p_delivery_status='delivered' AND p_delivered_at IS NULL THEN RAISE EXCEPTION 'delivery date required'; END IF;
  v_extra:=pg_catalog.jsonb_build_object(
    'payment_status',p_payment_status,'received_amount',COALESCE(p_received_amount,0),
    'payment_date',COALESCE(p_payment_date::text,''),'payment_reference',COALESCE(p_payment_reference,''),
    'delivery_status',p_delivery_status,'delivered_at',COALESCE(p_delivered_at::text,''),
    'delivery_note',COALESCE(p_delivery_note,'')
  );
  UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||v_extra,updated_at=pg_catalog.now() WHERE id=p_order_id;
  RETURN pg_catalog.jsonb_build_object('ok',true,'id',p_order_id,'amount_due',v_due,'operations',v_extra);
END $$;

CREATE OR REPLACE FUNCTION public.dk_guard_completed_procurement_cost()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status='completed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    IF EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id=NEW.id
      AND COALESCE(oi.extra->>'fulfillment_type','')='procurement') THEN
      RAISE EXCEPTION 'procurement receipt required before completing order';
    END IF;
    IF COALESCE(NEW.extra->>'delivery_status','pending')<>'delivered' THEN
      RAISE EXCEPTION 'delivery confirmation required before completing order';
    END IF;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.backoffice_list_customer_records() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_upsert_customer_record(JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_delete_customer_record(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_order_operations(TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,DATE,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_list_customer_records() TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_upsert_customer_record(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_delete_customer_record(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_order_operations(TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,DATE,TEXT) TO authenticated;

COMMIT;

SELECT
  to_regclass('public.customer_records') IS NOT NULL AS customer_cloud_ready,
  to_regprocedure('public.backoffice_set_order_operations(text,text,numeric,date,text,text,date,text)') IS NOT NULL AS order_operations_ready,
  to_regprocedure('public.backoffice_list_customer_records()') IS NOT NULL AS customer_list_ready;
