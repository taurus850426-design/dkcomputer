-- Read-only order funding display. No assignments, inventory changes or backfills.
BEGIN;
CREATE OR REPLACE FUNCTION public.backoffice_order_funding(p_order_id TEXT, p_lines JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE rec RECORD; v_boss NUMERIC; v_hala NUMERIC; v_need NUMERIC;
  v_mode TEXT; v_result JSONB := '[]'::jsonb; v_has_sale BOOLEAN;
BEGIN
  IF public.dk_require_backoffice() IS DISTINCT FROM 'admin' OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid lines'; END IF;
  IF jsonb_array_length(p_lines)>200 THEN RAISE EXCEPTION 'too many lines'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) x WHERE
    jsonb_typeof(x->'item_id') IS DISTINCT FROM 'string' OR length(x->>'item_id') NOT BETWEEN 1 AND 200
    OR jsonb_typeof(x->'qty') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'invalid line'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) x WHERE (x->>'qty')::numeric<=0 OR (x->>'qty')::numeric>100000) THEN RAISE EXCEPTION 'invalid quantity'; END IF;
  IF NULLIF(p_order_id,'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.orders WHERE id=p_order_id) THEN RAISE EXCEPTION 'order not found'; END IF;
  FOR rec IN SELECT x->>'item_id' AS item_id,sum((x->>'qty')::numeric) AS qty
    FROM jsonb_array_elements(p_lines) x GROUP BY x->>'item_id'
  LOOP
    v_need := rec.qty;
    SELECT coalesce(sum(a.qty-a.reversed_qty) FILTER(WHERE a.owner='boss'),0),
      coalesce(sum(a.qty-a.reversed_qty) FILTER(WHERE a.owner='hala'),0)
      INTO v_boss,v_hala FROM public.inventory_funding_allocations a
      JOIN public.inventory_ledger l ON l.id=a.outbound_ledger_id
      WHERE NULLIF(p_order_id,'') IS NOT NULL AND l.ref_type='ORDER' AND l.ref_id=p_order_id
        AND l.item_id=rec.item_id AND l.movement_type='SALE';
    SELECT EXISTS(SELECT 1 FROM public.inventory_ledger l WHERE NULLIF(p_order_id,'') IS NOT NULL
      AND l.ref_type='ORDER' AND l.ref_id=p_order_id AND l.item_id=rec.item_id AND l.movement_type='SALE') INTO v_has_sale;
    IF v_has_sale THEN
      v_mode := CASE WHEN v_boss+v_hala=v_need THEN 'actual' ELSE 'incomplete' END;
    ELSIF NULLIF(p_order_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM public.orders WHERE id=p_order_id AND status IS DISTINCT FROM 'negotiating') THEN
      -- Historical orders without traceable allocations must not inherit today's owner.
      v_mode := 'incomplete';
    ELSE
      -- Match the existing outbound rule: BOSS lots first, then HALA. Preview only.
      SELECT least(v_need,coalesce(sum(qty_remaining) FILTER(WHERE owner='boss'),0)),
        coalesce(sum(qty_remaining) FILTER(WHERE owner='hala'),0)
        INTO v_boss,v_hala FROM public.inventory_funding_lots WHERE item_id=rec.item_id;
      v_hala := least(greatest(v_need-v_boss,0),v_hala);
      v_mode := CASE WHEN v_boss+v_hala=v_need THEN 'estimated' ELSE 'incomplete' END;
    END IF;
    v_result := v_result || jsonb_build_array(jsonb_build_object('item_id',rec.item_id,'mode',v_mode,
      'boss_qty',v_boss,'hala_qty',v_hala,'requested_qty',v_need));
  END LOOP;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.backoffice_order_funding(TEXT,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.backoffice_order_funding(TEXT,JSONB) TO authenticated;
COMMIT;
