-- ============================================================
-- DK Computer｜Stage 03 Used Valuation Market Data Admin
--
-- 只建立 Admin 行情管理 RPC（批次 / 行情 / 啟用）。
-- 不改 Stage 02 schema / RLS / GRANT on tables。
-- 不建立 public valuation、engine、rule UI、案件、acquisition。
--
-- Owner 複製各 SECTION 到 SQL Editor，建議順序：
--   P0_PREFLIGHT → M1_FUNCTIONS → M2_VERIFY
-- 本檔不得由 Cursor 對 Production 執行。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- 純 read-only。DO gate 後接 scoreboard SELECT。
-- 不得 CREATE / ALTER / DROP / INSERT / UPDATE / DELETE。
-- 不得 GRANT / REVOKE / CREATE POLICY。
-- 不得用區塊註解包住整段 query。
-- ============================================================

DO $$
DECLARE
  v_rls_batches boolean;
  v_rls_prices boolean;
  v_rls_audit boolean;
  v_pol_batches int;
  v_pol_prices int;
  v_pol_audit int;
  v_auth_sel_batches boolean;
  v_auth_sel_prices boolean;
  v_auth_sel_audit boolean;
BEGIN
  IF to_regclass('public.used_market_batches') IS NULL
     OR to_regclass('public.used_market_prices') IS NULL
     OR to_regclass('public.used_valuation_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'P0 blocked: Stage 02 market/audit tables missing.';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'P0 blocked: public.profiles missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'P0 blocked: public.is_admin() missing.';
  END IF;
  IF to_regclass('public.used_acquisition_links') IS NOT NULL
     OR to_regclass('public.used_resale_links') IS NOT NULL
     OR to_regclass('public.used_valuation_external_links') IS NOT NULL THEN
    RAISE EXCEPTION 'P0 blocked: deferred used_* link tables already exist.';
  END IF;
  IF to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NOT NULL
     OR to_regprocedure('public.backoffice_used_market_update_batch(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.backoffice_used_market_create_price(jsonb)') IS NOT NULL
     OR to_regprocedure('public.backoffice_used_market_update_price(uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.backoffice_used_market_delete_price(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'P0 blocked: Stage 03 market RPCs already exist. Do not DROP or REPLACE.';
  END IF;
  IF to_regprocedure('public.dk_used_market_require_admin()') IS NOT NULL
     OR to_regprocedure('public.dk_used_market_norm_text(text,integer)') IS NOT NULL
     OR to_regprocedure('public.dk_used_market_batch_snapshot(uuid)') IS NOT NULL
     OR to_regprocedure('public.dk_used_market_price_snapshot(uuid)') IS NOT NULL
     OR to_regprocedure('public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'P0 blocked: Stage 03 helper functions already exist. Do not DROP or REPLACE.';
  END IF;

  SELECT c.relrowsecurity INTO v_rls_batches
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'used_market_batches' AND c.relkind = 'r';
  SELECT c.relrowsecurity INTO v_rls_prices
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'used_market_prices' AND c.relkind = 'r';
  SELECT c.relrowsecurity INTO v_rls_audit
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'used_valuation_audit_logs' AND c.relkind = 'r';
  IF v_rls_batches IS NOT TRUE OR v_rls_prices IS NOT TRUE OR v_rls_audit IS NOT TRUE THEN
    RAISE EXCEPTION 'P0 blocked: Stage 02 RLS baseline missing on market/audit tables.';
  END IF;

  v_auth_sel_batches := has_table_privilege('authenticated', 'public.used_market_batches', 'SELECT');
  v_auth_sel_prices := has_table_privilege('authenticated', 'public.used_market_prices', 'SELECT');
  v_auth_sel_audit := has_table_privilege('authenticated', 'public.used_valuation_audit_logs', 'SELECT');
  IF v_auth_sel_batches IS NOT TRUE
     OR v_auth_sel_prices IS NOT TRUE
     OR v_auth_sel_audit IS NOT TRUE THEN
    RAISE EXCEPTION 'P0 blocked: authenticated SELECT grant missing on market/audit tables.';
  END IF;

  SELECT COUNT(*)::int INTO v_pol_batches
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'used_market_batches'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']::name[]
    AND NOT (roles && ARRAY['anon']::name[])
    AND NOT (roles && ARRAY['public']::name[])
    AND qual ILIKE '%is_admin()%';
  SELECT COUNT(*)::int INTO v_pol_prices
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'used_market_prices'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']::name[]
    AND NOT (roles && ARRAY['anon']::name[])
    AND NOT (roles && ARRAY['public']::name[])
    AND qual ILIKE '%is_admin()%';
  SELECT COUNT(*)::int INTO v_pol_audit
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'used_valuation_audit_logs'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']::name[]
    AND NOT (roles && ARRAY['anon']::name[])
    AND NOT (roles && ARRAY['public']::name[])
    AND qual ILIKE '%is_admin()%';
  IF v_pol_batches < 1 OR v_pol_prices < 1 OR v_pol_audit < 1 THEN
    RAISE EXCEPTION 'P0 blocked: Stage 02 admin SELECT policies missing or weakened.';
  END IF;
END
$$;

WITH t AS (
  SELECT
    to_regclass('public.used_market_batches') IS NOT NULL AS batches,
    to_regclass('public.used_market_prices') IS NOT NULL AS prices,
    to_regclass('public.used_valuation_audit_logs') IS NOT NULL AS audit_logs,
    to_regclass('public.profiles') IS NOT NULL AS profiles
),
rls AS (
  SELECT
    MAX(CASE WHEN c.relname = 'used_market_batches' THEN c.relrowsecurity::int END) AS batches,
    MAX(CASE WHEN c.relname = 'used_market_prices' THEN c.relrowsecurity::int END) AS prices,
    MAX(CASE WHEN c.relname = 'used_valuation_audit_logs' THEN c.relrowsecurity::int END) AS audit_logs
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN ('used_market_batches', 'used_market_prices', 'used_valuation_audit_logs')
),
anon_acc AS (
  SELECT
    (
      has_table_privilege('anon', 'public.used_market_batches', 'SELECT')
      OR has_table_privilege('anon', 'public.used_market_batches', 'INSERT')
      OR has_table_privilege('anon', 'public.used_market_batches', 'UPDATE')
      OR has_table_privilege('anon', 'public.used_market_batches', 'DELETE')
    )::int AS batches,
    (
      has_table_privilege('anon', 'public.used_market_prices', 'SELECT')
      OR has_table_privilege('anon', 'public.used_market_prices', 'INSERT')
      OR has_table_privilege('anon', 'public.used_market_prices', 'UPDATE')
      OR has_table_privilege('anon', 'public.used_market_prices', 'DELETE')
    )::int AS prices,
    (
      has_table_privilege('anon', 'public.used_valuation_audit_logs', 'SELECT')
      OR has_table_privilege('anon', 'public.used_valuation_audit_logs', 'INSERT')
      OR has_table_privilege('anon', 'public.used_valuation_audit_logs', 'UPDATE')
      OR has_table_privilege('anon', 'public.used_valuation_audit_logs', 'DELETE')
    )::int AS audit_logs
),
auth_write AS (
  SELECT
    (
      has_table_privilege('authenticated', 'public.used_market_batches', 'INSERT')
      OR has_table_privilege('authenticated', 'public.used_market_batches', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.used_market_batches', 'DELETE')
    )::int AS batches,
    (
      has_table_privilege('authenticated', 'public.used_market_prices', 'INSERT')
      OR has_table_privilege('authenticated', 'public.used_market_prices', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.used_market_prices', 'DELETE')
    )::int AS prices,
    (
      has_table_privilege('authenticated', 'public.used_valuation_audit_logs', 'INSERT')
      OR has_table_privilege('authenticated', 'public.used_valuation_audit_logs', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.used_valuation_audit_logs', 'DELETE')
    )::int AS audit_logs
),
auth_select AS (
  SELECT
    has_table_privilege('authenticated', 'public.used_market_batches', 'SELECT') AS batches,
    has_table_privilege('authenticated', 'public.used_market_prices', 'SELECT') AS prices,
    has_table_privilege('authenticated', 'public.used_valuation_audit_logs', 'SELECT') AS audit_logs
),
pol AS (
  SELECT
    COUNT(*) FILTER (
      WHERE tablename = 'used_market_batches'
        AND cmd = 'SELECT'
        AND roles @> ARRAY['authenticated']::name[]
        AND NOT (roles && ARRAY['anon']::name[])
        AND NOT (roles && ARRAY['public']::name[])
        AND qual ILIKE '%is_admin()%'
    )::int AS batches,
    COUNT(*) FILTER (
      WHERE tablename = 'used_market_prices'
        AND cmd = 'SELECT'
        AND roles @> ARRAY['authenticated']::name[]
        AND NOT (roles && ARRAY['anon']::name[])
        AND NOT (roles && ARRAY['public']::name[])
        AND qual ILIKE '%is_admin()%'
    )::int AS prices,
    COUNT(*) FILTER (
      WHERE tablename = 'used_valuation_audit_logs'
        AND cmd = 'SELECT'
        AND roles @> ARRAY['authenticated']::name[]
        AND NOT (roles && ARRAY['anon']::name[])
        AND NOT (roles && ARRAY['public']::name[])
        AND qual ILIKE '%is_admin()%'
    )::int AS audit_logs
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('used_market_batches', 'used_market_prices', 'used_valuation_audit_logs')
)
SELECT 1 AS seq, 'table.used_market_batches'::text AS check_name,
       (SELECT batches::text FROM t) AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT batches FROM t) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.used_market_prices',
       (SELECT prices::text FROM t), 'true',
       CASE WHEN (SELECT prices FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.used_valuation_audit_logs',
       (SELECT audit_logs::text FROM t), 'true',
       CASE WHEN (SELECT audit_logs FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.profiles',
       (SELECT profiles::text FROM t), 'true',
       CASE WHEN (SELECT profiles FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'rls.market_batches',
       (SELECT batches::text FROM rls), '1',
       CASE WHEN (SELECT batches FROM rls) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'rls.market_prices',
       (SELECT prices::text FROM rls), '1',
       CASE WHEN (SELECT prices FROM rls) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'rls.audit_logs',
       (SELECT audit_logs::text FROM rls), '1',
       CASE WHEN (SELECT audit_logs FROM rls) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'anon.market_batches_access',
       (SELECT batches::text FROM anon_acc), '0',
       CASE WHEN (SELECT batches FROM anon_acc) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'anon.market_prices_access',
       (SELECT prices::text FROM anon_acc), '0',
       CASE WHEN (SELECT prices FROM anon_acc) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'anon.audit_access',
       (SELECT audit_logs::text FROM anon_acc), '0',
       CASE WHEN (SELECT audit_logs FROM anon_acc) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'authenticated.market_batches_write',
       (SELECT batches::text FROM auth_write), '0',
       CASE WHEN (SELECT batches FROM auth_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'authenticated.market_prices_write',
       (SELECT prices::text FROM auth_write), '0',
       CASE WHEN (SELECT prices FROM auth_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'authenticated.audit_write',
       (SELECT audit_logs::text FROM auth_write), '0',
       CASE WHEN (SELECT audit_logs FROM auth_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'authenticated.market_batches_select',
       (SELECT batches::text FROM auth_select), 'true',
       CASE WHEN (SELECT batches FROM auth_select) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'authenticated.market_prices_select',
       (SELECT prices::text FROM auth_select), 'true',
       CASE WHEN (SELECT prices FROM auth_select) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'authenticated.audit_select',
       (SELECT audit_logs::text FROM auth_select), 'true',
       CASE WHEN (SELECT audit_logs FROM auth_select) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'policy.market_batches_admin_select',
       (SELECT batches::text FROM pol), '>=1',
       CASE WHEN (SELECT batches FROM pol) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'policy.market_prices_admin_select',
       (SELECT prices::text FROM pol), '>=1',
       CASE WHEN (SELECT prices FROM pol) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'policy.audit_admin_select',
       (SELECT audit_logs::text FROM pol), '>=1',
       CASE WHEN (SELECT audit_logs FROM pol) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'rpc.create_batch_absent',
       (to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'rpc.update_batch_absent',
       (to_regprocedure('public.backoffice_used_market_update_batch(uuid,jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_update_batch(uuid,jsonb)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'rpc.activate_batch_absent',
       (to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'rpc.create_price_absent',
       (to_regprocedure('public.backoffice_used_market_create_price(jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_create_price(jsonb)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'rpc.update_price_absent',
       (to_regprocedure('public.backoffice_used_market_update_price(uuid,jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_update_price(uuid,jsonb)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'rpc.delete_price_absent',
       (to_regprocedure('public.backoffice_used_market_delete_price(uuid,text)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_delete_price(uuid,text)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'deferred.used_acquisition_links_absent',
       (to_regclass('public.used_acquisition_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_acquisition_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'deferred.used_resale_links_absent',
       (to_regclass('public.used_resale_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_resale_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'deferred.external_links_absent',
       (to_regclass('public.used_valuation_external_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_external_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'helper.require_admin_absent',
       (to_regprocedure('public.dk_used_market_require_admin()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_used_market_require_admin()') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'helper.norm_text_absent',
       (to_regprocedure('public.dk_used_market_norm_text(text,integer)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_used_market_norm_text(text,integer)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'helper.batch_snapshot_absent',
       (to_regprocedure('public.dk_used_market_batch_snapshot(uuid)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_used_market_batch_snapshot(uuid)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'helper.price_snapshot_absent',
       (to_regprocedure('public.dk_used_market_price_snapshot(uuid)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_used_market_price_snapshot(uuid)') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'helper.write_audit_absent',
       (to_regprocedure('public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NULL THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;


-- ============================================================
-- SECTION M1_FUNCTIONS
-- 建立 Admin-only SECURITY DEFINER RPC。不改 Stage 02 tables。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_market_batches') IS NULL
     OR to_regclass('public.used_market_prices') IS NULL
     OR to_regclass('public.used_valuation_audit_logs') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
  THEN
    RAISE EXCEPTION 'M1 blocked: Stage 02 market/audit foundation missing.';
  END IF;
END
$$;

CREATE FUNCTION public.dk_used_market_require_admin()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE FUNCTION public.dk_used_market_norm_text(p_raw text, p_max int)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text;
BEGIN
  v := NULLIF(pg_catalog.btrim(COALESCE(p_raw, '')), '');
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_max IS NOT NULL AND pg_catalog.length(v) > p_max THEN
    RAISE EXCEPTION 'text too long';
  END IF;
  RETURN v;
END;
$$;

CREATE FUNCTION public.dk_used_market_batch_snapshot(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'id', b.id,
    'batch_code', b.batch_code,
    'status', b.status,
    'effective_date', b.effective_date,
    'source_summary', b.source_summary,
    'created_by', b.created_by,
    'created_at', b.created_at,
    'published_at', b.published_at
  )
    INTO v
  FROM public.used_market_batches b
  WHERE b.id = p_id;
  RETURN COALESCE(v, '{}'::jsonb);
END;
$$;

CREATE FUNCTION public.dk_used_market_price_snapshot(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT pg_catalog.jsonb_build_object(
    'id', p.id,
    'market_batch_id', p.market_batch_id,
    'category', p.category,
    'brand', p.brand,
    'model', p.model,
    'variant', p.variant,
    'market_low', p.market_low,
    'market_mid', p.market_mid,
    'market_high', p.market_high,
    'sample_count', p.sample_count,
    'confidence', p.confidence,
    'source_type', p.source_type,
    'effective_date', p.effective_date,
    'note', p.note,
    'created_by', p.created_by,
    'created_at', p.created_at,
    'updated_at', p.updated_at
  )
    INTO v
  FROM public.used_market_prices p
  WHERE p.id = p_id;
  RETURN COALESCE(v, '{}'::jsonb);
END;
$$;

CREATE FUNCTION public.dk_used_market_write_audit(
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text,
  p_before jsonb,
  p_after jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.used_valuation_audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    reason,
    before_snapshot,
    after_snapshot
  ) VALUES (
    p_actor,
    p_action,
    p_entity_type,
    p_entity_id,
    p_reason,
    COALESCE(p_before, '{}'::jsonb),
    COALESCE(p_after, '{}'::jsonb)
  );
END;
$$;

CREATE FUNCTION public.backoffice_used_market_create_batch(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_code text;
  v_summary text;
  v_date date;
  v_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'created_by' OR p_payload ? 'created_at'
     OR p_payload ? 'published_at' OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  v_code := public.dk_used_market_norm_text(p_payload->>'batch_code', 80);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'batch_code required';
  END IF;
  v_summary := public.dk_used_market_norm_text(p_payload->>'source_summary', 500);
  BEGIN
    v_date := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'effective_date', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid effective_date';
  END;

  INSERT INTO public.used_market_batches (
    batch_code, status, effective_date, source_summary, created_by
  ) VALUES (
    v_code, 'DRAFT', v_date, v_summary, v_uid
  )
  RETURNING id INTO v_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_BATCH_CREATED', 'MARKET_BATCH', v_id, NULL,
    '{}'::jsonb, public.dk_used_market_batch_snapshot(v_id)
  );

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'status', 'DRAFT');
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate batch_code';
END;
$$;

CREATE FUNCTION public.backoffice_used_market_update_batch(p_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.used_market_batches%ROWTYPE;
  v_before jsonb;
  v_code text;
  v_summary text;
  v_date date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'batch_id required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'created_by' OR p_payload ? 'created_at'
     OR p_payload ? 'published_at' OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  SELECT * INTO v_row
  FROM public.used_market_batches
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'batch not draft';
  END IF;

  v_before := public.dk_used_market_batch_snapshot(p_id);
  v_code := COALESCE(
    public.dk_used_market_norm_text(p_payload->>'batch_code', 80),
    v_row.batch_code
  );
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'batch_code required';
  END IF;
  IF p_payload ? 'source_summary' THEN
    v_summary := public.dk_used_market_norm_text(p_payload->>'source_summary', 500);
  ELSE
    v_summary := v_row.source_summary;
  END IF;
  IF p_payload ? 'effective_date' THEN
    BEGIN
      v_date := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'effective_date', '')), '')::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid effective_date';
    END;
  ELSE
    v_date := v_row.effective_date;
  END IF;

  UPDATE public.used_market_batches
     SET batch_code = v_code,
         effective_date = v_date,
         source_summary = v_summary
   WHERE id = p_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_BATCH_UPDATED', 'MARKET_BATCH', p_id, NULL,
    v_before, public.dk_used_market_batch_snapshot(p_id)
  );

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'DRAFT');
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate batch_code';
END;
$$;

CREATE FUNCTION public.backoffice_used_market_activate_batch(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.used_market_batches%ROWTYPE;
  v_prev_id uuid;
  v_reason text;
  v_n int;
  v_before jsonb;
  v_prev_before jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'batch_id required';
  END IF;
  v_reason := public.dk_used_market_norm_text(p_reason, 2000);
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason required';
  END IF;

  -- Serialize concurrent activations. FOR UPDATE on ACTIVE locks nothing
  -- when no ACTIVE row exists; the Stage 02 unique index remains the last gate.
  PERFORM pg_catalog.pg_advisory_xact_lock(872314905, 3);

  SELECT * INTO v_row
  FROM public.used_market_batches
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'batch not draft';
  END IF;

  SELECT COUNT(*)::int INTO v_n
  FROM public.used_market_prices
  WHERE market_batch_id = p_id;
  IF v_n < 1 THEN
    RAISE EXCEPTION 'batch empty';
  END IF;

  SELECT b.id INTO v_prev_id
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE'
    AND b.id IS DISTINCT FROM p_id
  FOR UPDATE;

  IF v_prev_id IS NOT NULL THEN
    v_prev_before := public.dk_used_market_batch_snapshot(v_prev_id);
    UPDATE public.used_market_batches
       SET status = 'ARCHIVED'
     WHERE id = v_prev_id;
    PERFORM public.dk_used_market_write_audit(
      v_uid, 'MARKET_BATCH_ARCHIVED', 'MARKET_BATCH', v_prev_id, v_reason,
      v_prev_before, public.dk_used_market_batch_snapshot(v_prev_id)
    );
  END IF;

  v_before := public.dk_used_market_batch_snapshot(p_id);
  UPDATE public.used_market_batches
     SET status = 'ACTIVE',
         published_at = pg_catalog.now()
   WHERE id = p_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_BATCH_ACTIVATED', 'MARKET_BATCH', p_id, v_reason,
    v_before,
    public.dk_used_market_batch_snapshot(p_id)
      || pg_catalog.jsonb_build_object(
           'previous_active_batch_id', v_prev_id
         )
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', p_id,
    'status', 'ACTIVE',
    'archived_batch_id', v_prev_id
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'active batch conflict';
END;
$$;

CREATE FUNCTION public.backoffice_used_market_create_price(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_batch public.used_market_batches%ROWTYPE;
  v_id uuid;
  v_batch_id uuid;
  v_low numeric;
  v_mid numeric;
  v_high numeric;
  v_sample integer;
  v_conf integer;
  v_date date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'created_at' OR p_payload ? 'updated_at'
     OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;

  BEGIN
    v_batch_id := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'market_batch_id', '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'market_batch_id required';
  END;
  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'market_batch_id required';
  END IF;

  SELECT * INTO v_batch
  FROM public.used_market_batches
  WHERE id = v_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found';
  END IF;
  IF v_batch.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'batch not draft';
  END IF;

  BEGIN
    v_low := (p_payload->>'market_low')::numeric;
    v_mid := (p_payload->>'market_mid')::numeric;
    v_high := (p_payload->>'market_high')::numeric;
    v_sample := COALESCE(NULLIF(p_payload->>'sample_count', '')::integer, 0);
    v_conf := COALESCE(NULLIF(p_payload->>'confidence', '')::integer, 0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid price range';
  END;
  IF v_low IS NULL OR v_mid IS NULL OR v_high IS NULL THEN
    RAISE EXCEPTION 'invalid price range';
  END IF;
  IF v_low < 0 OR v_mid < v_low OR v_high < v_mid THEN
    RAISE EXCEPTION 'invalid price range';
  END IF;
  IF v_sample < 0 THEN
    RAISE EXCEPTION 'invalid sample_count';
  END IF;
  IF v_conf < 0 OR v_conf > 100 THEN
    RAISE EXCEPTION 'invalid confidence';
  END IF;
  BEGIN
    v_date := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'effective_date', '')), '')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid effective_date';
  END;

  INSERT INTO public.used_market_prices (
    market_batch_id, category, brand, model, variant,
    market_low, market_mid, market_high,
    sample_count, confidence, source_type, effective_date, note, created_by
  ) VALUES (
    v_batch_id,
    public.dk_used_market_norm_text(p_payload->>'category', 80),
    public.dk_used_market_norm_text(p_payload->>'brand', 80),
    public.dk_used_market_norm_text(p_payload->>'model', 120),
    public.dk_used_market_norm_text(p_payload->>'variant', 120),
    v_low, v_mid, v_high, v_sample, v_conf,
    public.dk_used_market_norm_text(p_payload->>'source_type', 80),
    v_date,
    public.dk_used_market_norm_text(p_payload->>'note', 2000),
    v_uid
  )
  RETURNING id INTO v_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_PRICE_CREATED', 'MARKET_PRICE', v_id, NULL,
    '{}'::jsonb, public.dk_used_market_price_snapshot(v_id)
  );

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate market row';
END;
$$;

CREATE FUNCTION public.backoffice_used_market_update_price(p_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_price public.used_market_prices%ROWTYPE;
  v_batch public.used_market_batches%ROWTYPE;
  v_before jsonb;
  v_low numeric;
  v_mid numeric;
  v_high numeric;
  v_sample integer;
  v_conf integer;
  v_date date;
  v_cat text;
  v_brand text;
  v_model text;
  v_variant text;
  v_source text;
  v_note text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'price_id required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'created_by' OR p_payload ? 'created_at' OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  IF p_payload ? 'market_batch_id' THEN
    RAISE EXCEPTION 'market_batch_id is immutable';
  END IF;

  SELECT * INTO v_price
  FROM public.used_market_prices
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'price not found';
  END IF;

  SELECT * INTO v_batch
  FROM public.used_market_batches
  WHERE id = v_price.market_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found';
  END IF;
  IF v_batch.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'batch not draft';
  END IF;

  v_before := public.dk_used_market_price_snapshot(p_id);

  BEGIN
    v_low := COALESCE((p_payload->>'market_low')::numeric, v_price.market_low);
    v_mid := COALESCE((p_payload->>'market_mid')::numeric, v_price.market_mid);
    v_high := COALESCE((p_payload->>'market_high')::numeric, v_price.market_high);
    v_sample := COALESCE(NULLIF(p_payload->>'sample_count', '')::integer, v_price.sample_count);
    v_conf := COALESCE(NULLIF(p_payload->>'confidence', '')::integer, v_price.confidence);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid price range';
  END;
  IF v_low < 0 OR v_mid < v_low OR v_high < v_mid THEN
    RAISE EXCEPTION 'invalid price range';
  END IF;
  IF v_sample < 0 THEN
    RAISE EXCEPTION 'invalid sample_count';
  END IF;
  IF v_conf < 0 OR v_conf > 100 THEN
    RAISE EXCEPTION 'invalid confidence';
  END IF;

  IF p_payload ? 'category' THEN
    v_cat := public.dk_used_market_norm_text(p_payload->>'category', 80);
  ELSE
    v_cat := v_price.category;
  END IF;
  IF p_payload ? 'brand' THEN
    v_brand := public.dk_used_market_norm_text(p_payload->>'brand', 80);
  ELSE
    v_brand := v_price.brand;
  END IF;
  IF p_payload ? 'model' THEN
    v_model := public.dk_used_market_norm_text(p_payload->>'model', 120);
  ELSE
    v_model := v_price.model;
  END IF;
  IF p_payload ? 'variant' THEN
    v_variant := public.dk_used_market_norm_text(p_payload->>'variant', 120);
  ELSE
    v_variant := v_price.variant;
  END IF;
  IF p_payload ? 'source_type' THEN
    v_source := public.dk_used_market_norm_text(p_payload->>'source_type', 80);
  ELSE
    v_source := v_price.source_type;
  END IF;
  IF p_payload ? 'note' THEN
    v_note := public.dk_used_market_norm_text(p_payload->>'note', 2000);
  ELSE
    v_note := v_price.note;
  END IF;
  IF p_payload ? 'effective_date' THEN
    BEGIN
      v_date := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'effective_date', '')), '')::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid effective_date';
    END;
  ELSE
    v_date := v_price.effective_date;
  END IF;

  UPDATE public.used_market_prices
     SET category = v_cat,
         brand = v_brand,
         model = v_model,
         variant = v_variant,
         market_low = v_low,
         market_mid = v_mid,
         market_high = v_high,
         sample_count = v_sample,
         confidence = v_conf,
         source_type = v_source,
         effective_date = v_date,
         note = v_note
   WHERE id = p_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_PRICE_UPDATED', 'MARKET_PRICE', p_id, NULL,
    v_before, public.dk_used_market_price_snapshot(p_id)
  );

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate market row';
END;
$$;

CREATE FUNCTION public.backoffice_used_market_delete_price(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_price public.used_market_prices%ROWTYPE;
  v_batch public.used_market_batches%ROWTYPE;
  v_reason text;
  v_before jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_market_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'price_id required';
  END IF;
  v_reason := public.dk_used_market_norm_text(p_reason, 2000);
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason required';
  END IF;

  SELECT * INTO v_price
  FROM public.used_market_prices
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'price not found';
  END IF;

  SELECT * INTO v_batch
  FROM public.used_market_batches
  WHERE id = v_price.market_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found';
  END IF;
  IF v_batch.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'batch not draft';
  END IF;

  v_before := public.dk_used_market_price_snapshot(p_id);
  DELETE FROM public.used_market_prices WHERE id = p_id;

  PERFORM public.dk_used_market_write_audit(
    v_uid, 'MARKET_PRICE_DELETED', 'MARKET_PRICE', p_id, v_reason,
    v_before, '{}'::jsonb
  );

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'deleted', true);
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_market_require_admin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_market_norm_text(text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_market_batch_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_market_price_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_market_write_audit(uuid, text, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.backoffice_used_market_create_batch(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_market_update_batch(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_market_activate_batch(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_market_create_price(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_market_update_price(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_market_delete_price(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backoffice_used_market_create_batch(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_market_update_batch(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_market_activate_batch(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_market_create_price(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_market_update_price(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_market_delete_price(uuid, text) TO authenticated;

COMMIT;


-- ============================================================
-- SECTION M2_VERIFY
-- 純 read-only scoreboard。最後一個 statement 必須是本 SELECT。
-- 不得 CREATE / ALTER / DROP / INSERT / UPDATE / DELETE。
-- 不得 GRANT / REVOKE / CREATE POLICY。
-- 不得輸出 function body / 行情內容 / 個資。
-- ============================================================

WITH fn_catalog AS (
  SELECT * FROM (
    VALUES
      ('helper'::text, 'public.dk_used_market_require_admin()'::text, true),
      ('helper', 'public.dk_used_market_norm_text(text,integer)', false),
      ('helper', 'public.dk_used_market_batch_snapshot(uuid)', true),
      ('helper', 'public.dk_used_market_price_snapshot(uuid)', true),
      ('helper', 'public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)', true),
      ('rpc', 'public.backoffice_used_market_create_batch(jsonb)', true),
      ('rpc', 'public.backoffice_used_market_update_batch(uuid,jsonb)', true),
      ('rpc', 'public.backoffice_used_market_activate_batch(uuid,text)', true),
      ('rpc', 'public.backoffice_used_market_create_price(jsonb)', true),
      ('rpc', 'public.backoffice_used_market_update_price(uuid,jsonb)', true),
      ('rpc', 'public.backoffice_used_market_delete_price(uuid,text)', true)
  ) AS t(kind, sig, needs_definer)
),
fn_rows AS (
  SELECT
    c.kind,
    c.sig,
    c.needs_definer,
    to_regprocedure(c.sig) AS oid
  FROM fn_catalog c
),
fn_meta AS (
  SELECT
    f.kind,
    f.sig,
    f.needs_definer,
    f.oid,
    p.prosecdef,
    p.proconfig,
    p.proacl,
    p.proowner,
    CASE
      WHEN f.oid IS NULL THEN ''
      ELSE pg_get_functiondef(f.oid)
    END AS def
  FROM fn_rows f
  LEFT JOIN pg_proc p ON p.oid = f.oid
),
helpers_n AS (
  SELECT COUNT(*)::int AS n FROM fn_rows WHERE kind = 'helper' AND oid IS NOT NULL
),
rpc_n AS (
  SELECT COUNT(*)::int AS n FROM fn_rows WHERE kind = 'rpc' AND oid IS NOT NULL
),
definer_required_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE needs_definer IS TRUE
    AND oid IS NOT NULL
    AND prosecdef IS TRUE
),
safe_search_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.oid IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
      WHERE pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
    )
),
rpc_admin_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE kind = 'rpc'
    AND oid IS NOT NULL
    AND def ILIKE '%public.is_admin()%'
    AND def ILIKE '%public.dk_used_market_require_admin()%'
),
require_admin_ok AS (
  SELECT
    def ILIKE '%public.is_admin()%'
    AND def ILIKE '%auth.uid()%' AS ok
  FROM fn_meta
  WHERE sig = 'public.dk_used_market_require_admin()'
  UNION ALL
  SELECT false
  WHERE NOT EXISTS (
    SELECT 1 FROM fn_meta WHERE sig = 'public.dk_used_market_require_admin()' AND oid IS NOT NULL
  )
  LIMIT 1
),
helper_public_exec AS (
  SELECT COUNT(DISTINCT f.oid)::int AS n
  FROM fn_meta f
  CROSS JOIN LATERAL aclexplode(
    COALESCE(f.proacl, acldefault('f'::"char", f.proowner))
  ) acl
  WHERE f.kind = 'helper'
    AND f.oid IS NOT NULL
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
),
helper_anon_exec AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.kind = 'helper'
    AND f.oid IS NOT NULL
    AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
helper_auth_exec AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.kind = 'helper'
    AND f.oid IS NOT NULL
    AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
),
rpc_public_exec AS (
  SELECT COUNT(DISTINCT f.oid)::int AS n
  FROM fn_meta f
  CROSS JOIN LATERAL aclexplode(
    COALESCE(f.proacl, acldefault('f'::"char", f.proowner))
  ) acl
  WHERE f.kind = 'rpc'
    AND f.oid IS NOT NULL
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
),
rpc_anon_exec AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.kind = 'rpc'
    AND f.oid IS NOT NULL
    AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
rpc_auth_exec AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.kind = 'rpc'
    AND f.oid IS NOT NULL
    AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
),
market_tables AS (
  SELECT * FROM (
    VALUES
      ('used_market_batches'::text),
      ('used_market_prices'),
      ('used_valuation_audit_logs')
  ) AS t(table_name)
),
rls_market AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN market_tables t ON t.table_name = c.relname
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity IS TRUE
),
anon_direct AS (
  SELECT COUNT(*)::int AS n
  FROM market_tables t
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
    AND (
      has_table_privilege('anon', format('public.%I', t.table_name), 'SELECT')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'INSERT')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'UPDATE')
      OR has_table_privilege('anon', format('public.%I', t.table_name), 'DELETE')
    )
),
auth_write AS (
  SELECT COUNT(*)::int AS n
  FROM market_tables t
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
    AND (
      has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT')
      OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE')
      OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE')
    )
),
auth_select AS (
  SELECT COUNT(*)::int AS n
  FROM market_tables t
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
    AND has_table_privilege('authenticated', format('public.%I', t.table_name), 'SELECT')
),
admin_policies AS (
  SELECT COUNT(DISTINCT p.tablename)::int AS n
  FROM pg_policies p
  JOIN market_tables t ON t.table_name = p.tablename
  WHERE p.schemaname = 'public'
    AND p.cmd = 'SELECT'
    AND p.roles @> ARRAY['authenticated']::name[]
    AND NOT (p.roles && ARRAY['anon']::name[])
    AND NOT (p.roles && ARRAY['public']::name[])
    AND p.qual ILIKE '%is_admin()%'
),
write_policies AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policies p
  JOIN market_tables t ON t.table_name = p.tablename
  WHERE p.schemaname = 'public'
    AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
),
single_active AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_market_batches'
    AND i.indisunique
    AND i.indisvalid
    AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%status%'
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
market_dup AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_market_prices'
    AND i.indisunique
    AND i.indisvalid
    AND pg_get_indexdef(i.indexrelid) ILIKE '%COALESCE%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%market_batch_id%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%category%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%brand%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%model%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%variant%'
),
price_cks AS (
  SELECT con.conname,
         pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class t ON t.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_market_prices'
    AND con.contype = 'c'
),
market_range AS (
  SELECT (
    (COUNT(*) FILTER (
       WHERE conname = 'used_market_prices_low_ck'
         AND def ILIKE '%market_low%'
         AND def ILIKE '%>=%'
     ) >= 1)::int
    + (COUNT(*) FILTER (
       WHERE conname = 'used_market_prices_mid_ck'
         AND def ILIKE '%market_mid%'
         AND def ILIKE '%market_low%'
         AND def ILIKE '%>=%'
     ) >= 1)::int
    + (COUNT(*) FILTER (
       WHERE conname = 'used_market_prices_high_ck'
         AND def ILIKE '%market_high%'
         AND def ILIKE '%market_mid%'
         AND def ILIKE '%>=%'
     ) >= 1)::int
    + (COUNT(*) FILTER (
       WHERE conname = 'used_market_prices_sample_ck'
         AND def ILIKE '%sample_count%'
         AND def ILIKE '%>=%'
     ) >= 1)::int
    + (COUNT(*) FILTER (
       WHERE conname = 'used_market_prices_confidence_ck'
         AND def ILIKE '%confidence%'
         AND def ILIKE '%>=%'
         AND def ILIKE '%<=%'
         AND def ILIKE '%100%'
     ) >= 1)::int
  )::int AS n
  FROM price_cks
),
audit_append AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public'
    AND c.relname = 'used_valuation_audit_logs'
    AND NOT t.tgisinternal
    AND t.tgenabled IN ('O', 'A')
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 8) <> 0
    AND (t.tgtype & 16) <> 0
    AND p.proname = 'used_valuation_audit_immutable'
),
act_def AS (
  SELECT def
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_market_activate_batch(uuid,text)'
    AND oid IS NOT NULL
),
activation_ok AS (
  SELECT (
    d.def ILIKE '%public.is_admin()%'
    AND d.def ILIKE '%public.dk_used_market_require_admin()%'
    AND d.def ILIKE '%reason required%'
    AND d.def ILIKE '%batch not draft%'
    AND d.def ILIKE '%batch empty%'
    AND d.def ILIKE '%pg_advisory_xact_lock%'
    AND d.def ILIKE '%FOR UPDATE%'
    AND d.def ILIKE '%ARCHIVED%'
    AND d.def ILIKE '%ACTIVE%'
    AND d.def ILIKE '%published_at%'
    AND d.def ILIKE '%dk_used_market_write_audit%'
  ) AS ok
  FROM act_def d
  UNION ALL
  SELECT false
  WHERE NOT EXISTS (SELECT 1 FROM act_def)
  LIMIT 1
),
audit_rpc_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE kind = 'rpc'
    AND oid IS NOT NULL
    AND def ILIKE '%public.dk_used_market_write_audit%'
),
write_audit_inserts AS (
  SELECT
    oid IS NOT NULL
    AND def ILIKE '%INSERT INTO public.used_valuation_audit_logs%' AS ok
  FROM fn_meta
  WHERE sig = 'public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)'
  UNION ALL
  SELECT false
  WHERE NOT EXISTS (
    SELECT 1 FROM fn_meta
    WHERE sig = 'public.dk_used_market_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)'
      AND oid IS NOT NULL
  )
  LIMIT 1
),
deferred_n AS (
  SELECT COUNT(*)::int AS n
  FROM (VALUES
    ('used_acquisition_links'),
    ('used_resale_links'),
    ('used_valuation_external_links')
  ) AS t(table_name)
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
),
unrelated_refs AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.oid IS NOT NULL
    AND (
      f.def ILIKE '%public.inventory%'
      OR f.def ILIKE '%public.orders%'
      OR f.def ILIKE '%public.attendance%'
      OR f.def ILIKE '%public.payroll%'
      OR f.def ILIKE '%used_acquisition_links%'
      OR f.def ILIKE '%used_resale_links%'
      OR f.def ILIKE '%used_valuation_external_links%'
    )
),
public_val_fn AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (
      p.proname ILIKE '%valuation%engine%'
      OR p.proname ILIKE 'public_valuation%'
      OR p.proname ILIKE 'backoffice_used_valuation_estimate%'
    )
)
SELECT 1 AS seq, 'helpers.count'::text AS check_name,
       (SELECT n::text FROM helpers_n) AS actual, '5'::text AS expected,
       CASE WHEN (SELECT n FROM helpers_n) = 5 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.count',
       (SELECT n::text FROM rpc_n), '6',
       CASE WHEN (SELECT n FROM rpc_n) = 6 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'security_definer.required',
       (SELECT n::text FROM definer_required_n), '10',
       CASE WHEN (SELECT n FROM helpers_n) = 5
             AND (SELECT n FROM rpc_n) = 6
             AND (SELECT n FROM definer_required_n) = 10
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'search_path.safe',
       (SELECT n::text FROM safe_search_n), '11',
       CASE WHEN (SELECT n FROM helpers_n) = 5
             AND (SELECT n FROM rpc_n) = 6
             AND (SELECT n FROM safe_search_n) = 11
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.admin_guard',
       (SELECT n::text FROM rpc_admin_n), '6',
       CASE WHEN (SELECT n FROM rpc_admin_n) = 6 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'require_admin.guard',
       (SELECT ok::text FROM require_admin_ok), 'true',
       CASE WHEN (SELECT ok FROM require_admin_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.public_execute',
       (SELECT n::text FROM helper_public_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 5
             AND (SELECT n FROM helper_public_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.anon_execute',
       (SELECT n::text FROM helper_anon_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 5
             AND (SELECT n FROM helper_anon_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'helper.auth_execute',
       (SELECT n::text FROM helper_auth_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 5
             AND (SELECT n FROM helper_auth_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rpc.public_execute',
       (SELECT n::text FROM rpc_public_exec), '0',
       CASE WHEN (SELECT n FROM rpc_n) = 6
             AND (SELECT n FROM rpc_public_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'rpc.anon_execute',
       (SELECT n::text FROM rpc_anon_exec), '0',
       CASE WHEN (SELECT n FROM rpc_n) = 6
             AND (SELECT n FROM rpc_anon_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'rpc.auth_execute',
       (SELECT n::text FROM rpc_auth_exec), '6',
       CASE WHEN (SELECT n FROM rpc_auth_exec) = 6 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'rls.market_tables',
       (SELECT n::text FROM rls_market), '3',
       CASE WHEN (SELECT n FROM rls_market) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'anon.direct_access',
       (SELECT n::text FROM anon_direct), '0',
       CASE WHEN (SELECT n FROM anon_direct) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'authenticated.direct_write',
       (SELECT n::text FROM auth_write), '0',
       CASE WHEN (SELECT n FROM auth_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'authenticated.select',
       (SELECT n::text FROM auth_select), '3',
       CASE WHEN (SELECT n FROM auth_select) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'admin_select_policies',
       (SELECT n::text FROM admin_policies), '3',
       CASE WHEN (SELECT n FROM admin_policies) = 3 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'single_active_index',
       (SELECT n::text FROM single_active), '>=1',
       CASE WHEN (SELECT n FROM single_active) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'market_duplicate_index',
       (SELECT n::text FROM market_dup), '>=1',
       CASE WHEN (SELECT n FROM market_dup) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'market_range_constraints',
       (SELECT n::text FROM market_range), '5',
       CASE WHEN (SELECT n FROM market_range) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'audit_append_only',
       (SELECT n::text FROM audit_append), '>=1',
       CASE WHEN (SELECT n FROM audit_append) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'activation.safety_contract',
       (SELECT ok::text FROM activation_ok), 'true',
       CASE WHEN (SELECT ok FROM activation_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'rpc.audit_integration',
       (SELECT n::text FROM audit_rpc_n), '6',
       CASE WHEN (SELECT n FROM audit_rpc_n) = 6
             AND (SELECT ok FROM write_audit_inserts)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'deferred.tables_absent',
       (SELECT n::text FROM deferred_n), '0',
       CASE WHEN (SELECT n FROM deferred_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'unrelated_domain_refs_absent',
       (SELECT n::text FROM unrelated_refs), '0',
       CASE WHEN (SELECT n FROM unrelated_refs) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'policies.write_none',
       (SELECT n::text FROM write_policies), '0',
       CASE WHEN (SELECT n FROM write_policies) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'functions.no_public_valuation',
       (SELECT n::text FROM public_val_fn), '0',
       CASE WHEN (SELECT n FROM public_val_fn) = 0 THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
