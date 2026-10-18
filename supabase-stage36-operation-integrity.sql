-- Stage 36: atomic purchase writes and optimistic order editing.
-- Review and run manually BEFORE deploying the matching frontend.
-- No backfill, DELETE, or UPDATE of existing business rows occurs on installation.
BEGIN;
DO $$ DECLARE v_missing TEXT; BEGIN
  SELECT pg_catalog.string_agg(signature,', ') INTO v_missing FROM (VALUES
    ('public.dk_require_backoffice()'),
    ('public.backoffice_create_order_v2(text,text,text,text,text,numeric,numeric,text,text,jsonb)'),
    ('public.backoffice_update_order_v2(text,text,text,text,text,text,numeric,numeric,text,text,jsonb)'),
    ('public.backoffice_sync_procurement_cost(text,text,numeric,text,text,date)'),
    ('public.backoffice_clear_procurement_cost(text,text)'),
    ('public.backoffice_receive_purchase_item(text,text,text,text,text,text,text,numeric,numeric,text,date,text)'),
    ('public.backoffice_set_purchase_receipt_destination(text,text,text,text,text,text)'),
    ('public.backoffice_set_order_operations(text,text,numeric,date,text,text,date,text)'),
    ('public.backoffice_set_order_quote_note(text,text)'),
    ('public.backoffice_set_order_customer_source(text,text)')
  ) required(signature) WHERE to_regprocedure(signature) IS NULL;
  IF to_regclass('public.purchase_orders') IS NULL OR v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Stage 36 preflight: missing purchase_orders or functions: %',v_missing;
  END IF;
END $$;

-- Compare legacy optional/default fields without rewriting received snapshots.
CREATE OR REPLACE FUNCTION public.dk_purchase_item_comparable(p_item JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT '{"requestText":"","category":"","quantity":1,"selectedVendor":"","selectedQuoteId":null,
    "selectedSpec":"","selectedUnitPrice":null,"quotedAt":"","manualVendor":"","manualUnitPrice":null,
    "itemNote":"","procurementStatus":"pending","sourceSalesOrderId":"","sourceSalesOrderLineKey":"",
    "costSyncedAt":"","receivedAt":"","receiptDestination":"","receiptInventoryItemId":"","receiptLedgerId":"","receiptNote":""}'::jsonb
    || pg_catalog.jsonb_strip_nulls(COALESCE(p_item,'{}'::jsonb))
    || pg_catalog.jsonb_build_object('selectedQuoteId',NULLIF(p_item->>'selectedQuoteId',''),
      'quoteStatus',COALESCE(NULLIF(p_item->>'quoteStatus',''),CASE WHEN
        COALESCE(NULLIF(p_item->>'selectedUnitPrice','')::numeric,0)>0 OR COALESCE(NULLIF(p_item->>'manualUnitPrice','')::numeric,0)>0
        THEN 'quoted' ELSE 'pending' END));
