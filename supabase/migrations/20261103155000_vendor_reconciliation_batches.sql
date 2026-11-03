CREATE OR REPLACE FUNCTION public.backoffice_create_vendor_reconciliation(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid;
  v_vendor TEXT;
  v_stype TEXT;
  v_start DATE;
  v_end DATE;
  v_notes TEXT;
  v_id TEXT;
  v_po_ids TEXT[];
  v_po_id TEXT;
  v_order_no TEXT;
  v_po_status TEXT;
  v_deleted TIMESTAMPTZ;
  v_items JSONB;
  v_item JSONB;
  v_line_vendor TEXT;
  v_qty NUMERIC;
  v_price NUMERIC;
  v_line_total NUMERIC;
  v_item_sys NUMERIC;
  v_has_line BOOLEAN;
  v_snap JSONB;
  v_header_sys NUMERIC := 0;
  v_item_id TEXT;
  v_item_count INTEGER := 0;
  v_dup TEXT;
  v_prepared JSONB := '[]'::jsonb;
  v_prep JSONB;
  v_row public.vendor_reconciliations%ROWTYPE;
BEGIN
  v_uid := public.dk_ap_require_admin();

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'system_amount' THEN
    RAISE EXCEPTION 'system_amount is server-computed';
  END IF;

  v_vendor := NULLIF(btrim(COALESCE(p_payload->>'vendor_name', '')), '');
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'vendor_name required';
  END IF;

  v_stype := upper(btrim(COALESCE(p_payload->>'settlement_type_snapshot', '')));
  IF v_stype = '' THEN
    SELECT s.settlement_type INTO v_stype
    FROM public.vendor_settlement_settings s
    WHERE s.vendor_name = v_vendor;
  END IF;
  IF v_stype IS NULL OR v_stype NOT IN ('WEEKLY', 'MONTHLY', 'CUSTOM') THEN
    RAISE EXCEPTION 'settlement_type_snapshot required (WEEKLY|MONTHLY|CUSTOM)';
  END IF;

  BEGIN
    v_start := (p_payload->>'period_start')::date;
    v_end := (p_payload->>'period_end')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'period_start / period_end required';
  END;
  IF v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'period_start / period_end required';
  END IF;
  IF v_end < v_start THEN
    RAISE EXCEPTION 'period_end must be >= period_start';
  END IF;

  v_notes := NULLIF(p_payload->>'notes', '');
  v_id := NULLIF(btrim(COALESCE(p_payload->>'id', '')), '');
  IF v_id IS NULL THEN
    v_id := 'ap-' || to_char(pg_catalog.now(), 'YYYYMMDD') || '-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vendor_reconciliations r WHERE r.id = v_id) THEN
    RAISE EXCEPTION 'reconciliation id already exists';
  END IF;

  SELECT ARRAY_AGG(x ORDER BY x) INTO v_po_ids
  FROM (
    SELECT DISTINCT NULLIF(btrim(t.x), '') AS x
    FROM pg_catalog.jsonb_array_elements_text(
      CASE
        WHEN pg_catalog.jsonb_typeof(p_payload->'purchase_order_ids') = 'array'
          THEN p_payload->'purchase_order_ids'
        ELSE '[]'::jsonb
      END
    ) AS t(x)
  ) s
  WHERE s.x IS NOT NULL;

  IF v_po_ids IS NULL OR pg_catalog.array_length(v_po_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'purchase_order_ids required';
  END IF;

  -- Trust boundary：只信任 PO id 列表；金額一律從 items_json 重算。
  FOREACH v_po_id IN ARRAY v_po_ids
  LOOP
    SELECT po.order_no, po.status, po.deleted_at, po.items_json
      INTO v_order_no, v_po_status, v_deleted, v_items
    FROM public.purchase_orders po
    WHERE po.id = v_po_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase order not found: %', v_po_id;
    END IF;
    IF v_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'purchase order deleted: %', v_po_id;
    END IF;
    IF v_po_status NOT IN ('ordered', 'partial', 'received') THEN
      RAISE EXCEPTION 'purchase order status not eligible: % (%)', v_po_id, v_po_status;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      1402,
      pg_catalog.hashtext(v_po_id || chr(31) || v_vendor)
    );

    SELECT r.id INTO v_dup
    FROM public.vendor_reconciliation_items i
    INNER JOIN public.vendor_reconciliations r ON r.id = i.reconciliation_id
    WHERE i.purchase_order_id = v_po_id
      AND i.vendor_name = v_vendor
      AND r.status IS DISTINCT FROM 'VOID'
    LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'PO/vendor already on active reconciliation %', v_dup
        USING ERRCODE = '23505';
    END IF;

    IF v_items IS NULL OR pg_catalog.jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'purchase order items_json invalid: %', v_po_id;
    END IF;

    v_item_sys := 0;
    v_has_line := false;
    v_snap := '[]'::jsonb;

    FOR v_item IN
      SELECT t.elem FROM pg_catalog.jsonb_array_elements(v_items) AS t(elem)
    LOOP
      v_line_vendor := NULLIF(btrim(COALESCE(
        NULLIF(v_item->>'selectedVendor', ''),
        NULLIF(v_item->>'manualVendor', ''),
        ''
      )), '');
      IF v_line_vendor IS DISTINCT FROM v_vendor THEN
        CONTINUE;
      END IF;
      v_has_line := true;
      v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
      IF v_qty < 1 THEN
        v_qty := 1;
      END IF;
      v_qty := pg_catalog.floor(v_qty);
      v_price := COALESCE(
        NULLIF(v_item->>'selectedUnitPrice', '')::numeric,
        NULLIF(v_item->>'manualUnitPrice', '')::numeric
      );
      v_line_total := CASE WHEN v_price IS NULL THEN NULL ELSE v_price * v_qty END;
      IF v_line_total IS NOT NULL THEN
        v_item_sys := v_item_sys + v_line_total;
      END IF;
      v_snap := v_snap || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', v_item->>'id',
          'quantity', v_qty,
          'unit_price', v_price,
          'line_total', v_line_total,
          'selectedVendor', v_item->>'selectedVendor',
          'manualVendor', v_item->>'manualVendor',
          'selectedSpec', v_item->>'selectedSpec',
          'requestText', v_item->>'requestText'
        )
      );
    END LOOP;

    IF NOT v_has_line THEN
      RAISE EXCEPTION 'vendor % not on purchase order %', v_vendor, v_po_id;
    END IF;

    v_item_id := 'api-' || replace(pg_catalog.gen_random_uuid()::text, '-', '');
    v_prepared := v_prepared || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', v_item_id,
        'purchase_order_id', v_po_id,
        'order_no', v_order_no,
        'system_amount', v_item_sys,
        'line_snapshot_json', v_snap
      )
    );
    v_header_sys := v_header_sys + v_item_sys;
    v_item_count := v_item_count + 1;
  END LOOP;

  INSERT INTO public.vendor_reconciliations (
    id, vendor_name, settlement_type_snapshot, period_start, period_end,
    system_amount, vendor_claimed_amount, status, notes, created_by, created_at, updated_at
  ) VALUES (
    v_id, v_vendor, v_stype, v_start, v_end,
    v_header_sys, NULL, 'DRAFT', v_notes, v_uid, pg_catalog.now(), pg_catalog.now()
  );

  FOR v_prep IN
    SELECT t.elem FROM pg_catalog.jsonb_array_elements(v_prepared) AS t(elem)
  LOOP
    INSERT INTO public.vendor_reconciliation_items (
      id, reconciliation_id, purchase_order_id, order_no, vendor_name,
      system_amount, vendor_claimed_amount, line_snapshot_json, review_status,
      created_at, updated_at
    ) VALUES (
      v_prep->>'id',
      v_id,
      v_prep->>'purchase_order_id',
      v_prep->>'order_no',
      v_vendor,
      COALESCE((v_prep->>'system_amount')::numeric, 0),
      NULL,
      COALESCE(v_prep->'line_snapshot_json', '[]'::jsonb),
      'UNCHECKED',
      pg_catalog.now(),
      pg_catalog.now()
    );
  END LOOP;

  SELECT * INTO v_row FROM public.vendor_reconciliations r WHERE r.id = v_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'vendor_name', v_row.vendor_name,
    'period_start', v_row.period_start,
    'period_end', v_row.period_end,
    'system_amount', v_row.system_amount,
    'vendor_claimed_amount', v_row.vendor_claimed_amount,
    'difference', v_row.difference,
    'status', v_row.status,
    'item_count', v_item_count
  );
END;
$function$
;
DROP INDEX IF EXISTS public.vendor_reconciliations_active_period_uidx;
