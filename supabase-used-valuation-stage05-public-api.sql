-- ============================================================
-- DK Computer｜Stage 05 Public Valuation API
--
-- 建立 service-role-only 公開估價 RPC + DB fixed-window rate limit。
-- Browser 不得直接呼叫；由 Edge Function 以 service_role 呼叫。
-- 真正估價仍 reuse Stage 04：public.dk_used_valuation_compute_v1
-- 不複製公式、不寫案件／結果、不建立 acquisition。
--
-- Public model resolution（僅 Stage 05 service layer）：
--   public.dk_used_valuation_public_model_key(category, brand, model)
--   純格式 canonical key；unique DISTINCT market model 才改寫後交給 compute。
--
-- Rate limit（Command 2，Owner 已決定）：
--   private.used_valuation_rate_limit_buckets
--   public.service_used_valuation_rate_limit(text)
--   20 requests / 5 minutes per salted SHA-256 client hash
--   不存 raw IP / User-Agent
--
-- Owner 複製各 SECTION 到 SQL Editor，必須分開執行：
--   1) P0_PREFLIGHT（read-only；任一 FAIL 則 STOP）
--   2) M1_PUBLIC_SERVICE_API（僅 P0 ALL PASS 後執行）
--   3) M2_VERIFY（M1 成功後；要求 ALL PASS）
-- 本檔不得由 Cursor 對 Production 執行。
-- 不得一次執行整份檔案。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- 純 read-only scoreboard。僅 SELECT / WITH / catalog。
-- 不寫資料、不 CREATE/ALTER/DROP、不 GRANT/REVOKE、無 DO block。
-- 不要求 Production 已有 ACTIVE market / ACTIVE rule（0 或 1 皆可；>1 FAIL）。
-- Stage 05 service function：0 或正確簽名皆可（idempotent retry）。
-- Public model key helper：0 或正確 (text,text,text) 皆可；不得因已存在而 FAIL。
-- Rate-limit table：不存在可；存在則 schema 必須相容，否則 FAIL。
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
stage04_rpc_n AS (
  SELECT (
    (to_regprocedure('public.backoffice_used_valuation_create_rule(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_update_rule(uuid,jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_activate_rule(uuid,text)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_preview(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL)::int
  ) AS n
),
compute_oid AS (
  SELECT to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') AS oid
),
compute_acl AS (
  SELECT
    (SELECT oid FROM compute_oid) IS NOT NULL AS exists,
    CASE
      WHEN (SELECT oid FROM compute_oid) IS NULL THEN true
      ELSE has_function_privilege('anon', (SELECT oid FROM compute_oid), 'EXECUTE')
    END AS anon_exec,
    CASE
      WHEN (SELECT oid FROM compute_oid) IS NULL THEN true
      ELSE has_function_privilege('authenticated', (SELECT oid FROM compute_oid), 'EXECUTE')
    END AS auth_exec
),
stage05_est_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'service_used_valuation_public_estimate'
),
stage05_est_sig AS (
  SELECT to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NOT NULL AS ok
),
stage05_rl_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'service_used_valuation_rate_limit'
),
stage05_rl_sig AS (
  SELECT to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL AS ok
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
anon_market_sel AS (
  SELECT CASE
    WHEN to_regclass('public.used_market_prices') IS NULL THEN true
    ELSE has_table_privilege('anon', 'public.used_market_prices', 'SELECT')
  END AS allowed
),
anon_rule_sel AS (
  SELECT CASE
    WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN true
    ELSE has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT')
  END AS allowed
),
rl_reg AS (
  SELECT to_regclass('private.used_valuation_rate_limit_buckets') AS reg
),
rl_cols AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'private'
    AND c.table_name = 'used_valuation_rate_limit_buckets'
),
rl_bad_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns c
  WHERE c.table_schema = 'private'
    AND c.table_name = 'used_valuation_rate_limit_buckets'
    AND (
      c.column_name ILIKE '%raw_ip%'
      OR c.column_name ILIKE '%user_agent%'
      OR c.column_name = 'ip'
      OR c.column_name = 'client_ip'
    )
),
rl_pk AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'private'
    AND t.relname = 'used_valuation_rate_limit_buckets'
    AND i.indisprimary
    AND pg_get_indexdef(i.indexrelid) ILIKE '%client_hash%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%window_start%'
),
rl_types AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns c
  WHERE c.table_schema = 'private'
    AND c.table_name = 'used_valuation_rate_limit_buckets'
    AND (
      (c.column_name = 'client_hash' AND c.data_type = 'text')
      OR (c.column_name = 'window_start' AND c.data_type = 'timestamp with time zone')
      OR (c.column_name = 'request_count' AND c.data_type = 'integer')
      OR (c.column_name = 'updated_at' AND c.data_type = 'timestamp with time zone')
    )
),
est_browser AS (
  SELECT CASE
    WHEN to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NULL THEN false
    ELSE (
      has_function_privilege('anon', to_regprocedure('public.service_used_valuation_public_estimate(jsonb)'), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure('public.service_used_valuation_public_estimate(jsonb)'), 'EXECUTE')
    )
  END AS allowed
),
rl_browser AS (
  SELECT CASE
    WHEN to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NULL THEN false
    ELSE (
      has_function_privilege('anon', to_regprocedure('public.service_used_valuation_rate_limit(text)'), 'EXECUTE')
      OR has_function_privilege('authenticated', to_regprocedure('public.service_used_valuation_rate_limit(text)'), 'EXECUTE')
    )
  END AS allowed
),
stage05_mk_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'dk_used_valuation_public_model_key'
),
stage05_mk_sig AS (
  SELECT to_regprocedure('public.dk_used_valuation_public_model_key(text,text,text)') IS NOT NULL AS ok
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
UNION ALL SELECT 9, 'helper.compute_v1',
       ((SELECT oid FROM compute_oid) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT oid FROM compute_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'stage04.backoffice_rpc',
       (SELECT n::text FROM stage04_rpc_n), '5',
       CASE WHEN (SELECT n FROM stage04_rpc_n) = 5 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'foundation.single_active_market',
       (SELECT n::text FROM single_market), '>=1',
       CASE WHEN (SELECT n FROM single_market) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'foundation.single_active_rule',
       (SELECT n::text FROM single_rule), '>=1',
       CASE WHEN (SELECT n FROM single_rule) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'helper.compute_anon_execute_denied',
       ((NOT (SELECT anon_exec FROM compute_acl))::text), 'true',
       CASE WHEN (SELECT exists FROM compute_acl) AND NOT (SELECT anon_exec FROM compute_acl) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'helper.compute_auth_execute_denied',
       ((NOT (SELECT auth_exec FROM compute_acl))::text), 'true',
       CASE WHEN (SELECT exists FROM compute_acl) AND NOT (SELECT auth_exec FROM compute_acl) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'stage05.estimate_name_no_conflict',
       ((SELECT n::text FROM stage05_est_n) || '/' || (SELECT ok::text FROM stage05_est_sig)), '0 or jsonb',
       CASE
         WHEN (SELECT n FROM stage05_est_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM stage05_est_n) = 1 AND (SELECT ok FROM stage05_est_sig) THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 16, 'stage05.rate_limit_name_no_conflict',
       ((SELECT n::text FROM stage05_rl_n) || '/' || (SELECT ok::text FROM stage05_rl_sig)), '0 or text',
       CASE
         WHEN (SELECT n FROM stage05_rl_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM stage05_rl_n) = 1 AND (SELECT ok FROM stage05_rl_sig) THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 17, 'deferred.acquisition_absent',
       (to_regclass('public.used_acquisition_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_acquisition_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'deferred.resale_absent',
       (to_regclass('public.used_resale_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_resale_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'deferred.external_links_absent',
       (to_regclass('public.used_valuation_external_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_external_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'anon.market_prices_select_denied',
       ((NOT (SELECT allowed FROM anon_market_sel))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM anon_market_sel) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'anon.rule_select_denied',
       ((NOT (SELECT allowed FROM anon_rule_sel))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM anon_rule_sel) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'active.rule_count_architecture',
       (SELECT n::text FROM active_rule_n), '0 or 1',
       CASE WHEN (SELECT n FROM active_rule_n) IN (0, 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'active.market_count_architecture',
       (SELECT n::text FROM active_market_n), '0 or 1',
       CASE WHEN (SELECT n FROM active_market_n) IN (0, 1) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'rate_limit.table_schema_compatible',
       CASE
         WHEN (SELECT reg FROM rl_reg) IS NULL THEN 'absent'
         ELSE array_to_string((SELECT names FROM rl_cols), ',')
       END, 'absent or exact cols',
       CASE
         WHEN (SELECT reg FROM rl_reg) IS NULL THEN 'PASS'
         WHEN (SELECT names FROM rl_cols) = ARRAY['client_hash','window_start','request_count','updated_at']::text[]
              AND (SELECT n FROM rl_bad_cols) = 0
              AND (SELECT n FROM rl_pk) >= 1
              AND (SELECT n FROM rl_types) = 4
           THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 25, 'private.schema_state',
       (to_regnamespace('private') IS NOT NULL)::text, 'absent or exists',
       'PASS'
UNION ALL SELECT 26, 'stage05.estimate_browser_execute_denied',
       ((NOT (SELECT allowed FROM est_browser))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM est_browser) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'stage05.rate_limit_browser_execute_denied',
       ((NOT (SELECT allowed FROM rl_browser))::text), 'true',
       CASE WHEN NOT (SELECT allowed FROM rl_browser) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'stage05.public_model_key_name_no_conflict',
       ((SELECT n::text FROM stage05_mk_n) || '/' || (SELECT ok::text FROM stage05_mk_sig)), '0 or text,text,text',
       CASE
         WHEN (SELECT n FROM stage05_mk_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM stage05_mk_n) = 1 AND (SELECT ok FROM stage05_mk_sig) THEN 'PASS'
         ELSE 'FAIL'
       END
ORDER BY 1;


-- ============================================================
-- SECTION M1_PUBLIC_SERVICE_API
-- 單一 transaction。可安全重試。
-- 允許：private schema、rate-limit infrastructure table / index、
--       dk_used_valuation_public_model_key、
--       service_used_valuation_rate_limit、service_used_valuation_public_estimate、ACL。
-- 禁止：其他 business table、seed、TRUNCATE、DROP TABLE、CREATE POLICY。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_market_batches') IS NULL
     OR to_regclass('public.used_valuation_rule_versions') IS NULL
     OR to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') IS NULL
     OR to_regprocedure('public.dk_used_valuation_norm_text(text,integer)') IS NULL
     OR to_regprocedure('public.dk_used_valuation_match_key(text)') IS NULL
  THEN
    RAISE EXCEPTION 'M1 blocked: Stage 04 private engine missing.';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.used_valuation_rate_limit_buckets (
  client_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT used_valuation_rate_limit_buckets_pkey PRIMARY KEY (client_hash, window_start),
  CONSTRAINT used_valuation_rate_limit_hash_ck CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT used_valuation_rate_limit_count_ck CHECK (request_count >= 0)
);

CREATE INDEX IF NOT EXISTS used_valuation_rate_limit_buckets_window_start_idx
  ON private.used_valuation_rate_limit_buckets (window_start);

REVOKE ALL ON TABLE private.used_valuation_rate_limit_buckets FROM PUBLIC;
REVOKE ALL ON TABLE private.used_valuation_rate_limit_buckets FROM anon;
REVOKE ALL ON TABLE private.used_valuation_rate_limit_buckets FROM authenticated;

CREATE OR REPLACE FUNCTION public.service_used_valuation_rate_limit(p_client_hash text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_now timestamptz;
  v_window_start timestamptz;
  v_count int;
  v_limit int := 20;
  v_window int := 300;
  v_retry int;
  v_allowed boolean;
BEGIN
  v_hash := pg_catalog.btrim(COALESCE(p_client_hash, ''));
  IF v_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;

  DELETE FROM private.used_valuation_rate_limit_buckets
  WHERE window_start < pg_catalog.now() - interval '24 hours';

  v_now := pg_catalog.now();
  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(pg_catalog.date_part('epoch', v_now) / 300) * 300
  );

  INSERT INTO private.used_valuation_rate_limit_buckets (
    client_hash, window_start, request_count, updated_at
  ) VALUES (
    v_hash, v_window_start, 1, v_now
  )
  ON CONFLICT (client_hash, window_start)
  DO UPDATE SET
    request_count = private.used_valuation_rate_limit_buckets.request_count + 1,
    updated_at = pg_catalog.now()
  RETURNING request_count INTO v_count;

  v_allowed := v_count <= v_limit;
  v_retry := GREATEST(
    0,
    pg_catalog.ceil(
      pg_catalog.date_part('epoch', (v_window_start + (v_window * interval '1 second') - v_now))
    )::int
  );
  IF v_allowed THEN
    v_retry := 0;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'allowed', v_allowed,
    'limit', v_limit,
    'remaining', GREATEST(0, v_limit - v_count),
    'retry_after_seconds', v_retry
  );
END;
$$;

COMMENT ON FUNCTION public.service_used_valuation_rate_limit(text) IS
  'Stage 05 public estimate rate limit. service_role only. Stores salted SHA-256 hash only.';

REVOKE ALL ON FUNCTION public.service_used_valuation_rate_limit(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.service_used_valuation_rate_limit(text) FROM anon;
REVOKE ALL ON FUNCTION public.service_used_valuation_rate_limit(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.service_used_valuation_rate_limit(text) TO service_role;

CREATE OR REPLACE FUNCTION public.dk_used_valuation_public_model_key(
  p_category text,
  p_brand text,
  p_model text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_model text;
  v_brand text;
  v_next text;
  v_len int;
BEGIN
  v_model := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_model, '')));
  IF v_model = '' THEN
    RETURN NULL;
  END IF;

  v_model := pg_catalog.replace(v_model, E'\t', ' ');
  v_model := pg_catalog.replace(v_model, E'\n', ' ');
  v_model := pg_catalog.replace(v_model, E'\r', ' ');
  WHILE pg_catalog.strpos(v_model, '  ') > 0 LOOP
    v_model := pg_catalog.replace(v_model, '  ', ' ');
  END LOOP;
  v_model := pg_catalog.btrim(v_model);
  IF v_model = '' THEN
    RETURN NULL;
  END IF;

  v_brand := public.dk_used_valuation_match_key(p_brand);
  IF v_brand IS NOT NULL THEN
    v_len := pg_catalog.length(v_brand);
    IF pg_catalog.length(v_model) >= v_len
       AND pg_catalog.left(v_model, v_len) = v_brand THEN
      IF pg_catalog.length(v_model) = v_len THEN
        RETURN NULL;
      END IF;
      v_next := pg_catalog.substr(v_model, v_len + 1, 1);
      IF v_next IN (' ', '-', '_') THEN
        v_model := pg_catalog.btrim(
          pg_catalog.ltrim(pg_catalog.substr(v_model, v_len + 1), ' -_')
        );
        WHILE pg_catalog.strpos(v_model, '  ') > 0 LOOP
          v_model := pg_catalog.replace(v_model, '  ', ' ');
        END LOOP;
      END IF;
    END IF;
  END IF;

  IF public.dk_used_valuation_match_key(p_category) = 'cpu'
     AND v_brand = 'intel'
     AND pg_catalog.length(v_model) >= 4
     AND pg_catalog.left(v_model, 4) = 'core' THEN
    IF pg_catalog.length(v_model) = 4 THEN
      RETURN NULL;
    END IF;
    v_next := pg_catalog.substr(v_model, 5, 1);
    IF v_next IN (' ', '-', '_') THEN
      v_model := pg_catalog.btrim(
        pg_catalog.ltrim(pg_catalog.substr(v_model, 5), ' -_')
      );
      WHILE pg_catalog.strpos(v_model, '  ') > 0 LOOP
        v_model := pg_catalog.replace(v_model, '  ', ' ');
      END LOOP;
    END IF;
  END IF;

  IF v_model = '' THEN
    RETURN NULL;
  END IF;

  v_model := pg_catalog.replace(v_model, ' ', '');
  v_model := pg_catalog.replace(v_model, '-', '');
  v_model := pg_catalog.replace(v_model, '_', '');
  RETURN NULLIF(v_model, '');
END;
$$;

COMMENT ON FUNCTION public.dk_used_valuation_public_model_key(text, text, text) IS
  'Stage 05 public model canonical key. Format-only. Internal service use. Not a browser RPC.';

REVOKE ALL ON FUNCTION public.dk_used_valuation_public_model_key(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dk_used_valuation_public_model_key(text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.dk_used_valuation_public_model_key(text, text, text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.service_used_valuation_public_estimate(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comps_in jsonb;
  v_comps jsonb := '[]'::jsonb;
  v_comp jsonb;
  v_key text;
  v_n int := 0;
  v_cat_raw text;
  v_type_raw text;
  v_cat text;
  v_brand text;
  v_model text;
  v_variant text;
  v_txt jsonb;
  v_active_n int;
  v_batch_id uuid;
  v_rule_id uuid;
  v_updated timestamptz;
  v_out jsonb;
  v_ok boolean;
  v_reason text;
  v_matched int;
  v_total int;
  v_unmatched int;
  v_cov int;
  v_reasons jsonb := '[]'::jsonb;
  v_date_text text;
  v_canon text;
  v_models text[];
  v_resolved jsonb;
  v_resolved_model text;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;

  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(p_payload)
  LOOP
    IF v_key IS DISTINCT FROM 'components' THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;
  END LOOP;

  v_comps_in := p_payload->'components';
  IF v_comps_in IS NULL OR pg_catalog.jsonb_typeof(v_comps_in) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;

  v_n := pg_catalog.jsonb_array_length(v_comps_in);
  IF v_n > 20 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'TOO_MANY_COMPONENTS');
  END IF;
  IF v_n < 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;

  v_n := 0;
  FOR v_comp IN SELECT value FROM pg_catalog.jsonb_array_elements(v_comps_in)
  LOOP
    v_n := v_n + 1;
    IF v_comp IS NULL OR pg_catalog.jsonb_typeof(v_comp) IS DISTINCT FROM 'object' THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;

    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_comp)
    LOOP
      IF v_key NOT IN ('category', 'brand', 'model', 'variant', 'component_type') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
      END IF;
    END LOOP;

    FOREACH v_key IN ARRAY ARRAY['category', 'brand', 'model', 'variant', 'component_type']
    LOOP
      v_txt := v_comp->v_key;
      IF v_txt IS NOT NULL AND v_txt <> 'null'::jsonb
         AND pg_catalog.jsonb_typeof(v_txt) IS DISTINCT FROM 'string' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
      END IF;
    END LOOP;

    BEGIN
      v_cat_raw := public.dk_used_valuation_norm_text(v_comp->>'category', 40);
      v_type_raw := public.dk_used_valuation_norm_text(v_comp->>'component_type', 40);
      v_brand := public.dk_used_valuation_norm_text(v_comp->>'brand', 100);
      v_model := public.dk_used_valuation_norm_text(v_comp->>'model', 160);
      v_variant := public.dk_used_valuation_norm_text(v_comp->>'variant', 160);
    EXCEPTION WHEN OTHERS THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END;

    IF v_cat_raw IS NOT NULL THEN
      v_cat := pg_catalog.upper(v_cat_raw);
    ELSE
      v_cat := NULL;
    END IF;
    IF v_type_raw IS NOT NULL THEN
      v_type_raw := pg_catalog.upper(v_type_raw);
    END IF;
    IF v_cat IS NOT NULL AND v_type_raw IS NOT NULL AND v_cat IS DISTINCT FROM v_type_raw THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;
    IF v_cat IS NULL THEN
      v_cat := v_type_raw;
    END IF;
    IF v_cat IS NULL OR v_brand IS NULL OR v_model IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;
    IF v_cat NOT IN (
      'CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'STORAGE', 'PSU', 'CASE', 'COOLER', 'LAPTOP', 'OTHER'
    ) THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;

    v_comps := v_comps || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'category', v_cat,
        'brand', v_brand,
        'model', v_model,
        'variant', COALESCE(v_variant, '')
      )
    );
  END LOOP;

  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_MARKET');
  END IF;
  IF v_active_n <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END IF;
  SELECT b.id, COALESCE(b.published_at, (b.effective_date)::timestamptz, b.created_at)
    INTO v_batch_id, v_updated
  FROM public.used_market_batches b
  WHERE b.status = 'ACTIVE';

  SELECT COUNT(*)::int INTO v_active_n
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';
  IF v_active_n = 0 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_RULE');
  END IF;
  IF v_active_n <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END IF;
  SELECT r.id INTO v_rule_id
  FROM public.used_valuation_rule_versions r
  WHERE r.status = 'ACTIVE';

  v_resolved := '[]'::jsonb;
  FOR v_comp IN SELECT value FROM pg_catalog.jsonb_array_elements(v_comps)
  LOOP
    v_cat := v_comp->>'category';
    v_brand := v_comp->>'brand';
    v_model := v_comp->>'model';
    v_variant := v_comp->>'variant';
    v_resolved_model := v_model;
    v_canon := public.dk_used_valuation_public_model_key(v_cat, v_brand, v_model);
    v_models := NULL;
    IF v_canon IS NOT NULL THEN
      SELECT pg_catalog.array_agg(DISTINCT m.model)
        INTO v_models
        FROM public.used_market_prices AS m
       WHERE m.market_batch_id = v_batch_id
         AND public.dk_used_valuation_match_key(m.category)
             IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_cat)
         AND public.dk_used_valuation_match_key(m.brand)
             IS NOT DISTINCT FROM public.dk_used_valuation_match_key(v_brand)
         AND public.dk_used_valuation_public_model_key(m.category, m.brand, m.model)
             IS NOT DISTINCT FROM v_canon
         AND m.model IS NOT NULL;
      IF v_models IS NOT NULL AND pg_catalog.cardinality(v_models) = 1 THEN
        v_resolved_model := v_models[1];
      END IF;
    END IF;
    v_resolved := v_resolved || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'category', v_cat,
        'brand', v_brand,
        'model', v_resolved_model,
        'variant', COALESCE(v_variant, '')
      )
    );
  END LOOP;
  v_comps := v_resolved;

  BEGIN
    v_out := public.dk_used_valuation_compute_v1(v_comps, v_batch_id, v_rule_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END;

  IF v_out IS NULL OR pg_catalog.jsonb_typeof(v_out) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END IF;

  v_ok := COALESCE((v_out->>'ok')::boolean, false);
  v_reason := NULLIF(v_out->>'reason', '');
  v_matched := COALESCE((v_out->>'matched_component_count')::int, 0);
  v_total := COALESCE((v_out->>'component_count')::int, v_n);
  v_unmatched := COALESCE((v_out->>'unmatched_component_count')::int, 0);

  IF v_ok IS NOT TRUE THEN
    IF v_reason = 'INSUFFICIENT_MARKET_DATA' THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_MARKET_DATA');
    END IF;
    IF v_reason IN ('NO_COMPONENTS') THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
    END IF;
    IF v_reason = 'NO_ACTIVE_RULE_VERSION' THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_RULE');
    END IF;
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END IF;

  IF v_out->'market_low' IS NULL OR v_out->'market_mid' IS NULL OR v_out->'market_high' IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INTERNAL_ERROR');
  END IF;

  v_cov := GREATEST(0, LEAST(100, round(COALESCE((v_out->>'coverage_ratio')::numeric, 0) * 100)::int));
  v_reasons := v_reasons || pg_catalog.jsonb_build_array(
    '已找到 ' || v_matched::text || ' / ' || v_total::text || ' 項可參考行情。'
  );
  IF v_unmatched > 0 THEN
    v_reasons := v_reasons || pg_catalog.jsonb_build_array(
      '部分零件目前沒有足夠行情，本次只計入可匹配項目。'
    );
  END IF;
  IF v_updated IS NOT NULL THEN
    v_date_text := to_char(v_updated AT TIME ZONE 'Asia/Taipei', 'YYYY/MM/DD');
    v_reasons := v_reasons || pg_catalog.jsonb_build_array(
      '行情資料更新日期：' || v_date_text
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'estimate', pg_catalog.jsonb_build_object(
      'market_low', (v_out->>'market_low')::numeric,
      'market_mid', (v_out->>'market_mid')::numeric,
      'market_high', (v_out->>'market_high')::numeric,
      'value_score', COALESCE((v_out->>'value_score')::int, 0),
      'coverage_percent', v_cov,
      'matched_count', v_matched,
      'total_count', v_total,
      'market_updated_at', v_updated,
      'reasons', v_reasons
    )
  );
END;
$$;

COMMENT ON FUNCTION public.service_used_valuation_public_estimate(jsonb) IS
  'Stage 05 public estimate. service_role only. Business read-only. Resolves unique public model formatting then reuses dk_used_valuation_compute_v1.';

REVOKE ALL ON FUNCTION public.service_used_valuation_public_estimate(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.service_used_valuation_public_estimate(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.service_used_valuation_public_estimate(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.service_used_valuation_public_estimate(jsonb) TO service_role;

COMMIT;


-- ============================================================
-- SECTION M2_VERIFY
-- 純 read-only scoreboard。最後一個 statement 必須是本 SELECT。
-- ============================================================

WITH est_oid AS (
  SELECT to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') AS oid
),
rl_oid AS (
  SELECT to_regprocedure('public.service_used_valuation_rate_limit(text)') AS oid
),
est_meta AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile, p.proowner,
         CASE WHEN p.oid IS NULL THEN '' ELSE pg_get_functiondef(p.oid) END AS def
  FROM est_oid f
  LEFT JOIN pg_proc p ON p.oid = f.oid
),
rl_meta AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile, p.proowner,
         CASE WHEN p.oid IS NULL THEN '' ELSE pg_get_functiondef(p.oid) END AS def
  FROM rl_oid f
  LEFT JOIN pg_proc p ON p.oid = f.oid
),
compute_oid AS (
  SELECT to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') AS oid
),
mk_oid AS (
  SELECT to_regprocedure('public.dk_used_valuation_public_model_key(text,text,text)') AS oid
),
mk_meta AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile, p.proowner,
         CASE WHEN p.oid IS NULL THEN '' ELSE pg_get_functiondef(p.oid) END AS def
  FROM mk_oid f
  LEFT JOIN pg_proc p ON p.oid = f.oid
),
mk_search_ok AS (
  SELECT EXISTS (
    SELECT 1
    FROM mk_meta f
    CROSS JOIN LATERAL unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
    WHERE pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
  ) AS ok
),
mk_public_exec AS (
  SELECT COUNT(*)::int AS n
  FROM mk_meta f
  CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f'::"char", f.proowner))) acl
  WHERE f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
),
mk_pos AS (
  SELECT
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'Core i5-12400F') AS k1,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'core i5-12400f') AS k2,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'Core i5 12400F') AS k3,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5-12400F') AS k4,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5 12400F') AS k5,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'Intel Core i5-12400F') AS k6,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'intel i5 12400f') AS k7
),
mk_neg AS (
  SELECT
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5-12400') AS a,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5-12400F') AS b,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5-12400KF') AS c,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i5-12400X') AS d,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', 'i7-12400F') AS e,
    public.dk_used_valuation_public_model_key('CPU', 'Intel', '12400F') AS f,
    public.dk_used_valuation_public_model_key('GPU', 'NVIDIA', 'RTX 3060') AS g,
    public.dk_used_valuation_public_model_key('GPU', 'NVIDIA', 'RTX 3060 Ti') AS h
),
est_search_ok AS (
  SELECT EXISTS (
    SELECT 1
    FROM est_meta f
    CROSS JOIN LATERAL unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
    WHERE pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
  ) AS ok
),
rl_search_ok AS (
  SELECT EXISTS (
    SELECT 1
    FROM rl_meta f
    CROSS JOIN LATERAL unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
    WHERE pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
  ) AS ok
),
est_public_exec AS (
  SELECT COUNT(*)::int AS n
  FROM est_meta f
  CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f'::"char", f.proowner))) acl
  WHERE f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
),
rl_public_exec AS (
  SELECT COUNT(*)::int AS n
  FROM rl_meta f
  CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f'::"char", f.proowner))) acl
  WHERE f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
),
tbl AS (
  SELECT to_regclass('private.used_valuation_rate_limit_buckets') AS reg
),
tbl_cols AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'private' AND c.table_name = 'used_valuation_rate_limit_buckets'
),
tbl_bad AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns c
  WHERE c.table_schema = 'private'
    AND c.table_name = 'used_valuation_rate_limit_buckets'
    AND (
      c.column_name ILIKE '%raw_ip%'
      OR c.column_name ILIKE '%user_agent%'
      OR c.column_name = 'ip'
      OR c.column_name = 'client_ip'
    )
),
tbl_pk AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'private'
    AND t.relname = 'used_valuation_rate_limit_buckets'
    AND i.indisprimary
    AND pg_get_indexdef(i.indexrelid) ILIKE '%client_hash%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%window_start%'
),
tbl_win_idx AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'private'
    AND t.relname = 'used_valuation_rate_limit_buckets'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%window_start%'
),
tbl_types AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns c
  WHERE c.table_schema = 'private'
    AND c.table_name = 'used_valuation_rate_limit_buckets'
    AND (
      (c.column_name = 'client_hash' AND c.data_type = 'text')
      OR (c.column_name = 'window_start' AND c.data_type = 'timestamp with time zone')
      OR (c.column_name = 'request_count' AND c.data_type = 'integer')
      OR (c.column_name = 'updated_at' AND c.data_type = 'timestamp with time zone')
    )
),
tbl_public AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r'::"char", c.relowner))) acl
  WHERE ns.nspname = 'private'
    AND c.relname = 'used_valuation_rate_limit_buckets'
    AND acl.grantee = 0
),
anon_tbl AS (
  SELECT CASE
    WHEN (SELECT reg FROM tbl) IS NULL THEN true
    ELSE (
      has_table_privilege('anon', 'private.used_valuation_rate_limit_buckets', 'SELECT')
      OR has_table_privilege('anon', 'private.used_valuation_rate_limit_buckets', 'INSERT')
      OR has_table_privilege('anon', 'private.used_valuation_rate_limit_buckets', 'UPDATE')
      OR has_table_privilege('anon', 'private.used_valuation_rate_limit_buckets', 'DELETE')
    )
  END AS allowed
),
auth_tbl AS (
  SELECT CASE
    WHEN (SELECT reg FROM tbl) IS NULL THEN true
    ELSE (
      has_table_privilege('authenticated', 'private.used_valuation_rate_limit_buckets', 'SELECT')
      OR has_table_privilege('authenticated', 'private.used_valuation_rate_limit_buckets', 'INSERT')
      OR has_table_privilege('authenticated', 'private.used_valuation_rate_limit_buckets', 'UPDATE')
      OR has_table_privilege('authenticated', 'private.used_valuation_rate_limit_buckets', 'DELETE')
    )
  END AS allowed
),
deferred_n AS (
  SELECT COUNT(*)::int AS n
  FROM (VALUES ('used_acquisition_links'), ('used_resale_links'), ('used_valuation_external_links')) AS t(table_name)
  WHERE to_regclass(format('public.%I', t.table_name)) IS NOT NULL
),
stage06_fn AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (
      p.proname ILIKE '%acquisition%'
      OR p.proname ILIKE '%dk_inspect%'
      OR p.proname ILIKE '%dk_standard%'
    )
)
SELECT 1 AS seq, 'estimate.function_exists'::text AS check_name,
       ((SELECT oid FROM est_oid) IS NOT NULL)::text AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'estimate.security_definer',
       ((SELECT prosecdef FROM est_meta)::text), 'true',
       CASE WHEN (SELECT prosecdef FROM est_meta) IS TRUE THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'estimate.search_path_safe',
       ((SELECT ok FROM est_search_ok)::text), 'true',
       CASE WHEN (SELECT ok FROM est_search_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'estimate.public_execute_denied',
       ((SELECT n::text FROM est_public_exec)), '0',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL AND (SELECT n FROM est_public_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'estimate.anon_execute_denied',
       ((NOT has_function_privilege('anon', (SELECT oid FROM est_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL AND NOT has_function_privilege('anon', (SELECT oid FROM est_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'estimate.authenticated_execute_denied',
       ((NOT has_function_privilege('authenticated', (SELECT oid FROM est_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL AND NOT has_function_privilege('authenticated', (SELECT oid FROM est_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'estimate.service_role_execute_granted',
       (has_function_privilege('service_role', (SELECT oid FROM est_oid), 'EXECUTE')::text), 'true',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL AND has_function_privilege('service_role', (SELECT oid FROM est_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.compute_anon_denied',
       ((NOT has_function_privilege('anon', (SELECT oid FROM compute_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM compute_oid) IS NOT NULL AND NOT has_function_privilege('anon', (SELECT oid FROM compute_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'helper.compute_auth_denied',
       ((NOT has_function_privilege('authenticated', (SELECT oid FROM compute_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM compute_oid) IS NOT NULL AND NOT has_function_privilege('authenticated', (SELECT oid FROM compute_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'active.market_fail_closed',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%used_market_batches%'
             AND (SELECT def FROM est_meta) ILIKE '%NO_ACTIVE_MARKET%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%LIMIT 1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'active.rule_fail_closed',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%used_valuation_rule_versions%'
             AND (SELECT def FROM est_meta) ILIKE '%NO_ACTIVE_RULE%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%LIMIT 1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'input.count_validation',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%TOO_MANY_COMPONENTS%'
             AND (SELECT def FROM est_meta) ILIKE '%jsonb_array_length%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'input.text_length_validation',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_norm_text%'
             AND (SELECT def FROM est_meta) ILIKE '%, 40%'
             AND (SELECT def FROM est_meta) ILIKE '%, 100%'
             AND (SELECT def FROM est_meta) ILIKE '%, 160%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'no_client_batch_id',
       ((SELECT def FROM est_meta) NOT ILIKE '%''market_batch_id''%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%''market_batch_id''%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'no_client_rule_id',
       ((SELECT def FROM est_meta) NOT ILIKE '%p_payload%rule_version_id%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%p_payload%rule_version_id%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'no_client_private_config',
       ((SELECT def FROM est_meta) NOT ILIKE '%p_payload%private_config%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%p_payload%private_config%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'reuse.stage04_compute',
       ((SELECT def FROM est_meta) ILIKE '%dk_used_valuation_compute_v1%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_compute_v1%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'no_duplicated_formula',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_compute_v1%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%condition_multipliers%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%v_weight_num%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'dto.allowlist_keys',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%coverage_percent%'
             AND (SELECT def FROM est_meta) ILIKE '%value_score%'
             AND (SELECT def FROM est_meta) ILIKE '%matched_count%'
             AND (SELECT def FROM est_meta) ILIKE '%market_updated_at%'
             AND (SELECT def FROM est_meta) ILIKE '%reasons%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'dto.forbidden_keys_absent',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%private_config%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%market_snapshot%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%rule_snapshot%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%input_snapshot%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%match_details%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%condition_multipliers%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%recommended_acquisition%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%maximum_acquisition%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%estimated_margin%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%inventory_risk%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'estimate.no_business_dml',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) !~* 'INSERT[[:space:]]+INTO'
             AND (SELECT def FROM est_meta) !~* 'UPDATE[[:space:]]+public\.'
             AND (SELECT def FROM est_meta) !~* 'DELETE[[:space:]]+FROM'
             AND (SELECT def FROM est_meta) NOT ILIKE '%used_valuation_cases%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%used_valuation_results%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%used_valuation_decisions%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%used_valuation_audit%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'estimate.no_dynamic_sql',
       ((SELECT def FROM est_meta) !~* 'EXECUTE[[:space:]]+format')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) !~* 'EXECUTE[[:space:]]+format' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'anon.market_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_market_prices', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_market_prices', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'anon.rule_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'stage06.objects_absent',
       ((SELECT n::text FROM deferred_n) || '/' || (SELECT n::text FROM stage06_fn)), '0/0',
       CASE WHEN (SELECT n FROM deferred_n) = 0 AND (SELECT n FROM stage06_fn) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'private.schema_exists',
       (to_regnamespace('private') IS NOT NULL)::text, 'true',
       CASE WHEN to_regnamespace('private') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'rate_limit.table_exists',
       ((SELECT reg FROM tbl) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT reg FROM tbl) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'rate_limit.columns',
       array_to_string((SELECT names FROM tbl_cols), ','), 'client_hash,window_start,request_count,updated_at',
       CASE WHEN (SELECT names FROM tbl_cols) = ARRAY['client_hash','window_start','request_count','updated_at']::text[] THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'rate_limit.column_types',
       ((SELECT n::text FROM tbl_types)), '4',
       CASE WHEN (SELECT n FROM tbl_types) = 4 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'rate_limit.no_raw_ip_or_ua_column',
       ((SELECT n::text FROM tbl_bad)), '0',
       CASE WHEN (SELECT n FROM tbl_bad) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'rate_limit.primary_key',
       ((SELECT n::text FROM tbl_pk)), '>=1',
       CASE WHEN (SELECT n FROM tbl_pk) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'rate_limit.window_index',
       ((SELECT n::text FROM tbl_win_idx)), '>=1',
       CASE WHEN (SELECT n FROM tbl_win_idx) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'rate_limit.function_exists',
       ((SELECT oid FROM rl_oid) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'rate_limit.security_definer',
       ((SELECT prosecdef FROM rl_meta)::text), 'true',
       CASE WHEN (SELECT prosecdef FROM rl_meta) IS TRUE THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'rate_limit.search_path_safe',
       ((SELECT ok FROM rl_search_ok)::text), 'true',
       CASE WHEN (SELECT ok FROM rl_search_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'rate_limit.public_execute_denied',
       ((SELECT n::text FROM rl_public_exec)), '0',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL AND (SELECT n FROM rl_public_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'rate_limit.anon_execute_denied',
       ((NOT has_function_privilege('anon', (SELECT oid FROM rl_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL AND NOT has_function_privilege('anon', (SELECT oid FROM rl_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'rate_limit.authenticated_execute_denied',
       ((NOT has_function_privilege('authenticated', (SELECT oid FROM rl_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL AND NOT has_function_privilege('authenticated', (SELECT oid FROM rl_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'rate_limit.service_role_execute_granted',
       (has_function_privilege('service_role', (SELECT oid FROM rl_oid), 'EXECUTE')::text), 'true',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL AND has_function_privilege('service_role', (SELECT oid FROM rl_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'rate_limit.table_public_denied',
       ((SELECT n::text FROM tbl_public)), '0',
       CASE WHEN (SELECT reg FROM tbl) IS NOT NULL AND (SELECT n FROM tbl_public) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'rate_limit.table_anon_denied',
       ((NOT (SELECT allowed FROM anon_tbl))::text), 'true',
       CASE WHEN (SELECT reg FROM tbl) IS NOT NULL AND NOT (SELECT allowed FROM anon_tbl) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'rate_limit.table_authenticated_denied',
       ((NOT (SELECT allowed FROM auth_tbl))::text), 'true',
       CASE WHEN (SELECT reg FROM tbl) IS NOT NULL AND NOT (SELECT allowed FROM auth_tbl) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'rate_limit.fixed_window_contract',
       'true', 'true',
       CASE WHEN (SELECT def FROM rl_meta) ILIKE '%v_limit int := 20%'
             AND (SELECT def FROM rl_meta) ILIKE '%v_window int := 300%'
             AND (SELECT def FROM rl_meta) ILIKE '%[0-9a-f]{64}%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'rate_limit.atomic_on_conflict',
       'true', 'true',
       CASE WHEN (SELECT def FROM rl_meta) ILIKE '%ON CONFLICT%'
             AND (SELECT def FROM rl_meta) ILIKE '%request_count + 1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'rate_limit.cleanup_24h_own_table',
       'true', 'true',
       CASE WHEN (SELECT def FROM rl_meta) ILIKE '%24 hours%'
             AND (SELECT def FROM rl_meta) ILIKE '%DELETE FROM private.used_valuation_rate_limit_buckets%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_valuation_cases%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_valuation_results%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_valuation_decisions%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_valuation_audit%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'rate_limit.no_business_table_names',
       'true', 'true',
       CASE WHEN (SELECT def FROM rl_meta) NOT ILIKE '%used_market_batches%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_market_prices%'
             AND (SELECT def FROM rl_meta) NOT ILIKE '%used_valuation_rule_versions%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'estimate.no_condition_grade_passthrough',
       ((SELECT def FROM est_meta) NOT ILIKE '%condition_grade%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%condition_grade%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'estimate.strict_top_level_payload',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%jsonb_object_keys%'
             AND (SELECT def FROM est_meta) ILIKE '%IS DISTINCT FROM%components%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'estimate.sanitized_reasons',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%已找到%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%UNKNOWN_CONDITION_NO_ADJUSTMENT%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'estimate.no_inventory_refs',
       ((SELECT def FROM est_meta) NOT ILIKE '%inventory%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%inventory%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'estimate.no_orders_refs',
       ((SELECT def FROM est_meta) NOT ILIKE '%public.orders%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%public.orders%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'estimate.no_attendance_refs',
       ((SELECT def FROM est_meta) NOT ILIKE '%attendance%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%attendance%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'estimate.no_payroll_refs',
       ((SELECT def FROM est_meta) NOT ILIKE '%payroll%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%payroll%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'helper.public_model_key_exists',
       ((SELECT oid FROM mk_oid) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 55, 'helper.public_model_key_search_path_safe',
       ((SELECT ok FROM mk_search_ok)::text), 'true',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL AND (SELECT ok FROM mk_search_ok) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 56, 'helper.public_model_key_public_execute_denied',
       ((SELECT n::text FROM mk_public_exec)), '0',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL AND (SELECT n FROM mk_public_exec) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 57, 'helper.public_model_key_anon_execute_denied',
       ((NOT has_function_privilege('anon', (SELECT oid FROM mk_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL AND NOT has_function_privilege('anon', (SELECT oid FROM mk_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 58, 'helper.public_model_key_authenticated_execute_denied',
       ((NOT has_function_privilege('authenticated', (SELECT oid FROM mk_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL AND NOT has_function_privilege('authenticated', (SELECT oid FROM mk_oid), 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 59, 'helper.public_model_key_immutable_not_definer',
       ((SELECT provolatile FROM mk_meta)::text || '/' || (SELECT prosecdef FROM mk_meta)::text), 'i/false',
       CASE WHEN (SELECT oid FROM mk_oid) IS NOT NULL
             AND (SELECT provolatile FROM mk_meta)::text = 'i'
             AND (SELECT prosecdef FROM mk_meta) IS NOT TRUE
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'helper.positive_intel_vectors_equal',
       COALESCE((SELECT k1 FROM mk_pos), 'NULL'), 'same non-null key',
       CASE WHEN (SELECT k1 FROM mk_pos) IS NOT NULL
             AND (SELECT k1 FROM mk_pos) = (SELECT k2 FROM mk_pos)
             AND (SELECT k1 FROM mk_pos) = (SELECT k3 FROM mk_pos)
             AND (SELECT k1 FROM mk_pos) = (SELECT k4 FROM mk_pos)
             AND (SELECT k1 FROM mk_pos) = (SELECT k5 FROM mk_pos)
             AND (SELECT k1 FROM mk_pos) = (SELECT k6 FROM mk_pos)
             AND (SELECT k1 FROM mk_pos) = (SELECT k7 FROM mk_pos)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 61, 'helper.negative_vectors_distinct',
       'distinct', 'distinct',
       CASE WHEN (SELECT a FROM mk_neg) IS NOT NULL
             AND (SELECT b FROM mk_neg) IS NOT NULL
             AND (SELECT c FROM mk_neg) IS NOT NULL
             AND (SELECT d FROM mk_neg) IS NOT NULL
             AND (SELECT e FROM mk_neg) IS NOT NULL
             AND (SELECT f FROM mk_neg) IS NOT NULL
             AND (SELECT g FROM mk_neg) IS NOT NULL
             AND (SELECT h FROM mk_neg) IS NOT NULL
             AND (SELECT a FROM mk_neg) IS DISTINCT FROM (SELECT b FROM mk_neg)
             AND (SELECT b FROM mk_neg) IS DISTINCT FROM (SELECT c FROM mk_neg)
             AND (SELECT b FROM mk_neg) IS DISTINCT FROM (SELECT d FROM mk_neg)
             AND (SELECT b FROM mk_neg) IS DISTINCT FROM (SELECT e FROM mk_neg)
             AND (SELECT f FROM mk_neg) IS DISTINCT FROM (SELECT b FROM mk_neg)
             AND (SELECT g FROM mk_neg) IS DISTINCT FROM (SELECT h FROM mk_neg)
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 62, 'estimate.uses_public_model_resolution',
       ((SELECT def FROM est_meta) ILIKE '%dk_used_valuation_public_model_key%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_public_model_key%'
             AND (SELECT def FROM est_meta) ILIKE '%used_market_prices%'
             AND (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_compute_v1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 63, 'estimate.unique_distinct_model_resolution',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%array_agg%DISTINCT%'
             AND (SELECT def FROM est_meta) ILIKE '%cardinality%'
             AND (SELECT def FROM est_meta) ILIKE '% = 1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 64, 'estimate.ambiguity_fail_closed',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%array_agg%DISTINCT%'
             AND (SELECT def FROM est_meta) ILIKE '%cardinality(v_models) = 1%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%LIMIT 1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 65, 'estimate.no_limit_1_guessing',
       ((SELECT def FROM est_meta) NOT ILIKE '%LIMIT 1%')::text, 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%LIMIT 1%' THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 66, 'estimate.no_fuzzy_matching',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%fuzzy%'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%fuzzy%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 67, 'estimate.no_similarity',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%similarity%'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%similarity%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 68, 'estimate.no_levenshtein',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%levenshtein%'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%levenshtein%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 69, 'estimate.no_pg_trgm',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%pg_trgm%'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%pg_trgm%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 70, 'estimate.no_contains_model_matching',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%LIKE %'
             AND (SELECT def FROM est_meta) NOT ILIKE '%ILIKE %'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%LIKE %'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%ILIKE %'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 71, 'estimate.variant_contract_unchanged',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) ILIKE '%''variant'', COALESCE(v_variant, '''')%'
             AND (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_public_model_key(v_cat, v_brand, v_model)%'
             AND (SELECT def FROM est_meta) ILIKE '%dk_used_valuation_public_model_key(m.category, m.brand, m.model)%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 72, 'dto.no_normalization_diagnostics',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_meta) NOT ILIKE '%canonical_model%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%normalized_model%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%matched_market_model%'
             AND (SELECT def FROM est_meta) NOT ILIKE '%resolution_details%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 73, 'helper.public_model_key_no_writes',
       'true', 'true',
       CASE WHEN (SELECT def FROM mk_meta) NOT ILIKE '%INSERT %'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%UPDATE %'
             AND (SELECT def FROM mk_meta) NOT ILIKE '%DELETE %'
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