$$;
REVOKE ALL ON FUNCTION public.dk_purchase_item_comparable(JSONB) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_purchase_operation(
  p_row JSONB, p_expected_updated_at TEXT, p_action JSONB DEFAULT '{"type":"save"}'::jsonb
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_old public.purchase_orders%ROWTYPE;
  v_new public.purchase_orders%ROWTYPE;
  v_exists BOOLEAN;
  v_type TEXT := COALESCE(p_action->>'type','save');
  v_item JSONB; v_previous JSONB; v_items JSONB; v_result JSONB := '{}'::jsonb;
  v_index INT; v_price NUMERIC; v_vendor TEXT; v_destination TEXT; v_stamp TIMESTAMPTZ;
BEGIN
  IF public.dk_require_backoffice() IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'admin only'; END IF;
  IF COALESCE(p_row->>'id','')='' OR pg_catalog.jsonb_typeof(p_row->'items_json') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'invalid purchase document'; END IF;
  IF v_type NOT IN ('save','receive','destination') THEN RAISE EXCEPTION 'invalid purchase operation'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dk-po:' || (p_row->>'id'),0));
  SELECT * INTO v_old FROM public.purchase_orders WHERE id=p_row->>'id' FOR UPDATE;
  v_exists := FOUND;
  IF v_exists THEN
    IF v_old.deleted_at IS NOT NULL THEN RAISE EXCEPTION '叫貨單已刪除，未重新建立'; END IF;
    IF p_expected_updated_at IS NULL OR
      (CASE WHEN p_expected_updated_at='legacy:null' THEN v_old.updated_at IS NOT NULL
            ELSE v_old.updated_at IS DISTINCT FROM p_expected_updated_at::timestamptz END) THEN
      RAISE EXCEPTION '單據已由其他裝置更新；雲端未覆蓋，請保留草稿並重新載入原單';
    END IF;
  ELSIF p_expected_updated_at IS NOT NULL OR v_type <> 'save' THEN
    RAISE EXCEPTION '原叫貨單不存在，未重新建立';
  END IF;
  v_new := pg_catalog.jsonb_populate_record(NULL::public.purchase_orders,p_row);
  IF v_new.status NOT IN ('draft','ordered','partial','received','cancelled') OR v_new.status IS NULL
    THEN RAISE EXCEPTION 'invalid purchase status'; END IF;
  IF v_exists AND NOT (
    v_new.status=v_old.status OR
    (v_old.status='draft' AND v_new.status IN ('ordered','cancelled')) OR
    (v_old.status='ordered' AND v_new.status IN ('partial','received','cancelled')) OR
    (v_old.status='partial' AND v_new.status='received')
  ) THEN RAISE EXCEPTION 'invalid purchase status transition'; END IF;
  IF v_exists THEN v_new.created_at := v_old.created_at; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x
    WHERE COALESCE(x->>'id','')='' OR COALESCE((x->>'quantity')::numeric,0)<=0)
    OR (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_new.items_json)) <>
       (SELECT count(DISTINCT x->>'id') FROM pg_catalog.jsonb_array_elements(v_new.items_json) x)
    THEN RAISE EXCEPTION 'invalid purchase item identifiers or quantities'; END IF;

  IF v_type IN ('receive','destination') THEN
    -- Never accept a stale client copy as the source of receipt quantities or costs.
    v_new := v_old;
    SELECT x, (n-1)::int INTO v_item,v_index
      FROM pg_catalog.jsonb_array_elements(v_old.items_json) WITH ORDINALITY t(x,n)
      WHERE x->>'id'=p_action->>'purchase_item_id';
    IF v_item IS NULL THEN RAISE EXCEPTION 'purchase item not found'; END IF;
    v_destination := p_action->>'destination';
    IF v_destination NOT IN ('customer','inventory') OR v_destination IS NULL THEN RAISE EXCEPTION 'invalid receipt destination'; END IF;
    IF v_type='receive' THEN
      IF v_old.status NOT IN ('ordered','partial') OR v_item->>'procurementStatus'='received'
        THEN RAISE EXCEPTION '品項已到貨或目前不可登記到貨；請重新核對原單'; END IF;
      v_price := COALESCE(CASE WHEN (v_item->>'selectedUnitPrice')::numeric>0 THEN (v_item->>'selectedUnitPrice')::numeric END,NULLIF(v_item->>'manualUnitPrice','')::numeric);
      v_vendor := COALESCE(NULLIF(v_item->>'selectedVendor',''),v_item->>'manualVendor','');
      v_result := public.backoffice_receive_purchase_item(
        CASE WHEN v_destination='customer' THEN COALESCE(v_item->>'sourceSalesOrderId','') ELSE '' END,
        CASE WHEN v_destination='customer' THEN COALESCE(v_item->>'sourceSalesOrderLineKey','') ELSE '' END,
        v_old.id,v_item->>'id',COALESCE(p_action->>'inventory_item_id',''),
        COALESCE(NULLIF(v_item->>'selectedSpec',''),v_item->>'requestText'),v_item->>'category',
        (v_item->>'quantity')::numeric,v_price,v_vendor,(p_action->>'received_at')::date,COALESCE(p_action->>'note',''));
      IF COALESCE((v_result->>'already_received')::boolean,false) THEN
        RAISE EXCEPTION '此品項已有入庫流水，但叫貨單狀態不一致；未重複入庫，請先核對原入庫紀錄';
      END IF;
      v_item := v_item || pg_catalog.jsonb_build_object('procurementStatus','received',
        'receivedAt',p_action->>'received_at','receiptDestination',v_destination,
        'receiptInventoryItemId',COALESCE(v_result->>'item_id',''),
        'receiptLedgerId',COALESCE(v_result->>'ledger_id',''),'receiptNote',COALESCE(p_action->>'note',''));
    ELSE
      IF v_item->>'procurementStatus' IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'purchase item not received'; END IF;
      v_result := public.backoffice_set_purchase_receipt_destination(
        COALESCE(v_item->>'sourceSalesOrderId',''),COALESCE(v_item->>'sourceSalesOrderLineKey',''),
        v_old.id,v_item->>'id',v_destination,COALESCE(p_action->>'note',''));
      v_item := v_item || pg_catalog.jsonb_build_object('receiptDestination',v_destination,'receiptNote',COALESCE(p_action->>'note',''));
    END IF;
    v_new.items_json := pg_catalog.jsonb_set(v_new.items_json,ARRAY[v_index::text],v_item);
    IF v_type='receive' THEN
      v_new.status := CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x
        WHERE x->>'procurementStatus' IS DISTINCT FROM 'received') THEN 'received' ELSE 'partial' END;
    END IF;
  ELSE
    -- Received snapshots cannot be edited/deleted by an ordinary save.
    FOR v_previous IN SELECT x FROM pg_catalog.jsonb_array_elements(COALESCE(v_old.items_json,'[]'::jsonb)) x LOOP
      v_item := NULL;
      SELECT x INTO v_item FROM pg_catalog.jsonb_array_elements(v_new.items_json) x WHERE x->>'id'=v_previous->>'id';
      IF (v_old.status='received' OR v_previous->>'procurementStatus'='received') AND (v_item IS NULL OR
        public.dk_purchase_item_comparable(v_item) IS DISTINCT FROM public.dk_purchase_item_comparable(v_previous))
        THEN RAISE EXCEPTION '已到貨品項不能由一般儲存改寫或移除；用途請使用修改用途'; END IF;
      IF v_item IS NULL AND COALESCE(v_previous->>'sourceSalesOrderId','')<>''
        AND COALESCE(v_previous->>'sourceSalesOrderLineKey','')<>'' THEN
        PERFORM public.backoffice_clear_procurement_cost(v_previous->>'sourceSalesOrderId',v_previous->>'sourceSalesOrderLineKey');
      END IF;
    END LOOP;
    v_items := '[]'::jsonb;
    FOR v_item IN SELECT x FROM pg_catalog.jsonb_array_elements(v_new.items_json) x LOOP
      v_previous := NULL;
      SELECT x INTO v_previous FROM pg_catalog.jsonb_array_elements(COALESCE(v_old.items_json,'[]'::jsonb)) x WHERE x->>'id'=v_item->>'id';
      IF v_old.status='received' AND v_previous IS NULL THEN RAISE EXCEPTION '已到貨整單不可新增品項'; END IF;
      IF COALESCE(v_item->>'procurementStatus','pending')='received' AND v_previous IS NULL
        THEN RAISE EXCEPTION '到貨必須使用登記到貨'; END IF;
      IF COALESCE(v_previous->>'procurementStatus','pending')<>'received' AND v_item->>'procurementStatus'='received'
        THEN RAISE EXCEPTION '到貨必須使用登記到貨'; END IF;
      IF v_previous IS NOT NULL AND (
        COALESCE(v_item->>'sourceSalesOrderId','')<>COALESCE(v_previous->>'sourceSalesOrderId','') OR
        COALESCE(v_item->>'sourceSalesOrderLineKey','')<>COALESCE(v_previous->>'sourceSalesOrderLineKey',''))
        THEN RAISE EXCEPTION '來源訂單不可直接更換；請取消原品項並另建'; END IF;
      IF v_old.status='received' OR v_previous->>'procurementStatus'='received' THEN v_item := v_previous; END IF;
      v_price := COALESCE(CASE WHEN (v_item->>'selectedUnitPrice')::numeric>0 THEN (v_item->>'selectedUnitPrice')::numeric END,NULLIF(v_item->>'manualUnitPrice','')::numeric,0);
      v_vendor := COALESCE(NULLIF(v_item->>'selectedVendor',''),v_item->>'manualVendor','');
      IF COALESCE(v_item->>'sourceSalesOrderId','')<>'' AND COALESCE(v_item->>'sourceSalesOrderLineKey','')<>''
        AND v_item->>'procurementStatus' IS DISTINCT FROM 'received' AND (
          v_previous IS NULL OR
          (v_item - ARRAY['itemNote','requestText','costSyncedAt']) IS DISTINCT FROM
          (v_previous - ARRAY['itemNote','requestText','costSyncedAt'])) THEN
        IF v_price>0 THEN
          PERFORM public.backoffice_sync_procurement_cost(v_item->>'sourceSalesOrderId',v_item->>'sourceSalesOrderLineKey',
            v_price,v_vendor,v_item->>'selectedQuoteId',NULLIF(v_item->>'quotedAt','')::date);
          v_item := v_item || pg_catalog.jsonb_build_object('costSyncedAt',pg_catalog.clock_timestamp());
        ELSIF v_previous IS NOT NULL THEN
          PERFORM public.backoffice_clear_procurement_cost(v_item->>'sourceSalesOrderId',v_item->>'sourceSalesOrderLineKey');
          v_item := v_item || '{"costSyncedAt":""}'::jsonb;
        END IF;
      END IF;
      v_items := v_items || pg_catalog.jsonb_build_array(v_item);
    END LOOP;
    v_new.items_json := v_items;
  END IF;
  IF v_new.status='received' AND v_old.status IS DISTINCT FROM 'received' AND (pg_catalog.jsonb_array_length(v_new.items_json)=0 OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x WHERE x->>'procurementStatus' IS DISTINCT FROM 'received'))
    THEN RAISE EXCEPTION '仍有未到貨品項，不能標記整單已到貨'; END IF;
  v_stamp := GREATEST(pg_catalog.clock_timestamp(),COALESCE(v_old.updated_at,pg_catalog.clock_timestamp()) + interval '1 microsecond');
  v_new.updated_at := v_stamp;
  v_new.data_json := COALESCE(v_new.data_json,'{}'::jsonb) || pg_catalog.jsonb_build_object(
    'id',v_new.id,'createdAt',v_new.created_at,'items',v_new.items_json,'status',v_new.status,'updatedAt',v_stamp,'cloudUpdatedAt',v_stamp);
  IF v_exists THEN
    UPDATE public.purchase_orders SET order_no=v_new.order_no,status=v_new.status,
      supplier_order_date=v_new.supplier_order_date,expected_date=v_new.expected_date,note=v_new.note,
      updated_at=v_stamp,items_json=v_new.items_json,deleted_at=v_new.deleted_at,data_json=v_new.data_json WHERE id=v_new.id;
  ELSE
    INSERT INTO public.purchase_orders SELECT v_new.*;
  END IF;
  RETURN pg_catalog.jsonb_build_object('purchase_order',pg_catalog.to_jsonb(v_new),'operation',v_result);
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
  RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.backoffice_set_order_operations_checked(p_expected_updated_at TEXT,p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_version TIMESTAMPTZ;
BEGIN
  PERFORM public.dk_require_backoffice();
  SELECT updated_at INTO v_version FROM public.orders WHERE id=p_payload->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF p_expected_updated_at IS NULL OR v_version IS DISTINCT FROM p_expected_updated_at::timestamptz
    THEN RAISE EXCEPTION '訂單已由其他裝置更新；未覆蓋，請重新載入後再操作'; END IF;
  RETURN public.backoffice_set_order_operations(p_payload->>'id',COALESCE(p_payload->>'payment_status','unpaid'),
    COALESCE((p_payload->>'received_amount')::numeric,0),NULLIF(p_payload->>'payment_date','')::date,
    COALESCE(p_payload->>'payment_reference',''),COALESCE(p_payload->>'delivery_status','pending'),
    NULLIF(p_payload->>'delivered_at','')::date,COALESCE(p_payload->>'delivery_note',''));
END $$;
REVOKE ALL ON FUNCTION public.backoffice_create_order_checked(JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_order_operations_checked(TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_create_order_checked(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_order_operations_checked(TEXT,JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.backoffice_purchase_operation(JSONB,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_update_order_checked(TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_purchase_operation(JSONB,TEXT,JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_update_order_checked(TEXT,JSONB) TO authenticated;
-- Phase B: only after the matching frontend is deployed, run
-- supabase-stage36-operation-integrity-enforce.sql to retire old unversioned writes.
COMMIT;
