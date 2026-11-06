-- Additive opt-in workflow: historical orders are unaffected until explicitly enrolled.
BEGIN;
ALTER TABLE public.inventory_serials ADD COLUMN IF NOT EXISTS assembled_at timestamptz;
CREATE TABLE IF NOT EXISTS public.order_scan_checks (
 order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
 exceptions jsonb NOT NULL DEFAULT '{}'::jsonb,
 tested_signature text,
 test_note text NOT NULL DEFAULT '',
 ship_checked boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_scan_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_scan_checks FROM PUBLIC,anon,authenticated;

DROP POLICY IF EXISTS scan_checks_read ON public.order_scan_checks;
-- Access is only through the role-checked RPC; no direct client writes.

CREATE OR REPLACE FUNCTION public.backoffice_scan_operation(p_action text,p_order_id text DEFAULT '',p_code text DEFAULT '',p_line_key text DEFAULT '',p_note text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; l public.order_items; s public.inventory_serials; c public.order_scan_checks;
 v_signature text; v_lines jsonb; v_qty numeric; v_data jsonb;
BEGIN
 PERFORM public.dk_require_backoffice();
 IF p_action='lookup' THEN
   SELECT jsonb_agg(jsonb_build_object('序號',x.serial_no,'型號',i.name,'狀態',x.status,'訂單編號',z.order_no,'到貨日期',x.received_at,'組裝核對時間',x.assembled_at,'檢測紀錄',k.test_note)) INTO v_data
   FROM public.inventory_serials x JOIN public.inventory_items i ON i.id=x.item_id LEFT JOIN public.orders z ON z.id=x.order_id LEFT JOIN public.order_scan_checks k ON k.order_id=z.id
   WHERE upper(x.serial_no)=upper(btrim(p_code)) OR upper(z.order_no)=upper(btrim(p_code));
   RETURN jsonb_build_object('紀錄',coalesce(v_data,'[]'::jsonb));
 END IF;
 SELECT * INTO o FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '找不到訂單'; END IF;
 IF p_action NOT IN ('read','bind','unbind','waive','test','ship') THEN RAISE EXCEPTION '不支援的掃碼作業'; END IF;
 IF p_action<>'read' AND o.status NOT IN ('confirmed','pending','paid') THEN RAISE EXCEPTION '請先確認訂單；已出貨或結束的訂單不可修改掃碼紀錄'; END IF;
 IF p_action IN ('bind','unbind','waive') THEN
   SELECT * INTO l FROM public.order_items WHERE order_id=o.id AND (extra->>'line_key'=p_line_key OR id=o.id||':'||p_line_key) FOR UPDATE;
   IF NOT FOUND OR l.item_id IS NULL THEN RAISE EXCEPTION '找不到已到貨的庫存品項，請先儲存訂單'; END IF;
   IF p_action IN ('bind','unbind') THEN
     SELECT * INTO s FROM public.inventory_serials WHERE upper(serial_no)=upper(btrim(p_code)) FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION '序號尚未入庫，請先登記到貨'; END IF;
     IF s.item_id<>l.item_id THEN RAISE EXCEPTION '序號型號與訂單品項不符'; END IF;
     IF p_action='bind' THEN
       IF s.status NOT IN ('in_stock','reserved') OR (s.order_id IS NOT NULL AND (s.order_id<>o.id OR s.order_line_key IS DISTINCT FROM p_line_key)) THEN RAISE EXCEPTION '序號已售出、停用或綁定其他訂單品項'; END IF;
       SELECT count(*) INTO v_qty FROM public.inventory_serials WHERE order_id=o.id AND order_line_key=p_line_key AND assembled_at IS NOT NULL AND serial_no<>s.serial_no;
       IF v_qty>=l.qty THEN RAISE EXCEPTION '核對數量已達訂單數量'; END IF;
       UPDATE public.inventory_serials SET order_id=o.id,order_line_key=p_line_key,status='reserved',assembled_at=now(),updated_at=now() WHERE serial_no=s.serial_no;
     ELSE
       IF s.order_id IS DISTINCT FROM o.id OR s.order_line_key IS DISTINCT FROM p_line_key OR s.status<>'reserved' THEN RAISE EXCEPTION '此序號未綁定本訂單品項'; END IF;
       -- Receipt-dedicated stock remains reserved; only remove assembly confirmation.
       UPDATE public.inventory_serials SET assembled_at=NULL,updated_at=now() WHERE serial_no=s.serial_no;
       IF coalesce(s.purchase_order_id,'')='' THEN UPDATE public.inventory_serials SET order_id=NULL,order_line_key=NULL,status='in_stock' WHERE serial_no=s.serial_no; END IF;
     END IF;
   ELSE
     IF length(btrim(p_note))<5 THEN RAISE EXCEPTION '無序號原因至少 5 個字'; END IF;
     IF EXISTS(SELECT 1 FROM public.inventory_serials WHERE item_id=l.item_id AND status IN ('in_stock','reserved')) THEN RAISE EXCEPTION '此品項已有序號紀錄，請掃序號核對'; END IF;
   END IF;
   INSERT INTO public.order_scan_checks(order_id) VALUES(o.id) ON CONFLICT DO NOTHING;
   UPDATE public.order_scan_checks SET tested_signature=NULL,ship_checked=false,updated_at=now(),exceptions=CASE WHEN p_action='waive' THEN exceptions||jsonb_build_object(p_line_key,jsonb_build_object('item_id',l.item_id,'qty',l.qty,'note',p_note)) ELSE exceptions-p_line_key END WHERE order_id=o.id;
 END IF;
 SELECT * INTO c FROM public.order_scan_checks WHERE order_id=o.id;
 SELECT md5(coalesce(jsonb_agg(jsonb_build_array(id,item_id,qty,extra->>'line_key') ORDER BY id)::text,'')) INTO v_signature FROM public.order_items WHERE order_id=o.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('line_key',coalesce(a.extra->>'line_key',substr(a.id,length(o.id)+2)),'name',a.name,'qty',a.qty,
   'serials',coalesce((SELECT jsonb_agg(x.serial_no ORDER BY x.serial_no) FROM public.inventory_serials x WHERE x.order_id=o.id AND x.item_id=a.item_id AND x.order_line_key=coalesce(a.extra->>'line_key',substr(a.id,length(o.id)+2)) AND x.assembled_at IS NOT NULL AND x.status IN ('reserved','sold')),'[]'::jsonb),
   'exception',CASE WHEN c.exceptions->coalesce(a.extra->>'line_key',substr(a.id,length(o.id)+2))->>'item_id'=a.item_id AND (c.exceptions->coalesce(a.extra->>'line_key',substr(a.id,length(o.id)+2))->>'qty')::numeric=a.qty THEN c.exceptions->coalesce(a.extra->>'line_key',substr(a.id,length(o.id)+2))->>'note' ELSE NULL END) ORDER BY a.id),'[]'::jsonb) INTO v_lines FROM public.order_items a WHERE a.order_id=o.id AND a.item_id IS NOT NULL;
 IF p_action IN ('test','ship') THEN
   IF c.order_id IS NULL THEN RAISE EXCEPTION '請先逐項核對零件'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_lines) j WHERE (j->>'exception') IS NULL AND jsonb_array_length(j->'serials')<>(j->>'qty')::numeric) THEN RAISE EXCEPTION '尚有零件未核對完成'; END IF;
   IF EXISTS(SELECT 1 FROM public.order_items WHERE order_id=o.id AND extra->>'fulfillment_type'='procurement') THEN RAISE EXCEPTION '尚有零件未到貨'; END IF;
   IF p_action='test' THEN
     IF length(btrim(p_note))<5 THEN RAISE EXCEPTION '請填寫至少 5 個字的檢測紀錄'; END IF;
     UPDATE public.order_scan_checks SET tested_signature=v_signature,test_note=p_note,ship_checked=false,updated_at=now() WHERE order_id=o.id;
   ELSE
     IF c.tested_signature IS DISTINCT FROM v_signature THEN RAISE EXCEPTION '請先登記目前配置的測試結果'; END IF;
     IF upper(btrim(p_code))<>upper(o.order_no) THEN RAISE EXCEPTION '掃描的訂單編號不符'; END IF;
     UPDATE public.order_scan_checks SET ship_checked=true,updated_at=now() WHERE order_id=o.id;
   END IF;
 END IF;
 SELECT * INTO c FROM public.order_scan_checks WHERE order_id=o.id;
 RETURN jsonb_build_object('enabled',c.order_id IS NOT NULL,'lines',v_lines,'tested',coalesce(c.tested_signature=v_signature,false),'ship_checked',coalesce(c.ship_checked AND c.tested_signature=v_signature,false));
