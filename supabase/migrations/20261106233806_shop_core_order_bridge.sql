-- Only new, explicitly reviewed WEB conversions are linked. No historical backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS public.shop_order_links (
 shop_order_id uuid PRIMARY KEY REFERENCES public.shop_orders(id) ON DELETE RESTRICT,
 core_order_id text NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
 catalogue_deducted boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.shop_order_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_order_links FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.shop_order_links TO authenticated;
DROP POLICY IF EXISTS shop_links_admin_read ON public.shop_order_links;
CREATE POLICY shop_links_admin_read ON public.shop_order_links FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.profiles WHERE id=(SELECT auth.uid()) AND enabled AND role='admin'));

CREATE OR REPLACE FUNCTION public.backoffice_convert_shop_order(p_shop_id uuid,p_version timestamptz,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source public.shop_orders; linked text; result jsonb; payload jsonb; line jsonb; total numeric:=0;
BEGIN
 IF public.dk_require_backoffice()<>'admin' THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO source FROM public.shop_orders WHERE id=p_shop_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '找不到網站訂購'; END IF;
 SELECT core_order_id INTO linked FROM public.shop_order_links WHERE shop_order_id=p_shop_id;
 IF linked IS NOT NULL THEN RETURN jsonb_build_object('id',linked,'shop_already_linked',true); END IF;
 IF source.environment<>'live' OR source.status NOT IN ('awaiting_payment','payment_review','paid') OR source.shipping_fee IS NULL THEN
  RAISE EXCEPTION '請先確認網站供貨與運費；測試、取消或已交付的歷史單不能轉單';
 END IF;
 IF source.updated_at IS DISTINCT FROM p_version THEN RAISE EXCEPTION '網站訂購已更新，請重新載入後再轉單'; END IF;
 IF source.hold_until<now() AND source.status='awaiting_payment' THEN RAISE EXCEPTION '網站訂購保留期限已過，請先核對'; END IF;
 IF p_payload->>'shop_reviewed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '請先核對此網站單未曾手動建單，且實際零件與整機未重複加入'; END IF;
 IF EXISTS(SELECT 1 FROM public.orders WHERE order_no=source.order_no OR strpos(coalesce(extra->>'quote_note',''),source.order_no)>0) THEN RAISE EXCEPTION '已有記錄此網站單號的後台訂單，請先核對，避免重複建單'; END IF;
 IF p_payload->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION '轉單時請選擇已確認，先核對實際零件或整機'; END IF;
 IF jsonb_typeof(p_payload->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '請加入實際零件或整機'; END IF;
 FOR line IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
  IF coalesce(line->>'fulfillment_type','') NOT IN ('inventory','procurement') OR coalesce(trim(line->>'category'),'')='' THEN
   RAISE EXCEPTION '網站轉單請選擇實際庫存或需要採購，並填品類；不能以零成本服務代替商品';
  END IF;
  IF coalesce((line->>'qty')::numeric,0)<=0 OR coalesce((line->>'unit_price')::numeric,-1)<0 THEN RAISE EXCEPTION '品項數量或售價錯誤'; END IF;
  total:=total+(line->>'qty')::numeric*(line->>'unit_price')::numeric;
 END LOOP;
 IF total IS DISTINCT FROM source.subtotal::numeric OR coalesce((p_payload->>'shipping_income')::numeric,0)<>source.shipping_fee OR coalesce((p_payload->>'discount')::numeric,0)<>0 THEN
  RAISE EXCEPTION '轉單商品合計與運費須符合網站原單；請勿重複加入整機與零件售價';
 END IF;
 payload:=p_payload||jsonb_build_object('customer_name',source.customer->>'name','customer_phone',source.customer->>'phone',
  'customer_source','其他','payment_method',CASE WHEN source.payment='store' THEN 'cash' ELSE 'transfer' END,
  'payment_status',CASE WHEN source.status='paid' THEN 'paid' ELSE 'unpaid' END,
  'received_amount',CASE WHEN source.status='paid' THEN source.subtotal+source.shipping_fee ELSE 0 END,
  'deposit_amount',0,'payment_date',CASE WHEN source.status='paid' THEN (source.paid_at AT TIME ZONE 'Asia/Taipei')::date::text ELSE NULL END,
  'payment_reference',CASE WHEN source.status='paid' THEN source.order_no||'：'||coalesce(source.manual_reference,'網站已核實收款') ELSE '' END,
  'delivery_status','pending','delivered_at',NULL,
  'delivery_note',CASE WHEN source.customer->>'fulfillment'='pickup' THEN '到店自取' ELSE coalesce(source.customer->>'address','') END,
  'quote_note','來源網站訂購：'||source.order_no||E'\n'||coalesce(p_payload->>'quote_note',''));
 result:=public.backoffice_create_order_checked(payload);
 linked:=result->>'id';
 INSERT INTO public.shop_order_links(shop_order_id,core_order_id,created_by) VALUES(p_shop_id,linked,auth.uid());
 UPDATE public.orders SET extra=coalesce(extra,'{}')||jsonb_build_object('shop_order_id',p_shop_id,'shop_order_no',source.order_no) WHERE id=linked;
 -- Converted orders use the core workflow; unpaid expiry no longer cancels them silently.
 UPDATE public.shop_orders SET hold_until=NULL,updated_at=clock_timestamp() WHERE id=p_shop_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.backoffice_convert_shop_order(uuid,timestamptz,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.backoffice_convert_shop_order(uuid,timestamptz,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_linked_shop_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE core public.orders; source public.shop_orders; link public.shop_order_links; line jsonb; state text; paid boolean;
BEGIN
 SELECT * INTO core FROM public.orders WHERE id=NEW.id;
 SELECT * INTO link FROM public.shop_order_links WHERE core_order_id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO source FROM public.shop_orders WHERE id=link.shop_order_id FOR UPDATE;
 IF core.total_sale+core.shipping_income-core.discount<>source.subtotal+source.shipping_fee THEN RAISE EXCEPTION '已連結網站單，應收總額須與網站原單一致；如需改價請先另行處理'; END IF;
 paid:=coalesce(core.extra->>'payment_status','unpaid')='paid' AND coalesce((core.extra->>'received_amount')::numeric,0)>=source.subtotal+source.shipping_fee;
 IF source.paid_at IS NOT NULL AND NOT paid AND core.status<>'refunded' THEN RAISE EXCEPTION '網站已核實收款，不能改為未收款；退款請走退貨退款流程'; END IF;
 IF core.status='completed' THEN
  IF NOT paid OR core.extra->>'delivery_status' IS DISTINCT FROM 'delivered' THEN RAISE EXCEPTION '網站單須收足款並交付才能完成'; END IF;
  IF NOT link.catalogue_deducted THEN
   PERFORM 1 FROM public.inventory WHERE id IN (SELECT x->>'id' FROM jsonb_array_elements(source.items) x) ORDER BY id FOR UPDATE;
   FOR line IN SELECT * FROM jsonb_array_elements(source.items) LOOP
    UPDATE public.inventory SET qty=qty-(line->>'qty')::integer WHERE id=line->>'id' AND qty>=(line->>'qty')::integer;
    IF NOT FOUND THEN RAISE EXCEPTION '官網上架數量不足，結單已取消，請先核對商品數量'; END IF;
   END LOOP;
   UPDATE public.shop_order_links SET catalogue_deducted=true WHERE shop_order_id=source.id;
  END IF;
  state:='fulfilled';
 ELSIF core.status IN ('cancelled','lost','refunded') THEN state:='cancelled';
 ELSIF link.catalogue_deducted THEN RAISE EXCEPTION '網站已交付的訂單請走退貨退款流程';
 ELSIF paid THEN state:='paid';
 ELSE state:=CASE WHEN source.status='payment_review' THEN 'payment_review' ELSE 'awaiting_payment' END;
 END IF;
 UPDATE public.shop_orders SET status=state,hold_until=NULL,
  paid_at=CASE WHEN paid THEN coalesce(paid_at,clock_timestamp()) ELSE paid_at END,
  customer_message=CASE WHEN core.status='refunded' THEN '本筆已辦理退貨退款，如需確認款項請聯絡店家。' ELSE customer_message END,
  updated_at=CASE WHEN status IS DISTINCT FROM state THEN clock_timestamp() ELSE updated_at END
 WHERE id=source.id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_linked_shop_order() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS linked_shop_progress ON public.orders;
CREATE CONSTRAINT TRIGGER linked_shop_progress AFTER INSERT OR UPDATE ON public.orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sync_linked_shop_order();

-- Protect all existing callers, including the legacy Edge Function. Linked orders have one writer.
CREATE OR REPLACE FUNCTION public.protect_linked_shop_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE core public.orders;
BEGIN
 SELECT o.* INTO core FROM public.orders o JOIN public.shop_order_links l ON l.core_order_id=o.id WHERE l.shop_order_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.items IS DISTINCT FROM OLD.items OR NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.shipping_fee IS DISTINCT FROM OLD.shipping_fee OR NEW.payment IS DISTINCT FROM OLD.payment THEN RAISE EXCEPTION '已連結後台訂單，不能修改網站原單商品與金額'; END IF;
 IF NEW.status='paid' AND coalesce(core.extra->>'payment_status','unpaid')<>'paid' OR NEW.status='fulfilled' AND core.status<>'completed'
  OR NEW.status='cancelled' AND core.status NOT IN ('cancelled','lost','refunded') THEN RAISE EXCEPTION '此網站單已轉單，請從後台訂單操作收款、交貨或取消'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_linked_shop_progress() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS linked_shop_guard ON public.shop_orders;
CREATE TRIGGER linked_shop_guard BEFORE UPDATE ON public.shop_orders FOR EACH ROW EXECUTE FUNCTION public.protect_linked_shop_progress();
COMMIT;
