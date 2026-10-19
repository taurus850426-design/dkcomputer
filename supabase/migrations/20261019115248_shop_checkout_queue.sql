-- Candidate installer for the isolated web-order queue. Run manually after review.
-- Installation does not rewrite business rows. Runtime fulfill changes web catalogue qty only.
-- Never writes backoffice inventory_items, orders, order_items, funding or purchase_orders.
BEGIN;
CREATE TABLE IF NOT EXISTS public.shop_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_no text NOT NULL UNIQUE DEFAULT ('WEB'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,16))),
 request_key uuid NOT NULL UNIQUE,
 token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 request_hash text NOT NULL,
 ip_hash text NOT NULL,
 customer jsonb NOT NULL,
 items jsonb NOT NULL CHECK (jsonb_typeof(items)='array'),
 subtotal integer NOT NULL CHECK (subtotal>0 AND subtotal<=1000000),
 shipping_fee integer CHECK (shipping_fee>=0 AND shipping_fee<=10000),
 payment text NOT NULL CHECK(payment IN ('credit','transfer','store')),
 environment text NOT NULL CHECK(environment IN ('test','live')),
 status text NOT NULL DEFAULT 'awaiting_confirmation' CHECK(status IN ('awaiting_confirmation','awaiting_payment','payment_pending','payment_review','paid','test_paid','fulfilled','cancelled')),
 trade_no text UNIQUE,
 gateway_trade_no text UNIQUE,
 manual_reference text,
 payment_started_at timestamptz,
 paid_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_status_created_idx ON public.shop_orders(status,created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_ip_created_idx ON public.shop_orders(ip_hash,created_at DESC);
ALTER TABLE public.shop_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_orders FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.shop_orders TO service_role;

CREATE OR REPLACE FUNCTION public.shop_submit(p_key uuid,p_token_hash text,p_request_hash text,p_ip_hash text,p_customer jsonb,p_cart jsonb,p_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE old public.shop_orders; row public.inventory; line jsonb; snapshot jsonb:='[]'; total integer:=0; n integer;
BEGIN
 SELECT * INTO old FROM public.shop_orders WHERE request_key=p_key;
 IF FOUND THEN
  IF old.token_hash<>p_token_hash OR old.request_hash<>p_request_hash THEN RAISE EXCEPTION 'request key conflict'; END IF;
  RETURN to_jsonb(old);
 END IF;
 -- Serialize requests for the same network hash; rate limit is global across workers.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_ip_hash,0));
 IF (SELECT count(*) FROM public.shop_orders WHERE ip_hash=p_ip_hash AND created_at>now()-interval '10 minutes')>=5 THEN RAISE EXCEPTION 'too many requests, please retry later'; END IF;
 IF jsonb_typeof(p_cart)<>'array' OR jsonb_array_length(p_cart)<1 OR jsonb_array_length(p_cart)>20 THEN RAISE EXCEPTION 'invalid cart'; END IF;
 IF length(p_customer->>'name') NOT BETWEEN 2 AND 80 OR length(p_customer->>'phone') NOT BETWEEN 8 AND 16
  OR p_customer->>'fulfillment' NOT IN ('pickup','delivery') OR p_customer->>'payment' NOT IN ('credit','transfer','store') THEN RAISE EXCEPTION 'invalid customer'; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(p_cart) LOOP
  n:=(line->>'qty')::integer;
  IF n<1 OR n>99 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot) x WHERE x->>'id'=line->>'id') THEN RAISE EXCEPTION 'invalid quantity or duplicate product'; END IF;
  SELECT * INTO row FROM public.inventory WHERE id=line->>'id';
  IF NOT FOUND OR row.price IS NULL OR row.price<=0 OR row.price<>trunc(row.price) OR row.qty IS NULL OR row.qty<n THEN RAISE EXCEPTION 'product unavailable or requires confirmation'; END IF;
  snapshot:=snapshot||jsonb_build_array(jsonb_build_object('id',row.id,'name',row.name,'qty',n,'unit_price',row.price));
  total:=total+(row.price*n)::integer;
 END LOOP;
 INSERT INTO public.shop_orders(request_key,token_hash,request_hash,ip_hash,customer,items,subtotal,payment,environment)
 VALUES(p_key,p_token_hash,p_request_hash,p_ip_hash,p_customer,snapshot,total,p_customer->>'payment',p_environment) RETURNING * INTO old;
 RETURN to_jsonb(old);
END $$;

