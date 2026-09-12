-- ============================================================
-- DK Computer｜Stage 04 Private Valuation Engine
--
-- 建立 Admin 估價規則管理 + server-side V1 市場估值引擎。
-- 不改 Stage 02 schema / RLS。
-- 不建立 public valuation、acquisition、案件 UI。
--
-- Owner 複製各 SECTION 到 SQL Editor，必須分開執行：
--   1) P0_PREFLIGHT（read-only scoreboard；任一 FAIL 則 STOP）
--   2) M1_PRIVATE_ENGINE（僅 P0 ALL PASS 後執行）
--   3) M2_VERIFY（M1 成功後；要求 ALL PASS）
-- 本檔不得由 Cursor 對 Production 執行。
-- 不得一次執行整份檔案。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- 純 read-only scoreboard。僅 SELECT / WITH / catalog。
-- 不寫資料、不 CREATE/ALTER/DROP、不 GRANT/REVOKE、無 DO block。
-- 不要求 Production 已有 ACTIVE rule（0 或 1 皆可；>1 FAIL）。
-- 若 Stage 04 functions 已完整存在：視為可重跑狀態，不是 destructive 訊號。
-- 若僅部分存在：FAIL，STOP，不要跑 M1。
-- ============================================================

WITH t AS (
  SELECT
    to_regclass('public.used_valuation_cases') IS NOT NULL AS cases,
    to_regclass('public.used_valuation_components') IS NOT NULL AS components,
    to_regclass('public.used_market_batches') IS NOT NULL AS batches,
    to_regclass('public.used_market_prices') IS NOT NULL AS prices,
    to_regclass('public.used_valuation_rule_versions') IS NOT NULL AS rules,
    to_regclass('public.used_valuation_results') IS NOT NULL AS results,
    to_regclass('public.used_valuation_decisions') IS NOT NULL AS decisions,
    to_regclass('public.used_valuation_audit_logs') IS NOT NULL AS audit_logs
),
rls AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity IS TRUE
    AND c.relname IN (
      'used_valuation_cases',
      'used_valuation_components',
      'used_market_batches',
      'used_market_prices',
      'used_valuation_rule_versions',
      'used_valuation_results',
      'used_valuation_decisions',
      'used_valuation_audit_logs'
    )
),
pol_rules AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'used_valuation_rule_versions'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']::name[]
    AND NOT (roles && ARRAY['anon']::name[])
    AND NOT (roles && ARRAY['public']::name[])
    AND qual ILIKE '%is_admin()%'
),
single_market AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_market_batches'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
single_rule AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_valuation_rule_versions'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
result_append AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_results'
    AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    AND p.proname = 'used_valuation_results_immutable'
),
audit_append AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_audit_logs'
    AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    AND p.proname = 'used_valuation_audit_immutable'
),
active_rule_n AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN -1
    ELSE (SELECT COUNT(*)::int FROM public.used_valuation_rule_versions WHERE status = 'ACTIVE')
  END AS n
),
active_market_n AS (
  SELECT CASE
    WHEN to_regclass('public.used_market_batches') IS NULL THEN -1
    ELSE (SELECT COUNT(*)::int FROM public.used_market_batches WHERE status = 'ACTIVE')
  END AS n
),
stage04_rpc_n AS (
  SELECT (
    (to_regprocedure('public.backoffice_used_valuation_create_rule(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_update_rule(uuid,jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_activate_rule(uuid,text)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_preview(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL)::int
  ) AS n
),
stage04_helper_n AS (
  SELECT (
    (to_regprocedure('public.dk_used_valuation_require_admin()') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_norm_text(text,integer)') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_match_key(text)') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_validate_rule_config(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_rule_snapshot(uuid)') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') IS NOT NULL)::int
  ) AS n
),
anon_rule_sel AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN true
    ELSE has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT')
  END AS allowed
),
anon_result_sel AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_results') IS NULL THEN true
    ELSE has_table_privilege('anon', 'public.used_valuation_results', 'SELECT')
  END AS allowed
),
auth_rule_write AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN true
    ELSE (
      has_table_privilege('authenticated', 'public.used_valuation_rule_versions', 'INSERT')
      OR has_table_privilege('authenticated', 'public.used_valuation_rule_versions', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.used_valuation_rule_versions', 'DELETE')
    )
  END AS allowed
),
auth_result_write AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_results') IS NULL THEN true
    ELSE (
      has_table_privilege('authenticated', 'public.used_valuation_results', 'INSERT')
      OR has_table_privilege('authenticated', 'public.used_valuation_results', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.used_valuation_results', 'DELETE')
    )
  END AS allowed
)
SELECT 1 AS seq, 'table.used_valuation_cases'::text AS check_name,
       (SELECT cases::text FROM t) AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT cases FROM t) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.used_valuation_components',
       (SELECT components::text FROM t), 'true',
       CASE WHEN (SELECT components FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.used_market_batches',
       (SELECT batches::text FROM t), 'true',
       CASE WHEN (SELECT batches FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.used_market_prices',
       (SELECT prices::text FROM t), 'true',
       CASE WHEN (SELECT prices FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'table.used_valuation_rule_versions',
       (SELECT rules::text FROM t), 'true',
       CASE WHEN (SELECT rules FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'table.used_valuation_results',
       (SELECT results::text FROM t), 'true',
       CASE WHEN (SELECT results FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'table.used_valuation_decisions',
       (SELECT decisions::text FROM t), 'true',
       CASE WHEN (SELECT decisions FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'table.used_valuation_audit_logs',
       (SELECT audit_logs::text FROM t), 'true',
       CASE WHEN (SELECT audit_logs FROM t) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rls.used_core_tables',
       (SELECT n::text FROM rls), '8',
       CASE WHEN (SELECT n FROM rls) = 8 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'policy.rule_admin_select',
       (SELECT n::text FROM pol_rules), '>=1',
       CASE WHEN (SELECT n FROM pol_rules) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'stage03.rpc.create_batch',
       (to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'stage03.rpc.activate_batch',
       (to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'foundation.single_active_market',
       (SELECT n::text FROM single_market), '>=1',
       CASE WHEN (SELECT n FROM single_market) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'foundation.single_active_rule',
       (SELECT n::text FROM single_rule), '>=1',
       CASE WHEN (SELECT n FROM single_rule) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'results.append_only',
       (SELECT n::text FROM result_append), '>=1',
       CASE WHEN (SELECT n FROM result_append) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'audit.append_only',
       (SELECT n::text FROM audit_append), '>=1',
       CASE WHEN (SELECT n FROM audit_append) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'deferred.tables_absent',
       ((to_regclass('public.used_acquisition_links') IS NULL
         AND to_regclass('public.used_resale_links') IS NULL
         AND to_regclass('public.used_valuation_external_links') IS NULL)::text), 'true',
       CASE WHEN to_regclass('public.used_acquisition_links') IS NULL
             AND to_regclass('public.used_resale_links') IS NULL
             AND to_regclass('public.used_valuation_external_links') IS NULL
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'anon.rule_select_denied',
       ((NOT (SELECT allowed FROM anon_rule_sel))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM anon_rule_sel) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'anon.result_select_denied',
       ((NOT (SELECT allowed FROM anon_result_sel))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM anon_result_sel) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'auth.rule_write_denied',
       ((NOT (SELECT allowed FROM auth_rule_write))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM auth_rule_write) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'auth.result_write_denied',
       ((NOT (SELECT allowed FROM auth_result_write))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM auth_result_write) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'active.rule_count',
       (SELECT n::text FROM active_rule_n), '0 or 1',
       CASE WHEN (SELECT n FROM active_rule_n) IN (0, 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'active.market_count',
       (SELECT n::text FROM active_market_n), '0 or 1',
       CASE WHEN (SELECT n FROM active_market_n) IN (0, 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'stage04.rpc_state',
       (SELECT n::text FROM stage04_rpc_n), '0 (fresh) or 5 (retry)',
       CASE WHEN (SELECT n FROM stage04_rpc_n) IN (0, 5) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'stage04.helper_state',
       (SELECT n::text FROM stage04_helper_n), '0 (fresh) or 7 (retry)',
       CASE WHEN (SELECT n FROM stage04_helper_n) IN (0, 7) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;


-- ============================================================
-- SECTION M1_PRIVATE_ENGINE
-- 建立 Admin-only SECURITY DEFINER RPC 與 private helpers。
-- CREATE OR REPLACE：Dashboard 不確定是否成功時可重跑，不會 seed 資料。
-- 不改 Stage 02 tables / policies / indexes。不 seed 規則／案件／結果。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_valuation_rule_versions') IS NULL
     OR to_regclass('public.used_market_batches') IS NULL
     OR to_regclass('public.used_market_prices') IS NULL
     OR to_regclass('public.used_valuation_results') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
  THEN
    RAISE EXCEPTION 'M1 blocked: Stage 02 valuation foundation missing.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_require_admin()
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

CREATE OR REPLACE FUNCTION public.dk_used_valuation_norm_text(p_raw text, p_max int)
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

CREATE OR REPLACE FUNCTION public.dk_used_valuation_match_key(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_raw, ''))), '');
$$;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_validate_rule_config(p_cfg jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_step numeric;
  v_min int;
  v_policy text;
  v_schema int;
  v_key text;
  v_mult numeric;
  v_norm text;
  v_mults jsonb := '{}'::jsonb;
BEGIN
  IF p_cfg IS NULL OR pg_catalog.jsonb_typeof(p_cfg) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid rule config';
  END IF;
  FOR v_key IN
    SELECT k FROM pg_catalog.jsonb_object_keys(p_cfg) AS k
  LOOP
    IF v_key NOT IN (
      'schema_version',
      'rounding_step',
      'unmatched_component_policy',
      'minimum_matched_components',
      'condition_multipliers'
    ) THEN
      RAISE EXCEPTION 'invalid rule config';
    END IF;
  END LOOP;
  v_schema := COALESCE((p_cfg->>'schema_version')::int, 0);
  IF v_schema IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'invalid rule config';
  END IF;
  v_step := COALESCE((p_cfg->>'rounding_step')::numeric, 0);
  IF v_step IS NULL OR v_step < 1 OR v_step > 10000 OR v_step <> trunc(v_step) THEN
    RAISE EXCEPTION 'invalid rule config';
  END IF;
  v_min := COALESCE((p_cfg->>'minimum_matched_components')::int, 0);
  IF v_min IS NULL OR v_min < 1 OR v_min > 100 THEN
    RAISE EXCEPTION 'invalid rule config';
  END IF;
  v_policy := public.dk_used_valuation_norm_text(p_cfg->>'unmatched_component_policy', 40);
  IF v_policy IS DISTINCT FROM 'EXCLUDE' THEN
    RAISE EXCEPTION 'invalid rule config';
  END IF;
  IF p_cfg ? 'condition_multipliers' THEN
    IF pg_catalog.jsonb_typeof(p_cfg->'condition_multipliers') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid rule config';
    END IF;
    FOR v_key, v_mult IN
      SELECT k, (p_cfg->'condition_multipliers'->>k)::numeric
      FROM pg_catalog.jsonb_object_keys(p_cfg->'condition_multipliers') AS k
    LOOP
      v_norm := pg_catalog.upper(public.dk_used_valuation_match_key(v_key));
      IF v_norm IS NULL OR v_norm NOT IN ('A', 'B', 'C') THEN
        RAISE EXCEPTION 'invalid rule config';
      END IF;
      IF v_mults ? v_norm THEN
        RAISE EXCEPTION 'invalid rule config';
      END IF;
      IF v_mult IS NULL OR v_mult < 0.50 OR v_mult > 1.20 THEN
        RAISE EXCEPTION 'invalid rule config';
      END IF;
      v_mults := v_mults || pg_catalog.jsonb_build_object(v_norm, v_mult);
    END LOOP;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'rounding_step', v_step,
    'unmatched_component_policy', 'EXCLUDE',
    'minimum_matched_components', v_min,
    'condition_multipliers', v_mults
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'invalid rule config';
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_rule_snapshot(p_id uuid)
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
    'id', r.id,
    'version_code', r.version_code,
    'status', r.status,
    'schema_version', COALESCE((r.private_config->>'schema_version')::int, 1),
    'rounding_step', (r.private_config->>'rounding_step')::numeric,
    'minimum_matched_components', (r.private_config->>'minimum_matched_components')::int,
    'activated_at', r.activated_at
  )
    INTO v
  FROM public.used_valuation_rule_versions r
  WHERE r.id = p_id;
  RETURN COALESCE(v, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_write_audit(
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
    actor_user_id, action, entity_type, entity_id, reason, before_snapshot, after_snapshot
  ) VALUES (
    p_actor, p_action, p_entity_type, p_entity_id, p_reason,
    COALESCE(p_before, '{}'::jsonb),
    COALESCE(p_after, '{}'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_compute_v1(
  p_components jsonb,
  p_market_batch_id uuid,
  p_rule_version_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg jsonb;
  v_step numeric;
  v_min int;
  v_mults jsonb;
  v_comp jsonb;
  v_cat text;
  v_brand text;
  v_model text;
  v_variant text;
  v_grade text;
  v_n int := 0;
  v_matched int := 0;
  v_unmatched int := 0;
  v_low numeric := 0;
  v_mid numeric := 0;
  v_high numeric := 0;
  v_weight_num numeric := 0;
  v_weight_den numeric := 0;
  v_simple_num numeric := 0;
  v_simple_den numeric := 0;
  v_row public.used_market_prices%ROWTYPE;
  v_cnt int;
  v_mult numeric;
  v_grade_key text;
  v_cond_note text;
  v_matched_arr jsonb := '[]'::jsonb;
  v_unmatched_arr jsonb := '[]'::jsonb;
  v_coverage numeric;
  v_conf int;
  v_score int;
  v_reason text;
  v_ok boolean;
BEGIN
  IF p_components IS NULL OR pg_catalog.jsonb_typeof(p_components) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'NO_COMPONENTS');
  END IF;
  SELECT r.private_config INTO v_cfg
  FROM public.used_valuation_rule_versions r
  WHERE r.id = p_rule_version_id;
  IF v_cfg IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'NO_ACTIVE_RULE_VERSION');
  END IF;
  v_cfg := public.dk_used_valuation_validate_rule_config(v_cfg);
  v_step := (v_cfg->>'rounding_step')::numeric;
  v_min := (v_cfg->>'minimum_matched_components')::int;
  v_mults := COALESCE(v_cfg->'condition_multipliers', '{}'::jsonb);

  FOR v_comp IN SELECT value FROM pg_catalog.jsonb_array_elements(p_components)
  LOOP
    v_n := v_n + 1;
    v_cat := v_comp->>'category';
    v_brand := v_comp->>'brand';
    v_model := v_comp->>'model';
    v_variant := v_comp->>'variant';
    v_grade := v_comp->>'condition_grade';
    v_row := NULL;
    v_cnt := 0;

    SELECT COUNT(*)::int INTO v_cnt
    FROM public.used_market_prices p
    WHERE p.market_batch_id = p_market_batch_id
      AND public.dk_used_valuation_match_key(p.category) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_cat)
      AND public.dk_used_valuation_match_key(p.brand) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_brand)
      AND public.dk_used_valuation_match_key(p.model) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_model)
      AND public.dk_used_valuation_match_key(p.variant) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_variant);

    IF v_cnt = 1 THEN
      SELECT p.* INTO v_row
      FROM public.used_market_prices p
      WHERE p.market_batch_id = p_market_batch_id
        AND public.dk_used_valuation_match_key(p.category) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_cat)
        AND public.dk_used_valuation_match_key(p.brand) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_brand)
        AND public.dk_used_valuation_match_key(p.model) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_model)
        AND public.dk_used_valuation_match_key(p.variant) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_variant);
    ELSIF v_cnt = 0 AND public.dk_used_valuation_match_key(v_variant) IS NOT NULL THEN
      SELECT COUNT(*)::int INTO v_cnt
      FROM public.used_market_prices p
      WHERE p.market_batch_id = p_market_batch_id
        AND public.dk_used_valuation_match_key(p.category) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_cat)
        AND public.dk_used_valuation_match_key(p.brand) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_brand)
        AND public.dk_used_valuation_match_key(p.model) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_model)
        AND public.dk_used_valuation_match_key(p.variant) IS NULL;
      IF v_cnt = 1 THEN
        SELECT p.* INTO v_row
        FROM public.used_market_prices p
        WHERE p.market_batch_id = p_market_batch_id
          AND public.dk_used_valuation_match_key(p.category) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_cat)
          AND public.dk_used_valuation_match_key(p.brand) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_brand)
          AND public.dk_used_valuation_match_key(p.model) IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_model)
          AND public.dk_used_valuation_match_key(p.variant) IS NULL;
      END IF;
    END IF;

    IF v_row.id IS NULL THEN
      v_unmatched := v_unmatched + 1;
      v_unmatched_arr := v_unmatched_arr || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'category', v_cat,
          'brand', v_brand,
          'model', v_model,
          'variant', v_variant,
          'reason', CASE WHEN v_cnt > 1 THEN 'AMBIGUOUS' ELSE 'UNMATCHED' END
        )
      );
    ELSIF v_row.market_low IS NULL
       OR v_row.market_mid IS NULL
       OR v_row.market_high IS NULL
       OR v_row.market_low < 0
       OR v_row.market_mid < v_row.market_low
       OR v_row.market_high < v_row.market_mid THEN
      v_unmatched := v_unmatched + 1;
      v_unmatched_arr := v_unmatched_arr || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'category', v_cat,
          'brand', v_brand,
          'model', v_model,
          'variant', v_variant,
          'reason', 'INVALID_MARKET_PRICE'
        )
      );
    ELSE
      v_matched := v_matched + 1;
      v_mult := 1;
      v_cond_note := NULL;
      v_grade_key := pg_catalog.upper(COALESCE(public.dk_used_valuation_match_key(v_grade), ''));
      IF public.dk_used_valuation_match_key(v_grade) IS NOT NULL THEN
        IF v_grade_key IN ('A', 'B', 'C') AND (v_mults ? v_grade_key) THEN
          v_mult := COALESCE((v_mults->>v_grade_key)::numeric, 1);
        ELSE
          v_cond_note := 'UNKNOWN_CONDITION_NO_ADJUSTMENT';
        END IF;
      END IF;
      v_low := v_low + (v_row.market_low * v_mult);
      v_mid := v_mid + (v_row.market_mid * v_mult);
      v_high := v_high + (v_row.market_high * v_mult);
      v_simple_num := v_simple_num + COALESCE(v_row.confidence, 0);
      v_simple_den := v_simple_den + 1;
      v_weight_num := v_weight_num + (COALESCE(v_row.confidence, 0) * GREATEST(COALESCE(v_row.sample_count, 0), 0));
      v_weight_den := v_weight_den + GREATEST(COALESCE(v_row.sample_count, 0), 0);
      v_matched_arr := v_matched_arr || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'category', v_cat,
          'brand', v_brand,
          'model', v_model,
          'variant', v_variant,
          'market_low', v_row.market_low,
          'market_mid', v_row.market_mid,
          'market_high', v_row.market_high,
          'sample_count', v_row.sample_count,
          'confidence', v_row.confidence,
          'note', v_cond_note
        )
      );
    END IF;
  END LOOP;

  IF v_n < 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'NO_COMPONENTS');
  END IF;

  v_coverage := CASE WHEN v_n > 0 THEN (v_matched::numeric / v_n::numeric) ELSE 0 END;
  IF v_matched > 0 AND v_weight_den > 0 THEN
    v_conf := GREATEST(0, LEAST(100, round(v_weight_num / v_weight_den)::int));
  ELSIF v_matched > 0 AND v_simple_den > 0 THEN
    v_conf := GREATEST(0, LEAST(100, round(v_simple_num / v_simple_den)::int));
  ELSE
    v_conf := 0;
  END IF;
  v_score := GREATEST(0, LEAST(100, round(v_conf * v_coverage)::int));

  IF v_matched < v_min THEN
    v_ok := false;
    v_reason := 'INSUFFICIENT_MARKET_DATA';
    v_low := NULL;
    v_mid := NULL;
    v_high := NULL;
  ELSE
    v_ok := true;
    v_reason := NULL;
    v_low := round(v_low / v_step) * v_step;
    v_mid := round(v_mid / v_step) * v_step;
    v_high := round(v_high / v_step) * v_step;
    IF v_mid < v_low THEN v_mid := v_low; END IF;
    IF v_high < v_mid THEN v_high := v_mid; END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', v_ok,
    'reason', v_reason,
    'market_batch_id', p_market_batch_id,
    'rule_version_id', p_rule_version_id,
    'component_count', v_n,
    'matched_component_count', v_matched,
    'unmatched_component_count', v_unmatched,
    'coverage_ratio', v_coverage,
    'confidence', v_conf,
    'value_score', v_score,
    'market_low', v_low,
    'market_mid', v_mid,
    'market_high', v_high,
    'matched', v_matched_arr,
    'unmatched', v_unmatched_arr
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_create_rule(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_code text;
  v_cfg jsonb;
  v_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'created_by' OR p_payload ? 'created_at'
     OR p_payload ? 'activated_at' OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  v_code := public.dk_used_valuation_norm_text(p_payload->>'version_code', 80);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'version_code required';
  END IF;
  v_cfg := public.dk_used_valuation_validate_rule_config(p_payload->'private_config');
  INSERT INTO public.used_valuation_rule_versions (
    version_code, status, private_config, created_by, activated_at
  ) VALUES (
    v_code, 'DRAFT', v_cfg, v_uid, NULL
  )
  RETURNING id INTO v_id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'RULE_CREATED', 'RULE_VERSION', v_id, NULL,
    '{}'::jsonb, public.dk_used_valuation_rule_snapshot(v_id)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'status', 'DRAFT');
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate version';
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_update_rule(p_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.used_valuation_rule_versions%ROWTYPE;
  v_before jsonb;
  v_code text;
  v_cfg jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'rule_id required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'status' OR p_payload ? 'created_by' OR p_payload ? 'created_at'
     OR p_payload ? 'activated_at' OR p_payload ? 'id' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  SELECT * INTO v_row
  FROM public.used_valuation_rule_versions
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rule not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'RULE_NOT_DRAFT';
  END IF;
  v_before := public.dk_used_valuation_rule_snapshot(p_id);
  v_code := COALESCE(
    public.dk_used_valuation_norm_text(p_payload->>'version_code', 80),
    v_row.version_code
  );
  IF p_payload ? 'private_config' THEN
    v_cfg := public.dk_used_valuation_validate_rule_config(p_payload->'private_config');
  ELSE
    v_cfg := v_row.private_config;
  END IF;
  UPDATE public.used_valuation_rule_versions
     SET version_code = v_code,
         private_config = v_cfg
   WHERE id = p_id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'RULE_UPDATED', 'RULE_VERSION', p_id, NULL,
    v_before, public.dk_used_valuation_rule_snapshot(p_id)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'status', 'DRAFT');
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'duplicate version';
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_activate_rule(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_row public.used_valuation_rule_versions%ROWTYPE;
  v_prev_id uuid;
  v_reason text;
  v_before jsonb;
  v_prev_before jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'rule_id required';
  END IF;
  v_reason := public.dk_used_valuation_norm_text(p_reason, 2000);
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(872314905, 4);
  SELECT * INTO v_row
  FROM public.used_valuation_rule_versions
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rule not found';
  END IF;
  IF v_row.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'RULE_NOT_DRAFT';
  END IF;
  PERFORM public.dk_used_valuation_validate_rule_config(v_row.private_config);
  SELECT r.id INTO v_prev_id
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE'
    AND r.id IS DISTINCT FROM p_id
  FOR UPDATE;
  IF v_prev_id IS NOT NULL THEN
    v_prev_before := public.dk_used_valuation_rule_snapshot(v_prev_id);
    UPDATE public.used_valuation_rule_versions
       SET status = 'RETIRED'
     WHERE id = v_prev_id;
    PERFORM public.dk_used_valuation_write_audit(
      v_uid, 'RULE_RETIRED', 'RULE_VERSION', v_prev_id, v_reason,
      v_prev_before, public.dk_used_valuation_rule_snapshot(v_prev_id)
    );
  END IF;
  v_before := public.dk_used_valuation_rule_snapshot(p_id);
  UPDATE public.used_valuation_rule_versions
     SET status = 'ACTIVE',
         activated_at = pg_catalog.now()
   WHERE id = p_id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'RULE_ACTIVATED', 'RULE_VERSION', p_id, v_reason,
    v_before, public.dk_used_valuation_rule_snapshot(p_id)
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', p_id, 'status', 'ACTIVE', 'retired_rule_id', v_prev_id
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'active rule conflict';
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_preview(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_batch_id uuid;
  v_rule_id uuid;
  v_batch_code text;
  v_rule_code text;
  v_comps jsonb;
  v_out jsonb;
  v_active_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload required';
  END IF;
  IF p_payload ? 'market_batch_id'
     OR p_payload ? 'rule_version_id'
     OR p_payload ? 'private_config'
     OR p_payload ? 'input_snapshot'
     OR p_payload ? 'market_snapshot'
     OR p_payload ? 'rule_snapshot'
     OR p_payload ? 'value_score'
     OR p_payload ? 'market_low'
     OR p_payload ? 'market_mid'
     OR p_payload ? 'market_high' THEN
    RAISE EXCEPTION 'server fields are not client-writable';
  END IF;
  v_comps := p_payload->'components';
  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RAISE EXCEPTION 'NO_ACTIVE_MARKET_BATCH';
  END IF;
  IF v_active_n <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_MARKET_BATCH_CONFLICT';
  END IF;
  SELECT b.id, b.batch_code INTO v_batch_id, v_batch_code
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';
  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RAISE EXCEPTION 'NO_ACTIVE_RULE_VERSION';
  END IF;
  IF v_active_n <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_RULE_VERSION_CONFLICT';
  END IF;
  SELECT r.id, r.version_code INTO v_rule_id, v_rule_code
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';
  v_out := public.dk_used_valuation_compute_v1(v_comps, v_batch_id, v_rule_id);
  RETURN v_out || pg_catalog.jsonb_build_object(
    'market_batch_code', v_batch_code,
    'rule_version_code', v_rule_code
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_run_case(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_batch_id uuid;
  v_rule_id uuid;
  v_batch_code text;
  v_rule_code text;
  v_comps jsonb;
  v_out jsonb;
  v_result_id uuid;
  v_safe_rule jsonb;
  v_active_n int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_case_id IS NULL THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  SELECT * INTO v_case
  FROM public.used_valuation_cases
  WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'category', c.component_type,
      'brand', c.brand,
      'model', c.model,
      'variant', c.variant,
      'condition_grade', c.condition_grade
    )
    ORDER BY c.ordinal, c.created_at
  ), '[]'::jsonb)
    INTO v_comps
  FROM public.used_valuation_components c
  WHERE c.case_id = p_case_id;
  IF v_comps IS NULL OR v_comps = '[]'::jsonb THEN
    RAISE EXCEPTION 'NO_COMPONENTS';
  END IF;
  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RAISE EXCEPTION 'NO_ACTIVE_MARKET_BATCH';
  END IF;
  IF v_active_n <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_MARKET_BATCH_CONFLICT';
  END IF;
  SELECT b.id, b.batch_code INTO v_batch_id, v_batch_code
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';
  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RAISE EXCEPTION 'NO_ACTIVE_RULE_VERSION';
  END IF;
  IF v_active_n <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_RULE_VERSION_CONFLICT';
  END IF;
  SELECT r.id, r.version_code INTO v_rule_id, v_rule_code
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';
  v_out := public.dk_used_valuation_compute_v1(v_comps, v_batch_id, v_rule_id);
  IF COALESCE((v_out->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_out->>'reason', 'INSUFFICIENT_MARKET_DATA');
  END IF;
  v_safe_rule := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'version_code', v_rule_code,
    'rounding_step', (
      SELECT (private_config->>'rounding_step')::numeric
      FROM public.used_valuation_rule_versions
      WHERE id = v_rule_id
    ),
    'minimum_matched_components', (
      SELECT (private_config->>'minimum_matched_components')::int
      FROM public.used_valuation_rule_versions
      WHERE id = v_rule_id
    ),
    'unmatched_component_policy', 'EXCLUDE'
  );
  INSERT INTO public.used_valuation_results (
    case_id,
    market_batch_id,
    rule_version_id,
    market_low,
    market_mid,
    market_high,
    value_score,
    public_reasons,
    market_updated_at,
    input_snapshot,
    market_snapshot,
    rule_snapshot
  ) VALUES (
    p_case_id,
    v_batch_id,
    v_rule_id,
    (v_out->>'market_low')::numeric,
    (v_out->>'market_mid')::numeric,
    (v_out->>'market_high')::numeric,
    (v_out->>'value_score')::int,
    '["已依正式行情與估價規則完成市場估值"]'::jsonb,
    pg_catalog.now(),
    pg_catalog.jsonb_build_object('components', v_comps),
    pg_catalog.jsonb_build_object(
      'market_batch_code', v_batch_code,
      'matched', v_out->'matched',
      'unmatched', v_out->'unmatched',
      'coverage_ratio', v_out->'coverage_ratio',
      'confidence', v_out->'confidence'
    ),
    v_safe_rule
  )
  RETURNING id INTO v_result_id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'VALUATION_RESULT_CREATED', 'VALUATION_RESULT', v_result_id, NULL,
    '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'id', v_result_id,
      'case_id', p_case_id,
      'market_low', v_out->'market_low',
      'market_mid', v_out->'market_mid',
      'market_high', v_out->'market_high',
      'value_score', v_out->'value_score'
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_result_id,
    'case_id', p_case_id
  ) || v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_valuation_require_admin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_norm_text(text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_match_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_validate_rule_config(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_rule_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_write_audit(uuid, text, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_valuation_compute_v1(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.backoffice_used_valuation_create_rule(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_valuation_update_rule(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_valuation_activate_rule(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_valuation_preview(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_valuation_run_case(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_create_rule(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_update_rule(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_activate_rule(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_preview(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_run_case(uuid) TO authenticated;

COMMIT;


-- ============================================================
-- SECTION M2_VERIFY
-- 純 read-only scoreboard。最後一個 statement 必須是本 SELECT。
-- ============================================================

WITH fn_catalog AS (
  SELECT * FROM (
    VALUES
      ('helper'::text, 'public.dk_used_valuation_require_admin()'::text, true),
      ('helper', 'public.dk_used_valuation_norm_text(text,integer)', false),
      ('helper', 'public.dk_used_valuation_match_key(text)', false),
      ('helper', 'public.dk_used_valuation_validate_rule_config(jsonb)', false),
      ('helper', 'public.dk_used_valuation_rule_snapshot(uuid)', true),
      ('helper', 'public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)', true),
      ('helper', 'public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)', true),
      ('rpc', 'public.backoffice_used_valuation_create_rule(jsonb)', true),
      ('rpc', 'public.backoffice_used_valuation_update_rule(uuid,jsonb)', true),
      ('rpc', 'public.backoffice_used_valuation_activate_rule(uuid,text)', true),
      ('rpc', 'public.backoffice_used_valuation_preview(jsonb)', true),
      ('rpc', 'public.backoffice_used_valuation_run_case(uuid)', true)
  ) AS t(kind, sig, needs_definer)
),
fn_rows AS (
  SELECT c.kind, c.sig, c.needs_definer, to_regprocedure(c.sig) AS oid
  FROM fn_catalog c
),
fn_meta AS (
  SELECT f.kind, f.sig, f.needs_definer, f.oid, p.prosecdef, p.proconfig, p.proacl, p.proowner,
         CASE WHEN f.oid IS NULL THEN '' ELSE pg_get_functiondef(f.oid) END AS def
  FROM fn_rows f
  LEFT JOIN pg_proc p ON p.oid = f.oid
),
helpers_n AS (
  SELECT COUNT(*)::int AS n FROM fn_rows WHERE kind = 'helper' AND oid IS NOT NULL
),
rpc_n AS (
  SELECT COUNT(*)::int AS n FROM fn_rows WHERE kind = 'rpc' AND oid IS NOT NULL
),
definer_n AS (
  SELECT COUNT(*)::int AS n FROM fn_meta WHERE needs_definer AND oid IS NOT NULL AND prosecdef IS TRUE
),
search_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.oid IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
      WHERE pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
    )
),
rpc_admin_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE kind = 'rpc' AND oid IS NOT NULL
    AND def ILIKE '%public.is_admin()%'
    AND def ILIKE '%public.dk_used_valuation_require_admin()%'
),
helper_public_exec AS (
  SELECT COUNT(DISTINCT f.oid)::int AS n
  FROM fn_meta f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl, acldefault('f'::"char", f.proowner))) acl
  WHERE f.kind = 'helper' AND f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
),
helper_anon_exec AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.kind = 'helper' AND f.oid IS NOT NULL AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
helper_auth_exec AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.kind = 'helper' AND f.oid IS NOT NULL AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
),
rpc_public_exec AS (
  SELECT COUNT(DISTINCT f.oid)::int AS n
  FROM fn_meta f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl, acldefault('f'::"char", f.proowner))) acl
  WHERE f.kind = 'rpc' AND f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
),
rpc_anon_exec AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.kind = 'rpc' AND f.oid IS NOT NULL AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
rpc_auth_exec AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.kind = 'rpc' AND f.oid IS NOT NULL AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
),
preview_writes AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_preview(jsonb)'
    AND oid IS NOT NULL
    AND (
      def ~* 'INSERT[[:space:]]+INTO'
      OR def ~* 'UPDATE[[:space:]]+public\.'
      OR def ~* 'DELETE[[:space:]]+FROM'
    )
),
run_inserts AS (
  SELECT (
    oid IS NOT NULL
    AND def ILIKE '%INSERT INTO public.used_valuation_results%'
    AND def ILIKE '%INSUFFICIENT_MARKET_DATA%'
  ) AS ok
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_run_case(uuid)'
  LIMIT 1
),
run_acq AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_run_case(uuid)'
    AND oid IS NOT NULL
    AND (
      def ILIKE '%recommended_acquisition%'
      OR def ILIKE '%maximum_acquisition%'
      OR def ILIKE '%estimated_refurbishment_cost%'
      OR def ILIKE '%estimated_resale_price%'
      OR def ILIKE '%estimated_gross_profit%'
      OR def ILIKE '%estimated_margin_pct%'
      OR def ILIKE '%liquidity_level%'
      OR def ILIKE '%market_risk_level%'
      OR def ILIKE '%inventory_risk_level%'
    )
),
run_case_mut AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_run_case(uuid)'
    AND oid IS NOT NULL
    AND (
      def ~* 'UPDATE[[:space:]]+public\.used_valuation_cases'
      OR def ~* 'UPDATE[[:space:]]+public\.used_valuation_components'
      OR def ~* 'DELETE[[:space:]]+FROM'
    )
),
dyn_sql AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE oid IS NOT NULL
    AND def ~* 'EXECUTE[[:space:]]+format'
),
active_limit AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig IN (
      'public.backoffice_used_valuation_preview(jsonb)',
      'public.backoffice_used_valuation_run_case(uuid)'
    )
    AND oid IS NOT NULL
    AND def ILIKE '%LIMIT 1%'
),
used_tables AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname LIKE 'used_%'
),
act_ok AS (
  SELECT (
    def ILIKE '%pg_advisory_xact_lock%'
    AND def ILIKE '%FOR UPDATE%'
    AND def ILIKE '%RETIRED%'
    AND def ILIKE '%ACTIVE%'
    AND def ILIKE '%activated_at%'
    AND def ILIKE '%dk_used_valuation_write_audit%'
  ) AS ok
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_activate_rule(uuid,text)'
  LIMIT 1
),
audit_rpc_n AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE kind = 'rpc' AND oid IS NOT NULL
    AND sig <> 'public.backoffice_used_valuation_preview(jsonb)'
    AND def ILIKE '%dk_used_valuation_write_audit%'
),
unrelated AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta f
  WHERE f.oid IS NOT NULL
    AND (
      f.def ILIKE '%public.inventory%'
      OR f.def ILIKE '%public.orders%'
      OR f.def ILIKE '%public.attendance%'
      OR f.def ILIKE '%public.payroll%'
    )
),
public_val AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.proname ILIKE 'public_valuation%' OR p.proname ILIKE '%valuation%engine%edge%')
),
single_rule AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_valuation_rule_versions'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
single_market AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_market_batches'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
result_append AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_results'
    AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    AND p.proname = 'used_valuation_results_immutable'
),
deferred_n AS (
  SELECT COUNT(*)::int AS n
  FROM (VALUES ('used_acquisition_links'), ('used_resale_links'), ('used_valuation_external_links')) AS t(table_name)
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
),
result_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_valuation_results'
),
comp_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_valuation_components'
),
rule_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_valuation_rule_versions'
),
stage03_rpc AS (
  SELECT (
    to_regprocedure('public.backoffice_used_market_create_batch(jsonb)') IS NOT NULL
    AND to_regprocedure('public.backoffice_used_market_activate_batch(uuid,text)') IS NOT NULL
  ) AS ok
),
rule_admin_sel AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'used_valuation_rule_versions'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']::name[]
    AND NOT (roles && ARRAY['anon']::name[])
    AND NOT (roles && ARRAY['public']::name[])
    AND qual ILIKE '%is_admin()%'
),
auth_write AS (
  SELECT COUNT(*)::int AS n
  FROM (VALUES ('used_valuation_rule_versions'), ('used_valuation_results')) AS t(table_name)
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
    AND (
      has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT')
      OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE')
      OR has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE')
    )
),
preview_audit AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_preview(jsonb)'
    AND oid IS NOT NULL
    AND def ILIKE '%dk_used_valuation_write_audit%'
),
run_audit AS (
  SELECT (
    oid IS NOT NULL
    AND def ILIKE '%dk_used_valuation_write_audit%'
    AND def ILIKE '%VALUATION_RESULT_CREATED%'
  ) AS ok
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_run_case(uuid)'
  LIMIT 1
),
act_reason AS (
  SELECT (oid IS NOT NULL AND def ILIKE '%reason required%') AS ok
  FROM fn_meta
  WHERE sig = 'public.backoffice_used_valuation_activate_rule(uuid,text)'
  LIMIT 1
),
audit_append AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_audit_logs'
    AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    AND p.proname = 'used_valuation_audit_immutable'
),
unqual AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE oid IS NOT NULL
    AND def ~* '(FROM|JOIN|INTO|UPDATE)[[:space:]]+used_'
),
fuzzy AS (
  SELECT COUNT(*)::int AS n
  FROM fn_meta
  WHERE sig = 'public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)'
    AND oid IS NOT NULL
    AND (
      def ~* '(^|[^A-Za-z_])LIKE([^A-Za-z_]|$)'
      OR def ILIKE '%similarity%'
      OR def ILIKE '%levenshtein%'
    )
),
valid_ok AS (
  SELECT (
    oid IS NOT NULL
    AND def ILIKE '%schema_version%'
    AND def ILIKE '%rounding_step%'
    AND def ILIKE '%minimum_matched_components%'
    AND def ILIKE '%EXCLUDE%'
    AND def ILIKE '%jsonb_object_keys%'
    AND def ILIKE '%condition_multipliers%'
  ) AS ok
  FROM fn_meta
  WHERE sig = 'public.dk_used_valuation_validate_rule_config(jsonb)'
  LIMIT 1
),
cond_ok AS (
  SELECT (
    oid IS NOT NULL
    AND def ILIKE '%condition_multipliers%'
    AND def LIKE '%''A''%'
    AND def LIKE '%''B''%'
    AND def LIKE '%''C''%'
  ) AS ok
  FROM fn_meta
  WHERE sig = 'public.dk_used_valuation_validate_rule_config(jsonb)'
  LIMIT 1
),
policy_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'used_valuation_cases',
      'used_valuation_components',
      'used_market_batches',
      'used_market_prices',
      'used_valuation_rule_versions',
      'used_valuation_results',
      'used_valuation_decisions',
      'used_valuation_audit_logs'
    )
),
policy_write AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'used_valuation_cases',
      'used_valuation_components',
      'used_market_batches',
      'used_market_prices',
      'used_valuation_rule_versions',
      'used_valuation_results',
      'used_valuation_decisions',
      'used_valuation_audit_logs'
    )
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
),
anon_rule_sel AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN true
    ELSE has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT')
  END AS allowed
),
inv_refs AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.oid IS NOT NULL AND f.def ILIKE '%public.inventory%'
),
ord_refs AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.oid IS NOT NULL AND f.def ILIKE '%public.orders%'
),
att_refs AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.oid IS NOT NULL AND f.def ILIKE '%public.attendance%'
),
pay_refs AS (
  SELECT COUNT(*)::int AS n FROM fn_meta f
  WHERE f.oid IS NOT NULL AND f.def ILIKE '%public.payroll%'
)
SELECT 1 AS seq, 'helpers.count'::text AS check_name,
       (SELECT n::text FROM helpers_n) AS actual, '7'::text AS expected,
       CASE WHEN (SELECT n FROM helpers_n) = 7 THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'rpc.count',
       (SELECT n::text FROM rpc_n), '5',
       CASE WHEN (SELECT n FROM rpc_n) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'security_definer.required',
       (SELECT n::text FROM definer_n), '9',
       CASE WHEN (SELECT n FROM helpers_n) = 7 AND (SELECT n FROM rpc_n) = 5 AND (SELECT n FROM definer_n) = 9 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'search_path.safe',
       (SELECT n::text FROM search_n), '12',
       CASE WHEN (SELECT n FROM search_n) = 12 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'rpc.admin_guard',
       (SELECT n::text FROM rpc_admin_n), '5',
       CASE WHEN (SELECT n FROM rpc_admin_n) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.public_execute',
       (SELECT n::text FROM helper_public_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 7 AND (SELECT n FROM helper_public_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.anon_execute',
       (SELECT n::text FROM helper_anon_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 7 AND (SELECT n FROM helper_anon_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.auth_execute',
       (SELECT n::text FROM helper_auth_exec), '0',
       CASE WHEN (SELECT n FROM helpers_n) = 7 AND (SELECT n FROM helper_auth_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'rpc.public_execute',
       (SELECT n::text FROM rpc_public_exec), '0',
       CASE WHEN (SELECT n FROM rpc_n) = 5 AND (SELECT n FROM rpc_public_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rpc.anon_execute',
       (SELECT n::text FROM rpc_anon_exec), '0',
       CASE WHEN (SELECT n FROM rpc_n) = 5 AND (SELECT n FROM rpc_anon_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'rpc.auth_execute',
       (SELECT n::text FROM rpc_auth_exec), '5',
       CASE WHEN (SELECT n FROM rpc_auth_exec) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'authenticated.direct_write',
       (SELECT n::text FROM auth_write), '0',
       CASE WHEN (SELECT n FROM auth_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'single_active_rule',
       (SELECT n::text FROM single_rule), '>=1',
       CASE WHEN (SELECT n FROM single_rule) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'single_active_market',
       (SELECT n::text FROM single_market), '>=1',
       CASE WHEN (SELECT n FROM single_market) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'results.append_only',
       (SELECT n::text FROM result_append), '>=1',
       CASE WHEN (SELECT n FROM result_append) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'preview.no_writes',
       (SELECT n::text FROM preview_writes), '0',
       CASE WHEN (SELECT n FROM preview_writes) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'run_case.inserts_result',
       (SELECT ok::text FROM run_inserts), 'true',
       CASE WHEN (SELECT ok FROM run_inserts) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'activation.safety_contract',
       (SELECT ok::text FROM act_ok), 'true',
       CASE WHEN (SELECT ok FROM act_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'rpc.audit_integration',
       (SELECT n::text FROM audit_rpc_n), '4',
       CASE WHEN (SELECT n FROM audit_rpc_n) = 4 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'unrelated_domain_refs_absent',
       (SELECT n::text FROM unrelated), '0',
       CASE WHEN (SELECT n FROM unrelated) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'functions.no_public_valuation',
       (SELECT n::text FROM public_val), '0',
       CASE WHEN (SELECT n FROM public_val) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'deferred.tables_absent',
       (SELECT n::text FROM deferred_n), '0',
       CASE WHEN (SELECT n FROM deferred_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'stage02.results_column_count',
       (SELECT n::text FROM result_cols), '23',
       CASE WHEN (SELECT n FROM result_cols) = 23 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'stage02.components_column_count',
       (SELECT n::text FROM comp_cols), '14',
       CASE WHEN (SELECT n FROM comp_cols) = 14 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'stage02.rules_column_count',
       (SELECT n::text FROM rule_cols), '7',
       CASE WHEN (SELECT n FROM rule_cols) = 7 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'stage03.market_rpc_present',
       (SELECT ok::text FROM stage03_rpc), 'true',
       CASE WHEN (SELECT ok FROM stage03_rpc) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'policy.rule_admin_select',
       (SELECT n::text FROM rule_admin_sel), '>=1',
       CASE WHEN (SELECT n FROM rule_admin_sel) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'run_case.no_acquisition_fields',
       (SELECT n::text FROM run_acq), '0',
       CASE WHEN (SELECT n FROM run_acq) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'run_case.no_case_mutation',
       (SELECT n::text FROM run_case_mut), '0',
       CASE WHEN (SELECT n FROM run_case_mut) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'functions.no_dynamic_sql',
       (SELECT n::text FROM dyn_sql), '0',
       CASE WHEN (SELECT n FROM dyn_sql) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'active_selection.fail_closed',
       (SELECT n::text FROM active_limit), '0',
       CASE WHEN (SELECT n FROM active_limit) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'stage02.used_table_count',
       (SELECT n::text FROM used_tables), '8',
       CASE WHEN (SELECT n FROM used_tables) = 8 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'preview.no_audit',
       (SELECT n::text FROM preview_audit), '0',
       CASE WHEN (SELECT n FROM preview_audit) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'run_case.inserts_audit',
       (SELECT ok::text FROM run_audit), 'true',
       CASE WHEN (SELECT ok FROM run_audit) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'audit.append_only',
       (SELECT n::text FROM audit_append), '>=1',
       CASE WHEN (SELECT n FROM audit_append) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'activation.reason_required',
       (SELECT ok::text FROM act_reason), 'true',
       CASE WHEN (SELECT ok FROM act_reason) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'schema_qualified.unqualified_used_refs',
       (SELECT n::text FROM unqual), '0',
       CASE WHEN (SELECT n FROM unqual) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'validate.strict_private_config',
       (SELECT ok::text FROM valid_ok), 'true',
       CASE WHEN (SELECT ok FROM valid_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'validate.condition_allowlist',
       (SELECT ok::text FROM cond_ok), 'true',
       CASE WHEN (SELECT ok FROM cond_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'matching.no_fuzzy',
       (SELECT n::text FROM fuzzy), '0',
       CASE WHEN (SELECT n FROM fuzzy) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'anon.rule_select_denied',
       ((NOT (SELECT allowed FROM anon_rule_sel))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM anon_rule_sel) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'policy.count_unchanged',
       (SELECT n::text FROM policy_n), '8',
       CASE WHEN (SELECT n FROM policy_n) = 8 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'policy.no_write_policies',
       (SELECT n::text FROM policy_write), '0',
       CASE WHEN (SELECT n FROM policy_write) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'refs.inventory',
       (SELECT n::text FROM inv_refs), '0',
       CASE WHEN (SELECT n FROM inv_refs) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'refs.orders',
       (SELECT n::text FROM ord_refs), '0',
       CASE WHEN (SELECT n FROM ord_refs) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'refs.attendance',
       (SELECT n::text FROM att_refs), '0',
       CASE WHEN (SELECT n FROM att_refs) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'refs.payroll',
       (SELECT n::text FROM pay_refs), '0',
       CASE WHEN (SELECT n FROM pay_refs) = 0 THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
