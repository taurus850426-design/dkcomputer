-- Explicit, one physical system per SKU. No historical stock/funding backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS public.inventory_assemblies (
 id uuid PRIMARY KEY, request_key uuid NOT NULL UNIQUE, request_hash text NOT NULL,
 item_id text NOT NULL UNIQUE REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 serial_no text NOT NULL, name text NOT NULL, state text NOT NULL CHECK(state IN ('building','ready','disassembling','disassembled')),
 material_cost numeric NOT NULL CHECK(material_cost>0), funding jsonb NOT NULL, parts jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(), disassembled_at timestamptz
);
ALTER TABLE public.inventory_assemblies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_assemblies FROM PUBLIC,anon,authenticated;
ALTER TABLE public.inventory_serials ADD COLUMN IF NOT EXISTS assembly_id uuid REFERENCES public.inventory_assemblies(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS inventory_serials_assembly_idx ON public.inventory_serials(assembly_id) WHERE assembly_id IS NOT NULL;
ALTER TABLE public.inventory_serials DROP CONSTRAINT IF EXISTS inventory_serials_status_check;
ALTER TABLE public.inventory_serials ADD CONSTRAINT inventory_serials_status_check CHECK(status IN ('in_stock','reserved','sold','returned','void','assembled'));

CREATE OR REPLACE FUNCTION public.dk_assembly_plan(p_payload jsonb,p_lock boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE line jsonb; item public.inventory_items; cost numeric; lots jsonb; signatures jsonb:='[]'; parts jsonb:='[]';
 qty numeric; need numeric; take numeric; lot record; sn text; sns jsonb; serial_snap jsonb; b numeric:=0; h numeric:=0; total numeric:=0; condition text:='NEW';
BEGIN
 IF jsonb_typeof(p_payload->'parts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'parts') NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION '請選擇 1 至 40 種實際零件'; END IF;
 IF (SELECT count(DISTINCT x->>'item_id') FROM jsonb_array_elements(p_payload->'parts') x)<>jsonb_array_length(p_payload->'parts') THEN RAISE EXCEPTION '相同零件請合併數量，不能重複加入'; END IF;
 FOR line IN SELECT x FROM jsonb_array_elements(p_payload->'parts') x ORDER BY x->>'item_id' LOOP
  IF coalesce(line->>'qty','') !~ '^[1-9][0-9]{0,2}$' THEN RAISE EXCEPTION '零件數量須為 1 至 999 的整數'; END IF; qty:=(line->>'qty')::numeric;
  IF p_lock THEN PERFORM public.dk_inbound_lock_item(line->>'item_id'); END IF;
  SELECT * INTO item FROM public.inventory_items WHERE id=line->>'item_id';
  IF NOT FOUND OR item.qty_on_hand<qty OR item.is_archived OR item.status IS DISTINCT FROM 'READY' THEN RAISE EXCEPTION '零件庫存或狀態已變更，請重新核對'; END IF;
  IF item.exclude_from_inventory_value OR item.category='整機' OR EXISTS(SELECT 1 FROM public.inventory_assemblies WHERE item_id=item.id) THEN RAISE EXCEPTION '請使用資產零件，不能把非資產或另一台整機加入'; END IF;
  SELECT cost_unit INTO cost FROM public.inventory_costs WHERE item_id=item.id;
  IF cost IS NULL OR cost<=0 OR EXISTS(SELECT 1 FROM public.inventory_ledger WHERE item_id=item.id AND cost_status='pending') THEN RAISE EXCEPTION '零件成本尚未確認，請先補齊正式入庫成本'; END IF;
  IF item.condition IS DISTINCT FROM 'NEW' THEN condition:='USED'; END IF;
  IF p_lock THEN PERFORM 1 FROM public.inventory_funding_lots WHERE item_id=item.id AND qty_remaining>0 ORDER BY CASE owner WHEN 'boss' THEN 0 ELSE 1 END,business_date,created_at,id FOR UPDATE; END IF;
  lots:='[]';need:=qty;
  FOR lot IN SELECT * FROM public.inventory_funding_lots WHERE item_id=item.id AND qty_remaining>0 ORDER BY CASE owner WHEN 'boss' THEN 0 ELSE 1 END,business_date,created_at,id LOOP
   EXIT WHEN need<=0;take:=least(need,lot.qty_remaining);
   IF lot.unit_cost<=0 THEN RAISE EXCEPTION '零件出資本金尚未確認，不能推定 BOSS／HALA'; END IF;
   lots:=lots||jsonb_build_array(jsonb_build_object('id',lot.id,'owner',lot.owner,'qty',take,'available',lot.qty_remaining,'unit_cost',lot.unit_cost));
   IF lot.owner='boss' THEN b:=b+take*lot.unit_cost;ELSE h:=h+take*lot.unit_cost;END IF;need:=need-take;
  END LOOP;
  IF need>0 THEN RAISE EXCEPTION '零件出資批次不足，請先核對原庫存，不能自動指定 HALA'; END IF;
  sns:=coalesce(line->'serials','[]');
  IF jsonb_typeof(sns) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '序號格式錯誤'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(sns) x WHERE jsonb_typeof(x)<>'string') THEN RAISE EXCEPTION '序號須為文字'; END IF;
  IF jsonb_array_length(sns)<>qty AND jsonb_array_length(sns)<>0 THEN RAISE EXCEPTION '已登記序號的零件須逐件核對，數量不符'; END IF;
  IF jsonb_array_length(sns)=0 THEN
   IF length(btrim(coalesce(line->>'serial_note',''))) NOT BETWEEN 5 AND 200 THEN RAISE EXCEPTION '沒有序號時請填 5 至 200 字的原因'; END IF;
   IF EXISTS(SELECT 1 FROM public.inventory_serials WHERE item_id=item.id AND status='in_stock') THEN RAISE EXCEPTION '此零件已有序號，請選取實際裝入的序號'; END IF;
  END IF;
  IF (SELECT count(DISTINCT upper(btrim(value))) FROM jsonb_array_elements_text(sns))<>jsonb_array_length(sns) THEN RAISE EXCEPTION '序號重複'; END IF;
  serial_snap:='[]';
  FOR sn IN SELECT btrim(value) FROM jsonb_array_elements_text(sns) ORDER BY upper(btrim(value)) LOOP
   IF p_lock THEN PERFORM 1 FROM public.inventory_serials WHERE upper(serial_no)=upper(sn) FOR UPDATE; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.inventory_serials WHERE upper(serial_no)=upper(sn) AND item_id=item.id AND status='in_stock' AND order_id IS NULL AND assembly_id IS NULL) THEN RAISE EXCEPTION '序號型號不符、已預留或已組入其他整機：%',sn; END IF;
   SELECT serial_snap||jsonb_build_array(jsonb_build_object('serial_no',serial_no,'updated_at',updated_at)) INTO serial_snap FROM public.inventory_serials WHERE upper(serial_no)=upper(sn);
  END LOOP;
  signatures:=signatures||jsonb_build_array(jsonb_build_object('item_id',item.id,'version',item.updated_at,'cost',cost,'lots',lots,'serials',serial_snap));
  parts:=parts||jsonb_build_array(jsonb_build_object('item_id',item.id,'name',item.name,'category',item.category,'qty',qty,'unit_cost',cost,'available_qty',item.qty_on_hand,'serials',(SELECT coalesce(jsonb_agg(x->>'serial_no'),'[]') FROM jsonb_array_elements(serial_snap) x),'serial_note',left(coalesce(line->>'serial_note',''),200)));
  total:=total+qty*cost;
 END LOOP;
 RETURN jsonb_build_object('parts',parts,'material_cost',total,'condition',condition,'funding',jsonb_build_object('boss',b,'hala',h),'signature',md5(signatures::text));
END $$;
REVOKE ALL ON FUNCTION public.dk_assembly_plan(jsonb,boolean) FROM PUBLIC,anon,authenticated;

-- Ordinary items retain their existing cost-sync rule. A one-unit assembled SKU carries
-- separate BOSS/HALA principal segments, whose costs must not be flattened to book cost.
CREATE OR REPLACE FUNCTION public.dk_sync_open_funding_lot_cost() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.inventory_assemblies WHERE item_id=NEW.item_id OR (state IN ('building','disassembling') AND parts @> jsonb_build_array(jsonb_build_object('item_id',NEW.item_id)))) THEN RETURN NEW; END IF;
 UPDATE public.inventory_funding_lots SET unit_cost=coalesce(NEW.cost_unit,0) WHERE item_id=NEW.item_id AND qty_remaining>0;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dk_sync_open_funding_lot_cost() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.dk_protect_assembled_inventory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.inventory_assemblies; units numeric; amount numeric;
