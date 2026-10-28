-- Purchase shortage resolution: installation changes functions only, no business-row backfill.
-- Apply before deploying purchase-shortage.js. Reuses Stage 36 transaction/version/cost guards.
BEGIN;
CREATE OR REPLACE FUNCTION public.backoffice_purchase_operation(
  p_row JSONB, p_expected_updated_at TEXT, p_action JSONB DEFAULT '{"type":"save"}'::jsonb
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_old public.purchase_orders%ROWTYPE;
  v_new public.purchase_orders%ROWTYPE;
  v_exists BOOLEAN;
  v_type TEXT := COALESCE(p_action->>'type','save');
  v_item JSONB; v_previous JSONB; v_items JSONB; v_result JSONB := '{}'::jsonb;
  v_mode TEXT; v_source public.orders%ROWTYPE; v_line public.order_items%ROWTYPE;
  v_reason TEXT; v_history JSONB; v_before JSONB; v_next JSONB; v_source_id TEXT; v_key TEXT; v_after JSONB;
  v_index INT; v_price NUMERIC; v_vendor TEXT; v_destination TEXT; v_stamp TIMESTAMPTZ;
BEGIN
  IF public.dk_require_backoffice() IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'admin only'; END IF;
  IF COALESCE(p_row->>'id','')='' OR pg_catalog.jsonb_typeof(p_row->'items_json') IS DISTINCT FROM 'array'
    THEN RAISE EXCEPTION 'invalid purchase document'; END IF;
  IF v_type NOT IN ('save','receive','destination','shortage') THEN RAISE EXCEPTION 'invalid purchase operation'; END IF;
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


  -- Shortage writes are constructed from the locked cloud document, never a client replacement.
  IF v_type='shortage' THEN
    v_new := v_old;
    IF v_old.status NOT IN ('draft','ordered','partial') THEN RAISE EXCEPTION '目前狀態不可處理缺貨'; END IF;
    SELECT x,(n-1)::int INTO v_item,v_index
      FROM pg_catalog.jsonb_array_elements(v_old.items_json) WITH ORDINALITY t(x,n)
      WHERE x->>'id'=p_action->>'purchase_item_id';
    IF v_item IS NULL OR v_item->>'procurementStatus'='received' THEN RAISE EXCEPTION '品項不存在或已到貨，請使用退換貨流程'; END IF;
    IF EXISTS (SELECT 1 FROM public.inventory_ledger l WHERE l.ref_type='PURCHASE_RECEIPT'
      AND l.ref_id='purchase-order:'||v_old.id||':'||(v_item->>'id')) THEN
      RAISE EXCEPTION '已有入庫紀錄，不可直接替換；請先核對原入庫紀錄';
    END IF;
    v_mode := p_action->>'mode';
    IF v_mode IS NULL OR v_mode NOT IN ('wait','vendor','replace','cancel','resume','ordered') THEN RAISE EXCEPTION 'invalid shortage mode'; END IF;
    v_reason := pg_catalog.btrim(COALESCE(p_action->>'reason',''));
    IF v_reason='' THEN RAISE EXCEPTION '請填寫缺貨處理原因'; END IF;
    IF v_mode IN ('vendor','replace','cancel') AND
      (v_old.status IN ('ordered','partial') OR v_item->>'procurementStatus'='ordered') AND
      COALESCE((p_action->>'supplier_confirmed')::boolean,false) IS NOT TRUE
      THEN RAISE EXCEPTION '請先確認原廠商取消或更換，避免重複出貨'; END IF;
    v_source_id := COALESCE(v_item->>'sourceSalesOrderId','');
    v_key := COALESCE(v_item->>'sourceSalesOrderLineKey','');
    IF v_source_id<>'' OR v_key<>'' THEN
      IF v_source_id='' OR v_key='' THEN RAISE EXCEPTION '來源訂單連結不完整，請先核對'; END IF;
      SELECT * INTO v_source FROM public.orders WHERE id=v_source_id FOR UPDATE;
      IF NOT FOUND OR v_source.status IN ('completed','refunded','shipped','cancelled') THEN RAISE EXCEPTION '來源訂單不存在或已結案，不可直接更換'; END IF;
      IF p_action->>'expected_source_updated_at' IS NULL OR v_source.updated_at IS DISTINCT FROM
        (p_action->>'expected_source_updated_at')::timestamptz THEN RAISE EXCEPTION '客戶訂單已更新，請重新同步核對後再處理'; END IF;
      SELECT * INTO v_line FROM public.order_items WHERE order_id=v_source_id AND
        (extra->>'line_key'=v_key OR id=v_source_id||':'||v_key) FOR UPDATE;
      IF NOT FOUND OR v_line.extra->>'fulfillment_type' IS DISTINCT FROM 'procurement'
        OR COALESCE((v_line.extra->>'procurement_received')::boolean,false)
        THEN RAISE EXCEPTION '來源品項已異動或已入庫，不可直接更換'; END IF;
    END IF;
    v_before := v_item; v_next := v_item;
    IF v_mode='wait' THEN
      IF COALESCE(v_item->>'shortageState','')='replacement_pending' THEN RAISE EXCEPTION '替代品尚未叫貨，請先確認叫貨'; END IF;
      v_next := v_item || pg_catalog.jsonb_build_object('shortageState','waiting',
        'shortageExpectedDate',COALESCE((NULLIF(p_action->>'expected_date','')::date)::text,''));
    ELSIF v_mode='resume' THEN
      IF v_item->>'shortageState' IS DISTINCT FROM 'waiting' THEN RAISE EXCEPTION '此品項不是缺貨待補'; END IF;
      v_next := v_item || pg_catalog.jsonb_build_object('shortageState',
        CASE WHEN v_item->>'procurementStatus'='ordered' THEN '' ELSE 'replacement_pending' END,'shortageExpectedDate','');
    ELSIF v_mode='ordered' THEN
      IF v_item->>'shortageState' IS DISTINCT FROM 'replacement_pending' OR
        COALESCE((p_action->>'supplier_confirmed')::boolean,false) IS NOT TRUE
        THEN RAISE EXCEPTION '請確認替代品已傳送廠商並確認接單'; END IF;
      v_next := v_item || '{"shortageState":"","procurementStatus":"ordered"}'::jsonb;
      IF v_new.status='draft' AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_old.items_json) x
        WHERE x->>'id'<>v_item->>'id' AND COALESCE(x->>'procurementStatus','pending') NOT IN ('ordered','received'))
        THEN RAISE EXCEPTION '整單仍有其他待叫貨品項，請先核對整張叫貨單的叫貨狀態'; END IF;
      IF v_new.status='draft' THEN v_new.status := 'ordered'; END IF;
    ELSIF v_mode IN ('vendor','replace') THEN
      v_price := (p_action->>'unit_price')::numeric;
      v_vendor := pg_catalog.btrim(COALESCE(p_action->>'vendor',''));
      IF v_price IS NULL OR v_price<=0 OR v_price::text IN ('NaN','Infinity','-Infinity') OR v_vendor=''
        THEN RAISE EXCEPTION '請填寫有效的新廠商及進價'; END IF;
      IF v_mode='vendor' AND v_vendor=COALESCE(NULLIF(v_item->>'selectedVendor',''),v_item->>'manualVendor','')
        THEN RAISE EXCEPTION '更換廠商請選擇不同廠商'; END IF;
      v_next := v_item || pg_catalog.jsonb_build_object('selectedVendor',v_vendor,'manualVendor','',
        'selectedUnitPrice',v_price,'manualUnitPrice',NULL,'selectedQuoteId',NULLIF(p_action->>'quote_id',''),
        'quotedAt',COALESCE(NULLIF(p_action->>'quoted_at','')::date,CURRENT_DATE),'quoteStatus','quoted',
        'procurementStatus','pending','shortageState','replacement_pending','shortageExpectedDate','');
      IF v_mode='replace' THEN
        IF pg_catalog.btrim(COALESCE(p_action->>'spec',''))='' THEN RAISE EXCEPTION '請填寫替代規格'; END IF;
        v_next := v_next || pg_catalog.jsonb_build_object('selectedSpec',pg_catalog.btrim(p_action->>'spec'),
          'quantity',(p_action->>'quantity')::numeric);
        IF v_source_id<>'' AND ((v_next->>'quantity')::numeric IS DISTINCT FROM v_line.qty OR
          (v_next->>'quantity')::numeric IS DISTINCT FROM (v_item->>'quantity')::numeric)
          THEN RAISE EXCEPTION '連動訂單的數量不可直接變更，請先回訂單核對需求'; END IF;
        IF v_source_id<>'' AND COALESCE((p_action->>'sync_spec')::boolean,false) THEN
          UPDATE public.order_items SET name=v_next->>'selectedSpec',spec=v_next->>'selectedSpec',
            extra=extra||pg_catalog.jsonb_build_object('preferred_vendor',v_vendor) WHERE id=v_line.id;
          v_next := v_next || pg_catalog.jsonb_build_object('requestText',v_next->>'selectedSpec');
        END IF;
      END IF;
      IF COALESCE((v_next->>'quantity')::numeric,0)<=0 OR
        (v_next->>'quantity')::numeric <> pg_catalog.trunc((v_next->>'quantity')::numeric)
        OR (v_next->>'quantity') IN ('NaN','Infinity','-Infinity')
        THEN RAISE EXCEPTION '數量必須為正整數'; END IF;
    END IF;
    IF v_mode='cancel' THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(x ORDER BY n),'[]'::jsonb) INTO v_new.items_json
        FROM pg_catalog.jsonb_array_elements(v_old.items_json) WITH ORDINALITY t(x,n) WHERE x->>'id'<>v_item->>'id';
      v_after := NULL;
      IF pg_catalog.jsonb_array_length(v_new.items_json)=0 THEN v_new.status:='cancelled';
      ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x
        WHERE x->>'procurementStatus' IS DISTINCT FROM 'received') THEN v_new.status:='received'; END IF;
    ELSE
      v_new.items_json := pg_catalog.jsonb_set(v_new.items_json,ARRAY[v_index::text],v_next);
      v_after := v_next;
    END IF;
    v_history := COALESCE(v_old.data_json->'shortageHistory','[]'::jsonb) ||
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('at',pg_catalog.clock_timestamp(),
        'by',auth.uid(),'mode',v_mode,'reason',v_reason,'before',v_before,'after',v_after,
        'syncSpec',COALESCE((p_action->>'sync_spec')::boolean,false)));
    v_new.data_json := COALESCE(v_old.data_json,'{}'::jsonb)||pg_catalog.jsonb_build_object('shortageHistory',v_history);
    IF v_source_id<>'' AND v_mode IN ('replace','vendor','cancel') THEN
      UPDATE public.orders SET updated_at=pg_catalog.clock_timestamp() WHERE id=v_source_id;
    END IF;
  ELSE
    -- Ordinary clients can neither erase nor forge shortage history / states.
    v_new.data_json := COALESCE(v_new.data_json,'{}'::jsonb)||pg_catalog.jsonb_build_object('shortageHistory',
      COALESCE(v_old.data_json->'shortageHistory','[]'::jsonb));
    IF v_type='save' AND EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x
      LEFT JOIN LATERAL (SELECT y FROM pg_catalog.jsonb_array_elements(COALESCE(v_old.items_json,'[]'::jsonb)) y
        WHERE y->>'id'=x->>'id') prev ON true
      WHERE COALESCE(x->>'shortageState','') IS DISTINCT FROM COALESCE(prev.y->>'shortageState','')
        OR COALESCE(x->>'shortageExpectedDate','') IS DISTINCT FROM COALESCE(prev.y->>'shortageExpectedDate','')
    ) THEN RAISE EXCEPTION '缺貨狀態請使用缺貨處理視窗'; END IF;
  END IF;

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
      IF v_old.status NOT IN ('ordered','partial') OR v_item->>'procurementStatus'='received' OR COALESCE(v_item->>'shortageState','')<>''
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
      IF v_type='save' AND v_item IS NULL AND COALESCE(v_previous->>'shortageState','')<>''
        THEN RAISE EXCEPTION '缺貨品項請使用缺貨處理視窗取消並保留紀錄'; END IF;
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
  IF v_type='shortage' THEN
    -- Recheck quantities for the server-built replacement after the common client preflight.
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_new.items_json) x
      WHERE COALESCE((x->>'quantity')::numeric,0)<=0) THEN RAISE EXCEPTION 'invalid replacement quantity'; END IF;
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

REVOKE ALL ON FUNCTION public.backoffice_purchase_operation(JSONB,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_purchase_operation(JSONB,TEXT,JSONB) TO authenticated;
COMMIT;
