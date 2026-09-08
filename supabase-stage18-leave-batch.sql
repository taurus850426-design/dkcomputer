-- ============================================================
-- DK Computer｜Stage 18 Leave Batch Submit
-- Atomic multi-date leave request. Reuses backoffice_request_leave.
-- Does NOT replace approve / evaluation / payroll / settlement /
-- day classification / single-day backoffice_request_leave.
--
-- 必須在 leave-types 最終版本之後執行。
--
-- PREFLIGHT → M0_SCHEMA（NONE）→ M1_RLS（NONE）→ M2_FUNCTIONS → M3_VERIFY
-- ============================================================


-- ============================================================
-- SECTION PREFLIGHT
-- ============================================================
/*

SELECT 1 AS seq, 'table.attendance_leave_requests' AS check_name,
       (to_regclass('public.attendance_leave_requests') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.attendance_leave_requests') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.request_leave',
       (to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.require_backoffice',
       (to_regprocedure('public.dk_require_backoffice()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_require_backoffice()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- ============================================================
/*

-- NONE：不新增 table / column。批次申請寫入既有 attendance_leave_requests。

SELECT 'M0_SCHEMA' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_RLS
-- ============================================================
/*

-- NONE：不新增 table write GRANT，不改 RLS。

SELECT 'M1_RLS' AS section, 'NONE' AS actual, 'NONE' AS expected, 'PASS' AS verdict;

*/

-- M1_RLS END


-- ============================================================
-- SECTION M2_FUNCTIONS
-- ============================================================
/*

DO $$
BEGIN
  IF to_regprocedure('public.backoffice_request_leave(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: backoffice_request_leave missing. Run leave-types first.';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'M2_FUNCTIONS blocked: dk_require_backoffice missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_request_leave_batch(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_type text;
  v_reason text;
  v_raw text;
  v_date date;
  v_dates date[] := ARRAY[]::date[];
  v_ids uuid[] := ARRAY[]::uuid[];
  v_one jsonb;
  v_result jsonb;
  v_id uuid;
BEGIN
  PERFORM public.dk_require_backoffice();
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'user_id' AND NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'user_id', '')), '') IS DISTINCT FROM v_uid::text THEN
    RAISE EXCEPTION 'cannot request leave for another employee';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'approved_by' OR p_payload ? 'approved_at'
     OR p_payload ? 'rejected_by' OR p_payload ? 'rejected_at'
     OR p_payload ? 'cancelled_by' OR p_payload ? 'cancelled_at'
     OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'day_type' OR p_payload ? 'schedule_type'
  THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  v_type := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_payload->>'leave_type', 'REST_DAY')));
  IF v_type NOT IN ('REST_DAY', 'SICK_LEAVE', 'PERSONAL_LEAVE', 'ANNUAL_LEAVE') THEN
    RAISE EXCEPTION 'invalid leave_type';
  END IF;

  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'reason', '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 200 THEN
    RAISE EXCEPTION 'reason too long';
  END IF;

  IF pg_catalog.jsonb_typeof(p_payload->'dates') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'dates required';
  END IF;
  IF pg_catalog.jsonb_array_length(p_payload->'dates') IS NULL
     OR pg_catalog.jsonb_array_length(p_payload->'dates') < 1 THEN
    RAISE EXCEPTION 'dates required';
  END IF;

  FOR v_raw IN
    SELECT pg_catalog.jsonb_array_elements_text(p_payload->'dates')
  LOOP
    BEGIN
      v_date := NULLIF(pg_catalog.btrim(COALESCE(v_raw, '')), '')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'leave_date required';
    END;
    IF v_date IS NULL THEN
      RAISE EXCEPTION 'leave_date required';
    END IF;
    IF NOT (v_date = ANY (v_dates)) THEN
      v_dates := v_dates || v_date;
    END IF;
  END LOOP;

  IF v_dates IS NULL OR pg_catalog.array_length(v_dates, 1) IS NULL THEN
    RAISE EXCEPTION 'dates required';
  END IF;
  IF pg_catalog.array_length(v_dates, 1) > 62 THEN
    RAISE EXCEPTION 'too many leave dates';
  END IF;

  SELECT pg_catalog.array_agg(d ORDER BY d)
    INTO v_dates
  FROM pg_catalog.unnest(v_dates) AS d;

  FOREACH v_date IN ARRAY v_dates
  LOOP
    v_one := pg_catalog.jsonb_build_object(
      'leave_date', v_date::text,
      'leave_type', v_type
    );
    IF v_reason IS NOT NULL THEN
      v_one := v_one || pg_catalog.jsonb_build_object('reason', v_reason);
    END IF;
    BEGIN
      v_result := public.backoffice_request_leave(v_one);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM ILIKE '%duplicate leave request%' THEN
        RAISE EXCEPTION 'LEAVE_BATCH_CONFLICT' USING DETAIL = v_date::text;
      END IF;
      RAISE;
    END;
    BEGIN
      v_id := NULLIF(v_result->>'id', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_id := NULL;
    END;
    IF v_id IS NOT NULL THEN
      v_ids := v_ids || v_id;
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'count', COALESCE(pg_catalog.array_length(v_ids, 1), 0),
    'ids', pg_catalog.to_jsonb(v_ids),
    'leave_type', v_type,
    'status', 'PENDING'
  );
END;
$$;

COMMENT ON FUNCTION public.backoffice_request_leave_batch(jsonb) IS
  'Staff atomic batch leave submit. Forces auth.uid(). Reuses backoffice_request_leave validation. Rollback if any date fails.';

REVOKE ALL ON FUNCTION public.backoffice_request_leave_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_request_leave_batch(jsonb) TO authenticated;

*/

-- M2_FUNCTIONS END


-- ============================================================
-- SECTION M3_VERIFY
-- ============================================================
/*

SELECT 1 AS seq, 'rpc.batch_exists' AS check_name,
       (to_regprocedure('public.backoffice_request_leave_batch(jsonb)') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regprocedure('public.backoffice_request_leave_batch(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.single_still_exists',
       (to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_request_leave(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'rpc.batch_reuses_single',
       (COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%backoffice_request_leave%'
            AND pg_get_functiondef(p.oid) ILIKE '%LEAVE_BATCH_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%auth.uid%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_request_leave_batch'
       ), false))::text, 'true',
       CASE WHEN COALESCE((
         SELECT pg_get_functiondef(p.oid) ILIKE '%backoffice_request_leave%'
            AND pg_get_functiondef(p.oid) ILIKE '%LEAVE_BATCH_CONFLICT%'
            AND pg_get_functiondef(p.oid) ILIKE '%auth.uid%'
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'backoffice_request_leave_batch'
       ), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'grant.authenticated_batch',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave_batch(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave_batch(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'grant.anon_no_batch',
       (NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave_batch(jsonb)', 'EXECUTE'), true))::text, 'true',
       CASE WHEN NOT COALESCE(has_function_privilege('anon', 'public.backoffice_request_leave_batch(jsonb)', 'EXECUTE'), true) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'grant.authenticated_single',
       (COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false))::text, 'true',
       CASE WHEN COALESCE(has_function_privilege('authenticated', 'public.backoffice_request_leave(jsonb)', 'EXECUTE'), false) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- M3_VERIFY END