BEGIN
 SELECT * INTO a FROM public.inventory_assemblies WHERE item_id=NEW.item_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='inventory_costs' THEN
  IF NEW.cost_unit IS DISTINCT FROM a.material_cost THEN RAISE EXCEPTION '預組整機成本由零件轉入，不能直接改價；售價可另行修改'; END IF;
 ELSIF TG_TABLE_NAME='inventory_ledger' THEN
  IF NOT (NEW.movement_type IN ('SALE','SALE_RETURN') OR (a.state='building' AND NEW.source_type='ASSEMBLY' AND NEW.movement_type='MANUAL_IN' AND NEW.qty=1) OR (a.state='disassembling' AND NEW.source_type='ASSEMBLY_UNDO' AND NEW.movement_type='MANUAL_OUT' AND NEW.qty=-1)) THEN RAISE EXCEPTION '預組整機不可手動增減或修正入庫，請使用整機轉換或未售拆回'; END IF;
 ELSIF TG_TABLE_NAME='inventory_funding_lots' THEN
  IF TG_OP='UPDATE' THEN
   IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost OR NEW.qty_received IS DISTINCT FROM OLD.qty_received THEN RAISE EXCEPTION '預組整機出資由原零件帶入，不能重新歸屬'; END IF;
  ELSE
   units:=CASE WHEN (a.funding->>'boss')::numeric>0 AND (a.funding->>'hala')::numeric>0 THEN 0.5 ELSE 1 END;
   amount:=(a.funding->>NEW.owner)::numeric;
   IF a.state<>'building' OR NEW.source_key IS DISTINCT FROM 'assembly:'||a.id::text||':'||NEW.owner OR NEW.source_ledger_id IS NOT NULL OR NEW.qty_received<>units OR NEW.qty_remaining<>units OR NEW.unit_cost IS DISTINCT FROM amount/units THEN RAISE EXCEPTION '預組整機不能另外新增出資批次'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dk_protect_assembled_inventory() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS assembled_cost_guard ON public.inventory_costs;