END $$;
REVOKE ALL ON FUNCTION public.backoffice_scan_operation(text,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.backoffice_scan_operation(text,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_scan_order_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; c public.order_scan_checks; r jsonb;
BEGIN
 SELECT * INTO o FROM public.orders WHERE id=NEW.id;
 SELECT * INTO c FROM public.order_scan_checks WHERE order_id=NEW.id;
 IF c.order_id IS NULL THEN RETURN NULL; END IF;
 IF o.status IN ('shipped','completed') THEN
   r:=public.backoffice_scan_operation('read',o.id);
   IF NOT coalesce((r->>'tested')::boolean,false) OR NOT coalesce((r->>'ship_checked')::boolean,false) THEN RAISE EXCEPTION '掃碼訂單尚未完成測試及出貨編號核對'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'lines') j WHERE j->>'exception' IS NULL AND jsonb_array_length(j->'serials')<>(j->>'qty')::numeric) THEN RAISE EXCEPTION '掃碼訂單零件核對未完成'; END IF;
   IF coalesce(o.extra->>'payment_status','unpaid')<>'paid' OR coalesce((o.extra->>'received_amount')::numeric,0)<o.total_sale+o.shipping_income-o.discount THEN RAISE EXCEPTION '掃碼出貨前請確認全額收款'; END IF;
   UPDATE public.inventory_serials SET status='sold',updated_at=now() WHERE order_id=o.id AND status='reserved';
 ELSIF o.status IN ('cancelled','lost') THEN
   UPDATE public.inventory_serials SET status='in_stock',order_id=NULL,order_line_key=NULL,assembled_at=NULL,updated_at=now() WHERE order_id=o.id AND status='reserved';
 ELSIF o.status='refunded' THEN
   UPDATE public.inventory_serials SET status='returned',updated_at=now() WHERE order_id=o.id AND status='sold';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_scan_order_completion() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS scan_order_completion ON public.orders;
