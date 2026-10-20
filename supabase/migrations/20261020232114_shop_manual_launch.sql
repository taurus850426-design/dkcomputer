-- Launch manual-payment web orders. Existing business orders/stock/finance are not rewritten.
BEGIN;
CREATE TABLE public.shop_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.shop_settings(singleton,enabled) VALUES(true,false);
ALTER TABLE public.shop_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,UPDATE ON public.shop_settings TO service_role;
CREATE TABLE public.shop_product_rules (
 product_id text PRIMARY KEY,
 requires_quote boolean NOT NULL DEFAULT false
);
-- Multiple GPU models share a display price; keep inquiry until a single model/price is confirmed.
INSERT INTO public.shop_product_rules(product_id,requires_quote) VALUES('WEB-014',true);
ALTER TABLE public.shop_product_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_product_rules FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.shop_product_rules TO service_role;
ALTER TABLE public.shop_orders ADD COLUMN customer_message text NOT NULL DEFAULT '' CHECK(length(customer_message)<=2000);
ALTER TABLE public.shop_orders ADD COLUMN hold_until timestamptz;
ALTER TABLE public.shop_orders ADD COLUMN transfer_last5 text CHECK(transfer_last5 ~ '^[0-9]{5}$');
CREATE INDEX shop_orders_created_idx ON public.shop_orders(created_at);

CREATE FUNCTION public.shop_expire_unpaid() RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 UPDATE public.shop_orders SET status='cancelled',customer_message='付款期限已過，本次訂購已取消。如已轉帳，請先聯絡店家核對，勿重複付款。',updated_at=clock_timestamp()
 WHERE id IN (SELECT id FROM public.shop_orders WHERE status='awaiting_payment' AND payment='transfer' AND hold_until<now() FOR UPDATE SKIP LOCKED);
$$;

CREATE FUNCTION public.shop_catalog() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'price',i.price,'photos',i.photos,
  'requires_quote',coalesce(r.requires_quote,false),'stock_status',i.stock_status,
  'qty',CASE WHEN i.qty IS NULL THEN NULL ELSE greatest(0,i.qty-coalesce(h.held,0)) END) ORDER BY i.created_at DESC),'[]'::jsonb)
 FROM public.inventory i LEFT JOIN public.shop_product_rules r ON r.product_id=i.id
 LEFT JOIN LATERAL (SELECT sum((x->>'qty')::integer) AS held FROM public.shop_orders s CROSS JOIN LATERAL jsonb_array_elements(s.items) x
 WHERE s.environment='live' AND s.status IN ('awaiting_payment','payment_pending','payment_review','paid') AND x->>'id'=i.id) h ON true;
$$;

CREATE OR REPLACE FUNCTION public.shop_submit(p_key uuid,p_token_hash text,p_request_hash text,p_ip_hash text,p_customer jsonb,p_cart jsonb,p_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE old public.shop_orders; stock public.inventory; line jsonb; snapshot jsonb:='[]'; total integer:=0; n integer;
BEGIN
 -- Global serialization also makes idempotent retries safe across workers.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dk-shop-submit',0));
 SELECT * INTO old FROM public.shop_orders WHERE request_key=p_key;
 IF FOUND THEN
  IF old.token_hash IS DISTINCT FROM p_token_hash OR old.request_hash IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'request key conflict'; END IF;
  RETURN to_jsonb(old);
 END IF;
 IF (SELECT count(*) FROM public.shop_orders WHERE ip_hash=p_ip_hash AND created_at>now()-interval '10 minutes')>=5
  OR (SELECT count(*) FROM public.shop_orders WHERE created_at>now()-interval '1 hour')>=100 THEN RAISE EXCEPTION 'too many requests'; END IF;
 IF p_cart IS NULL OR jsonb_typeof(p_cart)<>'array' OR jsonb_array_length(p_cart) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid cart'; END IF;
 IF p_customer IS NULL OR coalesce(length(trim(p_customer->>'name')),0) NOT BETWEEN 2 AND 80
  OR coalesce(p_customer->>'phone','') !~ '^\+?[0-9]{8,15}$'
  OR coalesce(p_customer->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR coalesce(length(p_customer->>'email'),999)>160
  OR coalesce(p_customer->>'fulfillment','') NOT IN ('pickup','delivery')
  OR coalesce(p_customer->>'payment','') NOT IN ('transfer','store')
  OR coalesce(length(p_customer->>'note'),0)>500 THEN RAISE EXCEPTION 'invalid customer'; END IF;
 IF p_customer->>'fulfillment'='delivery' AND (coalesce(length(trim(p_customer->>'address')),0) NOT BETWEEN 8 AND 300 OR p_customer->>'payment'='store') THEN RAISE EXCEPTION 'invalid delivery'; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
  IF coalesce(line->>'qty','') !~ '^[1-9][0-9]?$' OR coalesce(length(line->>'id'),0) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'invalid quantity'; END IF;
  n:=(line->>'qty')::integer;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot) x WHERE x->>'id'=line->>'id') THEN RAISE EXCEPTION 'duplicate product'; END IF;
  SELECT * INTO stock FROM public.inventory WHERE id=line->>'id';
  IF NOT FOUND OR stock.price IS NULL OR stock.price<=0 OR stock.price<>trunc(stock.price) OR stock.qty IS NULL OR stock.qty<n
   OR stock.stock_status IN ('售完','售出','停售','缺貨')
   OR EXISTS(SELECT 1 FROM public.shop_product_rules WHERE product_id=stock.id AND requires_quote) THEN RAISE EXCEPTION 'product unavailable'; END IF;
  snapshot:=snapshot||jsonb_build_array(jsonb_build_object('id',stock.id,'name',stock.name,'qty',n,'unit_price',stock.price));
  total:=total+(stock.price*n)::integer;
 END LOOP;
 INSERT INTO public.shop_orders(request_key,token_hash,request_hash,ip_hash,customer,items,subtotal,payment,environment)
 VALUES(p_key,p_token_hash,p_request_hash,p_ip_hash,p_customer,snapshot,total,p_customer->>'payment',p_environment) RETURNING * INTO old;
 RETURN to_jsonb(old);