CREATE TRIGGER assembled_cost_guard BEFORE UPDATE ON public.inventory_costs FOR EACH ROW EXECUTE FUNCTION public.dk_protect_assembled_inventory();
DROP TRIGGER IF EXISTS assembled_ledger_guard ON public.inventory_ledger;
CREATE TRIGGER assembled_ledger_guard BEFORE INSERT ON public.inventory_ledger FOR EACH ROW EXECUTE FUNCTION public.dk_protect_assembled_inventory();
DROP TRIGGER IF EXISTS assembled_funding_guard ON public.inventory_funding_lots;
CREATE TRIGGER assembled_funding_guard BEFORE INSERT OR UPDATE ON public.inventory_funding_lots FOR EACH ROW EXECUTE FUNCTION public.dk_protect_assembled_inventory();

CREATE OR REPLACE FUNCTION public.dk_protect_assembled_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.inventory_assemblies WHERE item_id=NEW.id) AND (NEW.sku IS DISTINCT FROM OLD.sku OR NEW.condition IS DISTINCT FROM OLD.condition OR NEW.qty_on_hand NOT IN (0,1) OR NEW.category IS DISTINCT FROM '整機' OR NEW.exclude_from_inventory_value) THEN RAISE EXCEPTION '預組整機每個編號只有一台，並須保留整機資產分類'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dk_protect_assembled_item() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS assembled_item_guard ON public.inventory_items;
CREATE TRIGGER assembled_item_guard BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION public.dk_protect_assembled_item();
CREATE OR REPLACE FUNCTION public.dk_protect_assembled_order_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.inventory_assemblies WHERE item_id=NEW.item_id) AND NEW.qty<>1 THEN RAISE EXCEPTION '每台預組整機須以一台獨立編號出售，不能拆成小數數量'; END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dk_protect_assembled_order_line() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS assembled_order_qty_guard ON public.order_items;
CREATE TRIGGER assembled_order_qty_guard BEFORE INSERT OR UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.dk_protect_assembled_order_line();