CREATE CONSTRAINT TRIGGER scan_order_completion AFTER INSERT OR UPDATE ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_scan_order_completion();
CREATE OR REPLACE FUNCTION public.backoffice_receive_scanned_purchase(p_row jsonb,p_expected_updated_at text,p_action jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb; i jsonb; a jsonb; po public.purchase_orders; serials jsonb:=coalesce(p_action->'serial_numbers','[]'::jsonb);
BEGIN
 IF public.dk_require_backoffice() IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'admin only'; END IF;
 IF p_action->>'type' IS DISTINCT FROM 'receive' OR jsonb_typeof(serials)<>'array' THEN RAISE EXCEPTION 'invalid scanned receipt'; END IF;
 r:=public.backoffice_purchase_operation(p_row,p_expected_updated_at,p_action);
 SELECT x INTO i FROM jsonb_array_elements(r->'purchase_order'->'items_json') x WHERE x->>'id'=p_action->>'purchase_item_id';
 IF i IS NULL THEN RAISE EXCEPTION 'purchase item missing'; END IF;
 IF jsonb_array_length(serials)>(i->>'quantity')::numeric THEN RAISE EXCEPTION '序號數量不可超過到貨數量'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(serials) x WHERE btrim(x)='') THEN RAISE EXCEPTION '序號不可為空白'; END IF;
 PERFORM public.backoffice_register_receipt_serials(i->>'receiptInventoryItemId',p_row->>'id',i->>'id',
 CASE WHEN p_action->>'destination'='customer' THEN i->>'sourceSalesOrderId' ELSE '' END,
 CASE WHEN p_action->>'destination'='customer' THEN i->>'sourceSalesOrderLineKey' ELSE '' END,
 (p_action->>'received_at')::date,serials,coalesce(p_action->>'note',''));
 SELECT jsonb_agg(CASE WHEN x->>'id'=i->>'id' THEN x||jsonb_build_object('serialNumbers',serials) ELSE x END ORDER BY n) INTO a FROM jsonb_array_elements(r->'purchase_order'->'items_json') WITH ORDINALITY t(x,n);
 UPDATE public.purchase_orders SET items_json=a,data_json=data_json||jsonb_build_object('items',a) WHERE id=p_row->>'id' RETURNING * INTO po;
 RETURN jsonb_build_object('purchase_order',to_jsonb(po),'operation',(r->'operation')||jsonb_build_object('serials_registered',true));
END $$;
REVOKE ALL ON FUNCTION public.backoffice_receive_scanned_purchase(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_receive_scanned_purchase(jsonb,text,jsonb) TO authenticated;

COMMIT;