END $$;

CREATE FUNCTION public.shop_approve_manual(p_id uuid,p_version timestamptz,p_shipping integer,p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders; line jsonb;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF coalesce(length(trim(p_message)),0) NOT BETWEEN 5 AND 2000 OR target.payment NOT IN ('transfer','store') THEN RAISE EXCEPTION 'payment instructions required'; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(target.items) LOOP
  IF EXISTS(SELECT 1 FROM public.shop_product_rules WHERE product_id=line->>'id' AND requires_quote) THEN RAISE EXCEPTION 'product unavailable'; END IF;
 END LOOP;
 PERFORM public.shop_approve(p_id,p_version,p_shipping);
 UPDATE public.shop_orders SET customer_message=trim(p_message),hold_until=CASE WHEN payment='transfer' THEN now()+interval '48 hours' ELSE NULL END,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE FUNCTION public.shop_report_transfer(p_id uuid,p_token_hash text,p_last5 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id AND token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND OR target.payment<>'transfer' OR coalesce(p_last5,'') !~ '^[0-9]{5}$' THEN RAISE EXCEPTION 'invalid transfer report'; END IF;
 IF target.status='payment_review' AND target.transfer_last5=p_last5 THEN RETURN to_jsonb(target); END IF;
 IF target.status<>'awaiting_payment' OR target.hold_until<now() THEN RAISE EXCEPTION 'transfer report not allowed'; END IF;
 UPDATE public.shop_orders SET status='payment_review',transfer_last5=p_last5,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_manual_payment(p_id uuid,p_version timestamptz,p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF target.status NOT IN ('awaiting_payment','payment_review') OR target.payment NOT IN ('transfer','store') OR length(trim(coalesce(p_reference,''))) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'manual payment not allowed'; END IF;
 UPDATE public.shop_orders SET status=CASE WHEN environment='test' THEN 'test_paid' ELSE 'paid' END,manual_reference=trim(p_reference),paid_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_cancel(p_id uuid,p_version timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF target.status NOT IN ('awaiting_confirmation','awaiting_payment','payment_review') OR target.paid_at IS NOT NULL OR target.payment NOT IN ('transfer','store') THEN RAISE EXCEPTION 'cancellation not allowed, reconcile payment first'; END IF;
 UPDATE public.shop_orders SET status='cancelled',customer_message='本次訂購已取消。如已轉帳，請聯絡店家核對款項，勿重複付款。',updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

REVOKE ALL ON FUNCTION public.shop_expire_unpaid() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_catalog() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_approve_manual(uuid,timestamptz,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_report_transfer(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shop_expire_unpaid(),public.shop_catalog(),public.shop_approve_manual(uuid,timestamptz,integer,text),public.shop_report_transfer(uuid,text,text) TO service_role;
COMMIT;