-- Reserve the known whole-system serial even through the ordinary (non-scanning) order UI.
-- This records provenance without pretending that assembly/test checks were performed.
CREATE OR REPLACE FUNCTION public.dk_sync_assembled_order_serial() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.orders; row record; serial public.inventory_serials; line_key text;
BEGIN
 SELECT * INTO o FROM public.orders WHERE id=NEW.id;
 FOR row IN SELECT a.item_id,a.serial_no FROM public.inventory_assemblies a JOIN public.inventory_serials s ON s.serial_no=a.serial_no WHERE s.order_id=o.id OR EXISTS(SELECT 1 FROM public.order_items WHERE order_id=o.id AND item_id=a.item_id) ORDER BY a.item_id LOOP
  SELECT * INTO serial FROM public.inventory_serials WHERE serial_no=row.serial_no FOR UPDATE;
  SELECT coalesce(extra->>'line_key',substr(id,length(o.id)+2)) INTO line_key FROM public.order_items WHERE order_id=o.id AND item_id=row.item_id;
  IF line_key IS NOT NULL AND o.status IN ('confirmed','pending','paid','shipped','completed') THEN
   IF serial.status NOT IN ('in_stock','reserved','sold') OR (serial.order_id IS NOT NULL AND serial.order_id<>o.id) THEN RAISE EXCEPTION '整機序號已被其他訂單使用或尚待退貨驗收，請先核對'; END IF;
   UPDATE public.inventory_serials SET order_id=o.id,order_line_key=line_key,status=CASE WHEN o.status IN ('shipped','completed') THEN 'sold' ELSE 'reserved' END,updated_at=now() WHERE serial_no=row.serial_no;
  ELSIF o.status='refunded' AND serial.order_id=o.id THEN
   UPDATE public.inventory_serials SET status='returned',updated_at=now() WHERE serial_no=row.serial_no;
  ELSIF serial.order_id=o.id AND serial.status='reserved' THEN
   UPDATE public.inventory_serials SET status='in_stock',order_id=NULL,order_line_key=NULL,assembled_at=NULL,updated_at=now() WHERE serial_no=row.serial_no;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dk_sync_assembled_order_serial() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS assembly_order_serial_sync ON public.orders;
CREATE CONSTRAINT TRIGGER assembly_order_serial_sync AFTER INSERT OR UPDATE ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.dk_sync_assembled_order_serial();

