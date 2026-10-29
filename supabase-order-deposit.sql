BEGIN;

CREATE OR REPLACE FUNCTION public.dk_set_order_deposit(p_id TEXT,p_amount NUMERIC)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE received NUMERIC;
BEGIN
  PERFORM public.dk_require_backoffice();
  SELECT COALESCE((extra->>'received_amount')::numeric,0) INTO received FROM public.orders WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF p_amount IS NULL OR p_amount<0 OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount>received
    THEN RAISE EXCEPTION '訂金須為有效金額，且不得超過累計實收'; END IF;
  UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object('deposit_amount',p_amount) WHERE id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.dk_set_order_deposit(TEXT,NUMERIC) FROM PUBLIC,anon,authenticated;

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
  IF p_received_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '實收須為有效金額'; END IF;
  IF p_payment_status='unpaid' AND COALESCE(p_received_amount,0)<>0 THEN RAISE EXCEPTION 'unpaid amount must be zero'; END IF;
  IF p_payment_status='partial' AND (COALESCE(p_received_amount,0)<=0 OR COALESCE(p_received_amount,0)>=v_due) THEN RAISE EXCEPTION 'partial payment amount invalid'; END IF;
  IF p_payment_status='paid' AND COALESCE(p_received_amount,0)<v_due THEN RAISE EXCEPTION 'paid amount is below order total'; END IF;
  IF p_payment_status<>'unpaid' AND p_payment_date IS NULL THEN RAISE EXCEPTION 'payment date required'; END IF;
  IF p_delivery_status='delivered' AND p_delivered_at IS NULL THEN RAISE EXCEPTION 'delivery date required'; END IF;
  IF EXISTS(SELECT 1 FROM public.orders WHERE id=p_order_id AND COALESCE((extra->>'deposit_amount')::numeric,0)>COALESCE(p_received_amount,0))
    THEN RAISE EXCEPTION '累計實收不可低於已記錄訂金，請先核對訂金與退款'; END IF;
  v_extra:=pg_catalog.jsonb_build_object(
    'payment_status',p_payment_status,'received_amount',COALESCE(p_received_amount,0),
    'payment_date',COALESCE(p_payment_date::text,''),'payment_reference',COALESCE(p_payment_reference,''),
    'delivery_status',p_delivery_status,'delivered_at',COALESCE(p_delivered_at::text,''),
    'delivery_note',COALESCE(p_delivery_note,'')
  );
  UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||v_extra,updated_at=pg_catalog.now() WHERE id=p_order_id;
  RETURN pg_catalog.jsonb_build_object('ok',true,'id',p_order_id,'amount_due',v_due,'operations',v_extra);
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_update_order_checked(p_expected_updated_at TEXT,p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_old public.orders%ROWTYPE; v_result JSONB;
BEGIN
  PERFORM public.dk_require_backoffice();
  SELECT * INTO v_old FROM public.orders WHERE id=p_payload->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF p_expected_updated_at IS NULL OR v_old.updated_at IS DISTINCT FROM p_expected_updated_at::timestamptz
    THEN RAISE EXCEPTION '訂單已由其他裝置更新；未覆蓋，請重新載入後再編輯'; END IF;
  IF p_payload ? 'deposit_amount' THEN
    UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||'{"deposit_amount":0}'::jsonb WHERE id=v_old.id;
  END IF;
  -- Set only the delivery fields needed by the completed-order precondition.
  -- Preserve old payment data until the new total has been calculated.
  IF p_payload->>'status'='completed' AND p_payload->>'delivery_status'='delivered' THEN
    PERFORM public.backoffice_set_order_operations(v_old.id,COALESCE(v_old.extra->>'payment_status','unpaid'),
      COALESCE((v_old.extra->>'received_amount')::numeric,0),NULLIF(v_old.extra->>'payment_date','')::date,
      COALESCE(v_old.extra->>'payment_reference',''),'delivered',
      NULLIF(p_payload->>'delivered_at','')::date,COALESCE(p_payload->>'delivery_note',''));
  END IF;
  v_result := public.backoffice_update_order_v2(v_old.id,p_payload->>'order_no',
    COALESCE(p_payload->>'customer_name',''),COALESCE(p_payload->>'customer_phone',''),COALESCE(p_payload->>'customer_line',''),
    COALESCE(p_payload->>'sales_type',''),COALESCE((p_payload->>'shipping_income')::numeric,0),
    COALESCE((p_payload->>'discount')::numeric,0),COALESCE(p_payload->>'payment_method','transfer'),
    COALESCE(p_payload->>'status','pending'),p_payload->'items');
  -- Recheck received amounts against the UPDATED total, within the same transaction.
  PERFORM public.backoffice_set_order_operations(v_old.id,COALESCE(p_payload->>'payment_status','unpaid'),
    COALESCE((p_payload->>'received_amount')::numeric,0),NULLIF(p_payload->>'payment_date','')::date,
    COALESCE(p_payload->>'payment_reference',''),COALESCE(p_payload->>'delivery_status','pending'),
    NULLIF(p_payload->>'delivered_at','')::date,COALESCE(p_payload->>'delivery_note',''));
  PERFORM public.backoffice_set_order_quote_note(v_old.id,COALESCE(p_payload->>'quote_note',''));
  IF NULLIF(pg_catalog.btrim(p_payload->>'customer_source'),'') IS NOT NULL THEN
  PERFORM public.backoffice_set_order_customer_source(v_old.id,COALESCE(p_payload->>'customer_source',''));
  END IF;
  IF p_payload ? 'deposit_amount' THEN
    PERFORM public.dk_set_order_deposit(v_old.id,(p_payload->>'deposit_amount')::numeric);
  END IF;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_create_order_checked(p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result JSONB; v_id TEXT;
BEGIN
  PERFORM public.dk_require_backoffice();
  v_result := public.backoffice_create_order_v2(p_payload->>'order_no',COALESCE(p_payload->>'customer_name',''),
    COALESCE(p_payload->>'customer_phone',''),COALESCE(p_payload->>'customer_line',''),COALESCE(p_payload->>'sales_type',''),
    COALESCE((p_payload->>'shipping_income')::numeric,0),COALESCE((p_payload->>'discount')::numeric,0),
    COALESCE(p_payload->>'payment_method','transfer'),COALESCE(p_payload->>'status','pending'),p_payload->'items');
  v_id := v_result->>'id';
  IF COALESCE(v_id,'')='' THEN RAISE EXCEPTION 'created order id missing'; END IF;
  PERFORM public.backoffice_set_order_operations(v_id,COALESCE(p_payload->>'payment_status','unpaid'),
    COALESCE((p_payload->>'received_amount')::numeric,0),NULLIF(p_payload->>'payment_date','')::date,
    COALESCE(p_payload->>'payment_reference',''),COALESCE(p_payload->>'delivery_status','pending'),
    NULLIF(p_payload->>'delivered_at','')::date,COALESCE(p_payload->>'delivery_note',''));
  PERFORM public.backoffice_set_order_quote_note(v_id,COALESCE(p_payload->>'quote_note',''));
  IF NULLIF(pg_catalog.btrim(p_payload->>'customer_source'),'') IS NOT NULL THEN
  PERFORM public.backoffice_set_order_customer_source(v_id,COALESCE(p_payload->>'customer_source',''));
  END IF;
  IF p_payload ? 'deposit_amount' THEN
    PERFORM public.dk_set_order_deposit(v_id,(p_payload->>'deposit_amount')::numeric);
  END IF;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.backoffice_set_order_operations(TEXT,TEXT,NUMERIC,DATE,TEXT,TEXT,DATE,TEXT) FROM PUBLIC,anon,authenticated;

COMMIT;
