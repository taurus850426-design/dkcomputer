-- Order scan workflow: additive, opt-in per order; never adjusts inventory quantities.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_serials_upper_uidx ON public.inventory_serials(upper(btrim(serial_no)));
-- Receipt and S/N registration commit or roll back together, including duplicate failures.
DO $patch$
DECLARE src text; marker text := '      IF COALESCE((v_result->>''already_received'')::boolean,false) THEN';
BEGIN
 SELECT pg_get_functiondef('public.backoffice_purchase_operation(jsonb,text,jsonb)'::regprocedure) INTO src;
 IF position('-- atomic-receipt-serials' in src)=0 THEN
  IF position(marker in src)=0 THEN RAISE EXCEPTION 'purchase function changed; review before applying'; END IF;
  src:=replace(src,marker,$body$      -- atomic-receipt-serials
      IF jsonb_array_length(COALESCE(p_action->'serial_numbers','[]'::jsonb))>0 THEN
        IF jsonb_array_length(p_action->'serial_numbers') > (v_item->>'quantity')::numeric THEN
          RAISE EXCEPTION 'S/N 數量不可超過本次到貨數量'; END IF;
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dk-serial-registry',0));
        PERFORM public.backoffice_register_receipt_serials(v_result->>'item_id',v_old.id,v_item->>'id',
          CASE WHEN v_destination='customer' THEN v_item->>'sourceSalesOrderId' ELSE '' END,
          CASE WHEN v_destination='customer' THEN v_item->>'sourceSalesOrderLineKey' ELSE '' END,
          (p_action->>'received_at')::date,p_action->'serial_numbers',COALESCE(p_action->>'note',''));
        v_item:=v_item||jsonb_build_object('serialNumbers',p_action->'serial_numbers');
      END IF;
$body$||marker);
  marker:='      v_result := public.backoffice_set_purchase_receipt_destination(';
  IF position(marker in src)=0 THEN RAISE EXCEPTION 'destination function changed; review before applying'; END IF;
  src:=replace(src,marker,$body$      IF EXISTS(SELECT 1 FROM public.inventory_serials x LEFT JOIN public.orders so ON so.id=x.order_id
       WHERE x.purchase_order_id=v_old.id AND x.purchase_item_id=v_item->>'id'
        AND (x.status='sold' OR COALESCE(so.extra->'scan_serials','[]'::jsonb) ? x.serial_no)) THEN
       RAISE EXCEPTION '零件已組裝核對或售出，請先移除組裝綁定再修改到貨用途'; END IF;
$body$||marker);
  marker:='      v_item := v_item || pg_catalog.jsonb_build_object(''receiptDestination'',v_destination';
  IF position(marker in src)=0 THEN RAISE EXCEPTION 'destination result changed; review before applying'; END IF;
  src:=replace(src,marker,$body$      UPDATE public.inventory_serials SET
       order_id=CASE WHEN v_destination='customer' THEN NULLIF(v_item->>'sourceSalesOrderId','') ELSE NULL END,
       order_line_key=CASE WHEN v_destination='customer' THEN NULLIF(v_item->>'sourceSalesOrderLineKey','') ELSE NULL END,
       status=CASE WHEN v_destination='customer' THEN 'reserved' ELSE 'in_stock' END,updated_at=pg_catalog.clock_timestamp()
       WHERE purchase_order_id=v_old.id AND purchase_item_id=v_item->>'id';
$body$||marker);
  EXECUTE src;
 END IF;
END $patch$;

CREATE OR REPLACE FUNCTION public.dk_order_scan_fingerprint(p_id text)
RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT pg_catalog.md5(COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
   oi.id,oi.item_id,oi.qty,oi.extra->>'line_key',oi.extra->>'fulfillment_type') ORDER BY oi.id)::text
   FROM public.order_items oi WHERE oi.order_id=p_id),'[]')||COALESCE((SELECT pg_catalog.jsonb_agg(
   pg_catalog.jsonb_build_array(s.serial_no,s.item_id,s.order_line_key) ORDER BY s.serial_no)::text
   FROM public.inventory_serials s WHERE s.order_id=p_id AND s.status IN ('reserved','sold')),'[]'))