CREATE OR REPLACE FUNCTION public.backoffice_assembly_operation(p_action text,p_key uuid,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.inventory_assemblies; plan jsonb; part jsonb; result jsonb; records jsonb:='[]'; lid text; aid uuid; iid text; sn text; owner text; units numeric; amount numeric; alloc record;
BEGIN
 IF public.dk_require_backoffice()<>'admin' OR NOT public.is_admin() THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 IF p_action='list' THEN
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (SELECT t.id,t.item_id,t.name,t.serial_no,t.state,t.material_cost,t.funding,t.parts,t.created_at,i.qty_on_hand,s.status AS serial_status FROM public.inventory_assemblies t JOIN public.inventory_items i ON i.id=t.item_id LEFT JOIN public.inventory_serials s ON s.serial_no=t.serial_no ORDER BY t.created_at DESC LIMIT 100) x),'[]');
 END IF;
 IF p_action='trace' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('整機序號',t.serial_no,'名稱',t.name,'組裝狀態',t.state,'整機序號狀態',s.status,'訂單編號',o.order_no,'零件',t.parts) ORDER BY (t.state='disassembled'),t.created_at DESC) FROM public.inventory_assemblies t LEFT JOIN public.inventory_serials s ON s.serial_no=t.serial_no LEFT JOIN public.orders o ON o.id=s.order_id WHERE upper(t.serial_no)=upper(btrim(p_payload->>'serial')) OR t.id IN (SELECT assembly_id FROM public.inventory_serials WHERE upper(serial_no)=upper(btrim(p_payload->>'serial'))) OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.parts) p_doc(part_snapshot) CROSS JOIN LATERAL jsonb_array_elements_text(p_doc.part_snapshot->'serials') sn_code(value) WHERE upper(sn_code.value)=upper(btrim(p_payload->>'serial')))),'[]');
 END IF;
 IF p_action='preview' THEN RETURN public.dk_assembly_plan(p_payload,false); END IF;
 IF p_action='create' THEN
  IF p_key IS NULL THEN RAISE EXCEPTION '轉換識別碼不可為空'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('assembly:'||p_key::text,0));
  SELECT * INTO a FROM public.inventory_assemblies WHERE request_key=p_key;
  IF FOUND THEN
   IF a.request_hash IS DISTINCT FROM md5((p_payload-'signature'-'reviewed')::text) THEN RAISE EXCEPTION '識別碼已用於其他內容，請先查詢轉換紀錄'; END IF;
   RETURN jsonb_build_object('item_id',a.item_id,'serial_no',a.serial_no,'id',a.id,'idempotent',true);
  END IF;
  IF p_payload->>'reviewed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '請先核對實際組裝內容及成本後確認'; END IF;
  sn:=upper(btrim(coalesce(p_payload->>'serial_no','')));
  IF sn !~ '^[A-Z0-9][A-Z0-9._/-]{3,79}$' OR length(btrim(coalesce(p_payload->>'name',''))) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION '請填有效整機名稱及 4 至 80 字元英數序號'; END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_serials WHERE upper(serial_no)=sn) THEN RAISE EXCEPTION '整機序號已存在，請先查詢'; END IF;
  plan:=public.dk_assembly_plan(p_payload,true);
  IF plan->>'signature' IS DISTINCT FROM p_payload->>'signature' THEN RAISE EXCEPTION '零件、成本、出資或序號已更新，請重新預覽核對'; END IF;
  aid:=gen_random_uuid();iid:='asm-'||replace(aid::text,'-','');
  INSERT INTO public.inventory_items(id,sku,name,category,condition,status,qty_on_hand,inbound_date,extra) VALUES(iid,sn,btrim(p_payload->>'name'),'整機',plan->>'condition','READY',0,public.dk_taiwan_today(),jsonb_build_object('assembly_id',aid));
  INSERT INTO public.inventory_assemblies(id,request_key,request_hash,item_id,serial_no,name,state,material_cost,funding,parts,created_by) VALUES(aid,p_key,md5((p_payload-'signature'-'reviewed')::text),iid,sn,btrim(p_payload->>'name'),'building',(plan->>'material_cost')::numeric,plan->'funding',plan->'parts',auth.uid());
  FOR part IN SELECT x FROM jsonb_array_elements(plan->'parts') x LOOP
   result:=public.backoffice_admin_adjust_stock(part->>'item_id',(part->>'qty')::numeric,'OUT',NULL,'組入整機 '||sn,NULL,NULL,'ASSEMBLY',aid::text||':'||(part->>'item_id'));
   lid:=result->>'ledger_id';
   IF (result->>'qty_on_hand')::numeric IS DISTINCT FROM (part->>'available_qty')::numeric-(part->>'qty')::numeric OR (SELECT cost_unit FROM public.inventory_costs WHERE item_id=part->>'item_id') IS DISTINCT FROM (part->>'unit_cost')::numeric THEN RAISE EXCEPTION '原零件重算與預覽不一致，請先核對原入庫紀錄'; END IF;
   UPDATE public.inventory_serials SET assembly_id=aid,status='assembled',updated_at=now() WHERE serial_no IN (SELECT value FROM jsonb_array_elements_text(part->'serials'));
   records:=records||jsonb_build_array(part||jsonb_build_object('outbound_ledger_id',lid));
  END LOOP;
  UPDATE public.inventory_assemblies SET parts=records WHERE id=aid;
  INSERT INTO public.inventory_costs(item_id,cost_unit) VALUES(iid,(plan->>'material_cost')::numeric);
  PERFORM public.backoffice_admin_adjust_stock(iid,1,'IN',(plan->>'material_cost')::numeric,'零件轉整機 '||sn,public.dk_taiwan_today(),NULL,'ASSEMBLY',aid::text||':whole');
  units:=CASE WHEN (plan->'funding'->>'boss')::numeric>0 AND (plan->'funding'->>'hala')::numeric>0 THEN 0.5 ELSE 1 END;
  FOREACH owner IN ARRAY ARRAY['boss','hala'] LOOP
   amount:=(plan->'funding'->>owner)::numeric;
   IF amount>0 THEN INSERT INTO public.inventory_funding_lots(id,item_id,source_key,owner,qty_received,qty_remaining,unit_cost,business_date) VALUES('FL-AS-'||aid::text||':'||owner,iid,'assembly:'||aid::text||':'||owner,owner,units,units,amount/units,public.dk_taiwan_today()); END IF;
  END LOOP;
  INSERT INTO public.inventory_serials(serial_no,item_id,received_at,status,note) VALUES(sn,iid,public.dk_taiwan_today(),'in_stock','預組整機；原零件序號保留於組裝紀錄');
  UPDATE public.inventory_assemblies SET state='ready' WHERE id=aid;
  RETURN jsonb_build_object('id',aid,'item_id',iid,'serial_no',sn,'idempotent',false);
 ELSIF p_action='disassemble' THEN
  SELECT * INTO a FROM public.inventory_assemblies WHERE id=p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '找不到整機轉換紀錄'; END IF;
  IF a.state='disassembled' THEN RETURN jsonb_build_object('id',a.id,'idempotent',true); END IF;
  IF p_payload->>'reviewed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '請確認已實際拆回零件'; END IF;
  PERFORM public.dk_inbound_lock_item(a.item_id);
  IF a.state<>'ready' OR NOT EXISTS(SELECT 1 FROM public.inventory_items WHERE id=a.item_id AND qty_on_hand=1) OR NOT EXISTS(SELECT 1 FROM public.inventory_serials WHERE serial_no=a.serial_no AND status='in_stock' AND order_id IS NULL) OR EXISTS(SELECT 1 FROM public.inventory_ledger WHERE item_id=a.item_id AND movement_type='SALE') OR EXISTS(SELECT 1 FROM public.order_items WHERE item_id=a.item_id) THEN RAISE EXCEPTION '此整機已預留、開單或出售，請先處理原訂單；售後退貨不能直接拆回'; END IF;
  FOR part IN SELECT x FROM jsonb_array_elements(a.parts) x ORDER BY x->>'item_id' LOOP PERFORM public.dk_inbound_lock_item(part->>'item_id'); END LOOP;
  UPDATE public.inventory_assemblies SET state='disassembling' WHERE id=a.id;
  PERFORM public.backoffice_admin_adjust_stock(a.item_id,1,'OUT',NULL,'未售整機拆回 '||a.serial_no,NULL,NULL,'ASSEMBLY_UNDO',a.id::text||':whole');
  FOR part IN SELECT x FROM jsonb_array_elements(a.parts) x LOOP
   FOR alloc IN SELECT f.id,f.lot_id,f.qty,f.unit_cost,f.owner,l.owner AS current_owner,l.unit_cost AS current_cost,f.reversed_qty FROM public.inventory_funding_allocations f JOIN public.inventory_funding_lots l ON l.id=f.lot_id WHERE f.outbound_ledger_id=part->>'outbound_ledger_id' FOR UPDATE OF f,l LOOP
    IF alloc.owner IS DISTINCT FROM alloc.current_owner OR alloc.unit_cost IS DISTINCT FROM alloc.current_cost OR alloc.reversed_qty<>0 THEN RAISE EXCEPTION '原零件出資批次已調整，請先核對，拆回未完成'; END IF;
    UPDATE public.inventory_funding_lots SET qty_remaining=qty_remaining+alloc.qty WHERE id=alloc.lot_id;
    UPDATE public.inventory_funding_allocations SET reversed_qty=qty WHERE id=alloc.id;
   END LOOP;
   PERFORM public.backoffice_admin_adjust_stock(part->>'item_id',(part->>'qty')::numeric,'IN',(part->>'unit_cost')::numeric,'未售整機拆回 '||a.serial_no,public.dk_taiwan_today(),NULL,'ASSEMBLY_UNDO',a.id::text||':'||(part->>'item_id'));
   UPDATE public.inventory_serials SET status='in_stock',assembly_id=NULL,updated_at=now() WHERE assembly_id=a.id AND item_id=part->>'item_id';
  END LOOP;
  UPDATE public.inventory_serials SET status='void',updated_at=now() WHERE serial_no=a.serial_no;
  UPDATE public.inventory_assemblies SET state='disassembled',disassembled_at=now() WHERE id=a.id;
  RETURN jsonb_build_object('id',a.id,'idempotent',false);
 END IF;
 RAISE EXCEPTION '不支援的整機作業';
END $$;
REVOKE ALL ON FUNCTION public.backoffice_assembly_operation(text,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.backoffice_assembly_operation(text,uuid,jsonb) TO authenticated;
COMMIT;