CREATE OR REPLACE FUNCTION public.shop_approve(p_id uuid,p_version timestamptz,p_shipping integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders; line jsonb; stock public.inventory; held numeric;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict, reload the request'; END IF;
 IF target.status<>'awaiting_confirmation' THEN RAISE EXCEPTION 'request already processed'; END IF;
 IF p_shipping IS NULL OR p_shipping<0 OR p_shipping>10000 OR (target.customer->>'fulfillment'='pickup' AND p_shipping<>0) THEN RAISE EXCEPTION 'invalid shipping fee'; END IF;
 -- All approvals lock catalogue rows in the same order before checking held quantities.
 PERFORM 1 FROM public.inventory WHERE id IN (SELECT x->>'id' FROM jsonb_array_elements(target.items) x) ORDER BY id FOR UPDATE;
 FOR line IN SELECT * FROM jsonb_array_elements(target.items) LOOP
  SELECT * INTO stock FROM public.inventory WHERE id=line->>'id';
  IF NOT FOUND OR stock.price IS DISTINCT FROM (line->>'unit_price')::numeric THEN RAISE EXCEPTION 'product price changed, request a new customer confirmation'; END IF;
  SELECT COALESCE(sum((x->>'qty')::numeric),0) INTO held FROM public.shop_orders s CROSS JOIN LATERAL jsonb_array_elements(s.items) x
   WHERE s.id<>p_id AND s.environment=target.environment AND s.status IN ('awaiting_payment','payment_pending','payment_review','paid','test_paid') AND x->>'id'=line->>'id';
  IF stock.qty IS NULL OR stock.qty-held<(line->>'qty')::numeric THEN RAISE EXCEPTION 'insufficient available stock'; END IF;
 END LOOP;
 UPDATE public.shop_orders SET shipping_fee=p_shipping,status='awaiting_payment',updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_start_payment(p_id uuid,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id AND token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'request not found'; END IF;
 IF target.status<>'awaiting_payment' OR target.payment<>'credit' THEN RAISE EXCEPTION 'payment already started or not approved'; END IF;
 UPDATE public.shop_orders SET status='payment_pending',trade_no='DK'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,18)),payment_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_apply_payment(p_trade text,p_amount integer,p_gateway_trade text,p_environment text,p_simulated boolean,p_success boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE trade_no=p_trade FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown trade'; END IF;
 IF target.environment<>p_environment OR p_amount IS DISTINCT FROM target.subtotal+target.shipping_fee OR (p_environment='live' AND p_simulated) THEN RAISE EXCEPTION 'payment verification mismatch'; END IF;
 IF target.status IN ('paid','test_paid','fulfilled') THEN
  IF p_success AND target.gateway_trade_no IS DISTINCT FROM p_gateway_trade THEN RAISE EXCEPTION 'conflicting gateway transaction'; END IF;
  RETURN to_jsonb(target);
 END IF;
 IF target.status NOT IN ('payment_pending','payment_review') THEN RAISE EXCEPTION 'invalid payment state'; END IF;
 IF p_success THEN
  UPDATE public.shop_orders SET status=CASE WHEN p_environment='test' THEN 'test_paid' ELSE 'paid' END,gateway_trade_no=p_gateway_trade,paid_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=target.id RETURNING * INTO target;
 ELSE
  UPDATE public.shop_orders SET status='payment_review',updated_at=clock_timestamp() WHERE id=target.id RETURNING * INTO target;
 END IF;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_cancel(p_id uuid,p_version timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF target.status NOT IN ('awaiting_confirmation','awaiting_payment') THEN RAISE EXCEPTION 'payment has started, reconcile with the gateway before changing stock holds'; END IF;
 UPDATE public.shop_orders SET status='cancelled',updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_manual_payment(p_id uuid,p_version timestamptz,p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF target.status<>'awaiting_payment' OR target.payment NOT IN ('transfer','store') OR length(trim(coalesce(p_reference,''))) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'manual payment not allowed'; END IF;
 UPDATE public.shop_orders SET status=CASE WHEN environment='test' THEN 'test_paid' ELSE 'paid' END,manual_reference=p_reference,paid_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;

CREATE OR REPLACE FUNCTION public.shop_fulfill(p_id uuid,p_version timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.shop_orders; line jsonb;
BEGIN
 SELECT * INTO target FROM public.shop_orders WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR target.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'version conflict'; END IF;
 IF target.status<>'paid' OR target.environment<>'live' THEN RAISE EXCEPTION 'only verified live paid requests can ship'; END IF;
 PERFORM 1 FROM public.inventory WHERE id IN (SELECT x->>'id' FROM jsonb_array_elements(target.items) x) ORDER BY id FOR UPDATE;
 FOR line IN SELECT * FROM jsonb_array_elements(target.items) LOOP
  UPDATE public.inventory SET qty=qty-(line->>'qty')::integer WHERE id=line->>'id' AND qty>=(line->>'qty')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalogue stock changed, reconcile before shipping'; END IF;
 END LOOP;
 UPDATE public.shop_orders SET status='fulfilled',updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO target;
 RETURN to_jsonb(target);
END $$;
GRANT SELECT,UPDATE(qty) ON public.inventory TO service_role;
REVOKE ALL ON FUNCTION public.shop_manual_payment(uuid,timestamptz,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_fulfill(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shop_manual_payment(uuid,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_fulfill(uuid,timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.shop_submit(uuid,text,text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_approve(uuid,timestamptz,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_start_payment(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_apply_payment(text,integer,text,text,boolean,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.shop_cancel(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shop_submit(uuid,text,text,text,jsonb,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_approve(uuid,timestamptz,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_start_payment(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_apply_payment(text,integer,text,text,boolean,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.shop_cancel(uuid,timestamptz) TO service_role;
COMMIT;