$$;
REVOKE ALL ON FUNCTION public.dk_order_scan_fingerprint(text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_order_scan(p_order_id text,p_action text DEFAULT 'inspect',
 p_code text DEFAULT '',p_line_key text DEFAULT '',p_expected_updated_at text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders%ROWTYPE; l public.order_items%ROWTYPE; s public.inventory_serials%ROWTYPE;
 code text:=pg_catalog.btrim(COALESCE(p_code,'')); scans jsonb; fingerprint text; n integer; today date;
BEGIN
 PERFORM public.dk_require_backoffice();
 IF p_action NOT IN ('inspect','bind','register','unbind','test','ship') OR p_action IS NULL THEN RAISE EXCEPTION 'invalid scan action'; END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '找不到訂單'; END IF;
 IF p_action<>'inspect' THEN
  IF p_expected_updated_at IS NULL OR o.updated_at IS DISTINCT FROM p_expected_updated_at::timestamptz THEN
   RAISE EXCEPTION '訂單已更新，請重新載入後核對'; END IF;
  IF o.status IS DISTINCT FROM 'confirmed' OR o.extra->>'delivery_status'='delivered' THEN
   RAISE EXCEPTION '請先確認訂單；已交付或結案不可重新掃碼'; END IF;
 END IF;
 scans:=COALESCE(o.extra->'scan_serials','[]'::jsonb);
 IF p_action IN ('bind','register','unbind') THEN
  IF code='' OR length(code)>200 THEN RAISE EXCEPTION '請掃描有效序號'; END IF;
  SELECT * INTO l FROM public.order_items WHERE order_id=o.id AND
    (extra->>'line_key'=p_line_key OR id=p_line_key) FOR UPDATE;
  IF NOT FOUND OR l.item_id IS NULL OR COALESCE(l.extra->>'fulfillment_type','inventory')='service' THEN
   RAISE EXCEPTION '請選擇已入庫的訂單零件'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dk-serial-registry',0));
  SELECT * INTO s FROM public.inventory_serials WHERE upper(serial_no)=upper(code) FOR UPDATE;
  IF NOT FOUND THEN
   IF p_action<>'register' THEN RAISE EXCEPTION '序號尚未建檔；請先到貨登記，舊庫存可人工確認型號後補登'; END IF;
   INSERT INTO public.inventory_serials(serial_no,item_id,status,note) VALUES(code,l.item_id,'in_stock','舊庫存補登／DK 自訂編號');
   SELECT * INTO s FROM public.inventory_serials WHERE serial_no=code FOR UPDATE;
  END IF;
  IF s.item_id IS DISTINCT FROM l.item_id THEN RAISE EXCEPTION '掃到的零件型號與訂單不同'; END IF;
  IF s.order_id IS NOT NULL AND s.order_id<>o.id THEN RAISE EXCEPTION '此序號已綁定其他訂單'; END IF;
  IF s.status NOT IN ('in_stock','reserved') THEN RAISE EXCEPTION '此零件目前不可使用'; END IF;
  IF s.order_id=o.id AND COALESCE(s.order_line_key,'') NOT IN ('',p_line_key,COALESCE(l.extra->>'line_key',l.id)) THEN
   RAISE EXCEPTION '此序號已綁定其他訂單項目'; END IF;
  IF p_action='unbind' THEN
   IF s.order_id IS DISTINCT FROM o.id THEN RAISE EXCEPTION '此序號不屬於本訂單'; END IF;
   UPDATE public.inventory_serials SET order_id=NULL,order_line_key=NULL,status='in_stock',updated_at=pg_catalog.clock_timestamp() WHERE serial_no=s.serial_no;
   scans:=scans-s.serial_no;
  ELSE
   SELECT count(*) INTO n FROM public.inventory_serials WHERE order_id=o.id AND item_id=l.item_id
     AND order_line_key=COALESCE(l.extra->>'line_key',l.id) AND serial_no<>s.serial_no AND status='reserved';
   IF n>=l.qty THEN RAISE EXCEPTION '此項目已掃足數量，請先移除錯誤序號'; END IF;
   UPDATE public.inventory_serials SET order_id=o.id,order_line_key=COALESCE(l.extra->>'line_key',l.id),status='reserved',updated_at=pg_catalog.clock_timestamp() WHERE serial_no=s.serial_no;
   IF NOT scans ? s.serial_no THEN scans:=scans||pg_catalog.jsonb_build_array(s.serial_no); END IF;
  END IF;
  UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object(
   'scan_enabled',true,'scan_serials',scans,'scan_test_fingerprint',NULL,'scan_test_at',NULL),updated_at=pg_catalog.clock_timestamp() WHERE id=o.id;
 ELSIF p_action IN ('test','ship') THEN
  IF NOT EXISTS(SELECT 1 FROM public.order_items WHERE order_id=o.id) THEN RAISE EXCEPTION '訂單沒有品項'; END IF;
  IF EXISTS(SELECT 1 FROM public.order_items oi WHERE oi.order_id=o.id AND
    COALESCE(oi.extra->>'fulfillment_type','inventory')<>'service' AND (oi.item_id IS NULL OR oi.qty IS DISTINCT FROM
    (SELECT count(*)::numeric FROM public.inventory_serials x WHERE x.order_id=o.id AND x.item_id=oi.item_id
     AND x.order_line_key=COALESCE(oi.extra->>'line_key',oi.id) AND x.status='reserved' AND scans ? x.serial_no))) THEN
   RAISE EXCEPTION '零件尚未掃齊或有未到貨品項'; END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_serials x WHERE x.order_id=o.id AND NOT EXISTS(
    SELECT 1 FROM public.order_items oi WHERE oi.order_id=o.id AND oi.item_id=x.item_id
     AND COALESCE(oi.extra->>'line_key',oi.id)=x.order_line_key)) THEN
   RAISE EXCEPTION '有序號綁在已異動品項，請先核對並移除原綁定'; END IF;
  fingerprint:=public.dk_order_scan_fingerprint(o.id);
  IF p_action='test' THEN
   UPDATE public.orders SET extra=COALESCE(extra,'{}'::jsonb)||pg_catalog.jsonb_build_object('scan_enabled',true,
    'scan_test_fingerprint',fingerprint,'scan_test_at',pg_catalog.clock_timestamp(),'scan_test_by',auth.uid()),
    updated_at=pg_catalog.clock_timestamp() WHERE id=o.id;
  ELSE
   IF code IS DISTINCT FROM o.order_no AND code IS DISTINCT FROM o.id THEN RAISE EXCEPTION '掃描的訂單編號不符'; END IF;
   IF o.extra->>'scan_test_fingerprint' IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION '請先確認實際測試合格；更換零件後需重測'; END IF;
   IF o.extra->>'payment_status' IS DISTINCT FROM 'paid' OR COALESCE((o.extra->>'received_amount')::numeric,0)<GREATEST(o.total_sale+o.shipping_income-o.discount,0) THEN
    RAISE EXCEPTION '尚未收足款項，請先核對收款'; END IF;
   today:=(pg_catalog.now() AT TIME ZONE 'Asia/Taipei')::date;
   PERFORM public.backoffice_set_order_operations(o.id,'paid',(o.extra->>'received_amount')::numeric,
    NULLIF(o.extra->>'payment_date','')::date,COALESCE(o.extra->>'payment_reference',''),'delivered',today,COALESCE(o.extra->>'delivery_note',''));
  END IF;
 END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id;
 RETURN pg_catalog.jsonb_build_object('ok',true,'id',o.id,'order_no',o.order_no,'status',o.status,'updated_at',o.updated_at,
   'delivery_status',COALESCE(o.extra->>'delivery_status','pending'),'scan_test_at',o.extra->>'scan_test_at',
   'scan_test_current',COALESCE(o.extra->>'scan_test_fingerprint'=public.dk_order_scan_fingerprint(o.id),false),
   'lines',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('line_key',COALESCE(oi.extra->>'line_key',oi.id),
    'item_id',oi.item_id,'name',oi.name,'qty',oi.qty,'fulfillment_type',COALESCE(oi.extra->>'fulfillment_type','inventory')) ORDER BY oi.id)
     FROM public.order_items oi WHERE oi.order_id=o.id),'[]'::jsonb),
   'serials',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('serial_no',x.serial_no,'item_id',x.item_id,
     'line_key',x.order_line_key,'status',x.status,'checked',scans ? x.serial_no) ORDER BY x.serial_no)
     FROM public.inventory_serials x WHERE x.order_id=o.id),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.backoffice_order_scan(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_order_scan(text,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.dk_order_scan_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_WHEN='BEFORE' THEN
  IF COALESCE((OLD.extra->>'scan_enabled')::boolean,false) AND NEW.extra->>'delivery_status'='delivered'
   AND OLD.extra->>'delivery_status' IS DISTINCT FROM 'delivered' THEN
   IF NEW.extra->>'scan_test_fingerprint' IS DISTINCT FROM public.dk_order_scan_fingerprint(OLD.id) THEN
    RAISE EXCEPTION '此訂單使用掃碼核對，請先完成零件核對與測試合格'; END IF;
   IF NEW.extra->>'payment_status' IS DISTINCT FROM 'paid' OR COALESCE((NEW.extra->>'received_amount')::numeric,0)<GREATEST(NEW.total_sale+NEW.shipping_income-NEW.discount,0) THEN
    RAISE EXCEPTION '掃碼訂單須先收足款項再交付'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IN ('cancelled','lost') AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE public.inventory_serials SET status='in_stock',order_id=NULL,order_line_key=NULL,updated_at=pg_catalog.clock_timestamp()
   WHERE order_id=NEW.id AND status='reserved';
 ELSIF NEW.extra->>'delivery_status'='delivered' AND OLD.extra->>'delivery_status' IS DISTINCT FROM 'delivered' THEN
  UPDATE public.inventory_serials SET status='sold',updated_at=pg_catalog.clock_timestamp() WHERE order_id=NEW.id AND status='reserved';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dk_order_scan_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS order_scan_before ON public.orders;
CREATE TRIGGER order_scan_before BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.dk_order_scan_guard();
DROP TRIGGER IF EXISTS order_scan_after ON public.orders;
CREATE TRIGGER order_scan_after AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.dk_order_scan_guard();
COMMIT;
