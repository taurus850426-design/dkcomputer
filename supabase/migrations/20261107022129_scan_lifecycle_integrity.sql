-- Future operations only. No business-row backfill or deletion.
BEGIN;
CREATE OR REPLACE FUNCTION public.enforce_scan_order_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; c public.order_scan_checks; r jsonb;
BEGIN
 SELECT * INTO o FROM public.orders WHERE id=NEW.id;
 SELECT * INTO c FROM public.order_scan_checks WHERE order_id=NEW.id;
 IF o.status IN ('shipped','completed') THEN
   IF c.order_id IS NOT NULL THEN
   r:=public.backoffice_scan_operation('read',o.id);
   IF NOT coalesce((r->>'tested')::boolean,false) OR NOT coalesce((r->>'ship_checked')::boolean,false) THEN RAISE EXCEPTION '掃碼訂單尚未完成測試及出貨編號核對'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'lines') j WHERE j->>'exception' IS NULL AND jsonb_array_length(j->'serials')<>(j->>'qty')::numeric) THEN RAISE EXCEPTION '掃碼訂單零件核對未完成'; END IF;
   IF coalesce(o.extra->>'payment_status','unpaid')<>'paid' OR coalesce((o.extra->>'received_amount')::numeric,0)<o.total_sale+o.shipping_income-o.discount THEN RAISE EXCEPTION '掃碼出貨前請確認全額收款'; END IF;
   END IF;
   UPDATE public.inventory_serials SET status='sold',updated_at=now() WHERE order_id=o.id AND status='reserved';
 ELSIF o.status IN ('cancelled','lost') THEN
   UPDATE public.inventory_serials SET status='in_stock',order_id=NULL,order_line_key=NULL,assembled_at=NULL,updated_at=now() WHERE order_id=o.id AND status='reserved';
 ELSIF o.status='refunded' THEN
   UPDATE public.inventory_serials SET status='returned',updated_at=now() WHERE order_id=o.id AND status='sold';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_scan_order_completion() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.sync_receipt_serial_destination() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE x jsonb; prior jsonb;
BEGIN
 FOR x IN SELECT value FROM jsonb_array_elements(NEW.items_json) LOOP
  SELECT value INTO prior FROM jsonb_array_elements(OLD.items_json) WHERE value->>'id'=x->>'id';
  IF prior->>'procurementStatus'='received' AND x->>'procurementStatus'='received' AND prior->>'receiptDestination' IS DISTINCT FROM x->>'receiptDestination' THEN
   PERFORM 1 FROM public.inventory_serials WHERE purchase_order_id=NEW.id AND purchase_item_id=x->>'id' FOR UPDATE;
   IF EXISTS(SELECT 1 FROM public.inventory_serials WHERE purchase_order_id=NEW.id AND purchase_item_id=x->>'id' AND (assembled_at IS NOT NULL OR status NOT IN ('in_stock','reserved'))) THEN
    RAISE EXCEPTION '此到貨品項已有組裝核對或售後狀態，請先核對並解除組裝再修改用途';
   END IF;
   UPDATE public.inventory_serials SET
    order_id=CASE WHEN x->>'receiptDestination'='customer' THEN nullif(x->>'sourceSalesOrderId','') ELSE NULL END,
    order_line_key=CASE WHEN x->>'receiptDestination'='customer' THEN nullif(x->>'sourceSalesOrderLineKey','') ELSE NULL END,
    status=CASE WHEN x->>'receiptDestination'='customer' THEN 'reserved' ELSE 'in_stock' END,
    assembled_at=NULL,updated_at=now()
   WHERE purchase_order_id=NEW.id AND purchase_item_id=x->>'id';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_receipt_serial_destination() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS receipt_serial_destination ON public.purchase_orders;
CREATE TRIGGER receipt_serial_destination AFTER UPDATE OF items_json ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.sync_receipt_serial_destination();

CREATE OR REPLACE FUNCTION public.backoffice_register_receipt_serials(
 p_item_id text,p_purchase_order_id text,p_purchase_item_id text,p_order_id text,p_order_line_key text,
 p_received_at date,p_serials jsonb,p_note text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serial text; v_status text; v_count integer:=0; v_existing integer; po public.purchase_orders; i jsonb; order_status text;
BEGIN
 PERFORM public.dk_require_backoffice();
 IF jsonb_typeof(p_serials) IS DISTINCT FROM 'array' OR jsonb_array_length(p_serials)=0 THEN RAISE EXCEPTION 'serials must be non-empty array'; END IF;
 SELECT * INTO po FROM public.purchase_orders WHERE id=p_purchase_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'purchase receipt document required'; END IF;
 SELECT value INTO i FROM jsonb_array_elements(po.items_json) WHERE value->>'id'=p_purchase_item_id;
 IF i IS NULL OR i->>'procurementStatus' IS DISTINCT FROM 'received' OR i->>'receiptInventoryItemId' IS DISTINCT FROM p_item_id THEN RAISE EXCEPTION '序號品項與已到貨紀錄不符'; END IF;
 IF i->>'receiptDestination'='customer' THEN
  IF nullif(p_order_id,'') IS DISTINCT FROM nullif(i->>'sourceSalesOrderId','') OR nullif(p_order_line_key,'') IS DISTINCT FROM nullif(i->>'sourceSalesOrderLineKey','') THEN RAISE EXCEPTION '序號綁定與到貨用途不符'; END IF;
  SELECT status INTO order_status FROM public.orders WHERE id=p_order_id;
  IF NOT FOUND OR order_status IN ('cancelled','lost') THEN RAISE EXCEPTION 'invalid receipt order'; END IF;
  v_status:=CASE WHEN order_status IN ('shipped','completed') THEN 'sold' WHEN order_status='refunded' THEN 'returned' ELSE 'reserved' END;
 ELSE
  IF coalesce(p_order_id,'')<>'' OR coalesce(p_order_line_key,'')<>'' THEN RAISE EXCEPTION '一般庫存不可綁定客戶訂單'; END IF;
  v_status:='in_stock';
 END IF;
 SELECT count(*) INTO v_existing FROM public.inventory_serials WHERE purchase_order_id=p_purchase_order_id AND purchase_item_id=p_purchase_item_id;
 IF v_existing+jsonb_array_length(p_serials)>(i->>'quantity')::numeric THEN RAISE EXCEPTION '累計序號數量超過實際到貨數量'; END IF;
 FOR v_serial IN SELECT btrim(value) FROM jsonb_array_elements_text(p_serials) LOOP
  IF v_serial='' THEN RAISE EXCEPTION '序號不可為空白'; END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_serials WHERE upper(serial_no)=upper(v_serial)) THEN RAISE EXCEPTION 'duplicate serial number: %',v_serial; END IF;
  INSERT INTO public.inventory_serials(serial_no,item_id,purchase_order_id,purchase_item_id,order_id,order_line_key,received_at,status,note)
  VALUES(v_serial,p_item_id,p_purchase_order_id,p_purchase_item_id,nullif(p_order_id,''),nullif(p_order_line_key,''),p_received_at,v_status,coalesce(p_note,''));
  v_count:=v_count+1;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'count',v_count);
END $$;
REVOKE ALL ON FUNCTION public.backoffice_register_receipt_serials(text,text,text,text,text,date,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_register_receipt_serials(text,text,text,text,text,date,jsonb,text) TO authenticated;
COMMIT;
