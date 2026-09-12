-- ============================================================
-- DK Computer｜Stage 06 Internal Acquisition Workflow
--
-- 內部收購案件：Admin-only RPC + used_acquisition_links。
-- 沿用 Stage 02 decisions schema（不 ALTER 欄位）。
-- 沿用 Stage 04 backoffice_used_valuation_run_case 做市場估值。
-- 不修改 Stage 03 / 04 / 05 SQL，不寫 inventory / orders。
--
-- Owner 複製各 SECTION 到 SQL Editor，必須分開執行：
--   1) P0_PREFLIGHT（read-only；任一 FAIL 則 STOP）
--   2) M1_ACQUISITION（僅 P0 ALL PASS 後執行）
--   3) M2_VERIFY（M1 成功後；要求 ALL PASS）
-- 本檔不得由 Cursor 對 Production 執行。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- 純 read-only scoreboard。不寫資料、不 CREATE/ALTER/DROP。
-- Stage 06 objects：0 或正確簽名皆可（idempotent retry）。
-- ============================================================

WITH core AS (
  SELECT
    to_regclass('public.used_valuation_cases') IS NOT NULL AS cases,
    to_regclass('public.used_valuation_components') IS NOT NULL AS components,
    to_regclass('public.used_valuation_results') IS NOT NULL AS results,
    to_regclass('public.used_valuation_decisions') IS NOT NULL AS decisions,
    to_regclass('public.used_valuation_audit_logs') IS NOT NULL AS audit_logs,
    to_regclass('public.used_market_batches') IS NOT NULL AS batches,
    to_regclass('public.used_valuation_rule_versions') IS NOT NULL AS rules
),
helpers AS (
  SELECT
    to_regprocedure('public.is_admin()') IS NOT NULL AS is_admin,
    to_regprocedure('public.dk_used_valuation_require_admin()') IS NOT NULL AS require_admin,
    to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL AS run_case,
    to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') IS NOT NULL AS compute,
    to_regprocedure('public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NOT NULL AS write_audit
),
imm AS (
  SELECT
    to_regprocedure('public.used_valuation_results_immutable()') IS NOT NULL AS results_imm,
    to_regprocedure('public.used_valuation_decisions_immutable()') IS NOT NULL AS decisions_imm,
    to_regprocedure('public.used_valuation_audit_immutable()') IS NOT NULL AS audit_imm
),
stage05 AS (
  SELECT
    to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NOT NULL AS estimate,
    to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL AS rate_limit
),
acq_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_acquisition_links' AND c.relkind = 'r'
),
acq_cols_p0 AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'used_acquisition_links'
),
acq_expected AS (
  SELECT ARRAY[
    'id','case_id','decision_id','actual_acquisition_price','acquired_at','note','created_by','created_at'
  ]::text[] AS names
),
resale_n AS (
  SELECT
    (to_regclass('public.used_resale_links') IS NOT NULL)::int
    + (to_regclass('public.used_valuation_external_links') IS NOT NULL)::int AS n
),
rpc_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'backoffice_used_acquisition_preview',
      'backoffice_used_acquisition_create_decision',
      'backoffice_used_acquisition_record_offer',
      'backoffice_used_acquisition_create_case',
      'backoffice_used_acquisition_replace_components',
      'backoffice_used_acquisition_set_status',
      'backoffice_used_acquisition_mark_acquired',
      'backoffice_used_acquisition_list_cases',
      'backoffice_used_acquisition_get_case',
      'backoffice_used_acquisition_run_valuation'
    )
),
rpc_sig AS (
  SELECT (
    (to_regprocedure('public.backoffice_used_acquisition_preview(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_create_decision(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_record_offer(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_create_case(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_replace_components(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_set_status(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_mark_acquired(jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_list_cases()') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_get_case(uuid)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_acquisition_run_valuation(uuid)') IS NOT NULL)::int
  ) AS n
),
dec_pol AS (
  SELECT COALESCE(array_agg(p.polname::text ORDER BY p.polname), ARRAY[]::text[]) AS names
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_decisions'
),
dec_staff AS (
  SELECT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relname = 'used_valuation_decisions'
      AND p.polcmd = 'r'
      AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_enabled_backoffice_user%'
  ) AS backoffice_select
),
dec_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_valuation_decisions'
    AND column_name IN (
      'id', 'case_id', 'valuation_result_id',
      'system_recommended_acquisition', 'system_maximum_acquisition',
      'final_offer', 'reason', 'actor_user_id', 'created_at'
    )
)
SELECT 1 AS seq, 'table.used_valuation_cases'::text AS check_name,
       (SELECT cases::text FROM core) AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT cases FROM core) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.used_valuation_components',
       (SELECT components::text FROM core), 'true',
       CASE WHEN (SELECT components FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.used_valuation_results',
       (SELECT results::text FROM core), 'true',
       CASE WHEN (SELECT results FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.used_valuation_decisions',
       (SELECT decisions::text FROM core), 'true',
       CASE WHEN (SELECT decisions FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'table.used_valuation_audit_logs',
       (SELECT audit_logs::text FROM core), 'true',
       CASE WHEN (SELECT audit_logs FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'helper.is_admin',
       (SELECT is_admin::text FROM helpers), 'true',
       CASE WHEN (SELECT is_admin FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.require_admin',
       (SELECT require_admin::text FROM helpers), 'true',
       CASE WHEN (SELECT require_admin FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'rpc.run_case',
       (SELECT run_case::text FROM helpers), 'true',
       CASE WHEN (SELECT run_case FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'helper.compute_v1',
       (SELECT compute::text FROM helpers), 'true',
       CASE WHEN (SELECT compute FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'helper.write_audit',
       (SELECT write_audit::text FROM helpers), 'true',
       CASE WHEN (SELECT write_audit FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'append_only.results',
       (SELECT results_imm::text FROM imm), 'true',
       CASE WHEN (SELECT results_imm FROM imm) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'append_only.decisions',
       (SELECT decisions_imm::text FROM imm), 'true',
       CASE WHEN (SELECT decisions_imm FROM imm) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'append_only.audit',
       (SELECT audit_imm::text FROM imm), 'true',
       CASE WHEN (SELECT audit_imm FROM imm) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'stage05.estimate_untouched',
       (SELECT estimate::text FROM stage05), 'true',
       CASE WHEN (SELECT estimate FROM stage05) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'stage05.rate_limit_untouched',
       (SELECT rate_limit::text FROM stage05), 'true',
       CASE WHEN (SELECT rate_limit FROM stage05) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'decisions.core_columns',
       (SELECT n::text FROM dec_cols), '9',
       CASE WHEN (SELECT n FROM dec_cols) = 9 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'decisions.select_policy_present',
       array_to_string((SELECT names FROM dec_pol), ','), 'present',
       CASE WHEN COALESCE(array_length((SELECT names FROM dec_pol), 1), 0) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'decisions.staff_select_exposure_detected',
       CASE WHEN (SELECT backoffice_select FROM dec_staff) THEN 'backoffice' ELSE 'not_backoffice' END,
       'detected',
       'PASS'
UNION ALL SELECT 19, 'used_acquisition_links.state',
       CASE
         WHEN (SELECT n FROM acq_n) = 0 THEN 'absent'
         WHEN (SELECT n FROM acq_n) = 1
              AND (SELECT names FROM acq_cols_p0) = (SELECT names FROM acq_expected)
           THEN 'compatible'
         WHEN (SELECT n FROM acq_n) = 1 THEN 'incompatible'
         ELSE (SELECT n::text FROM acq_n)
       END,
       'absent or compatible',
       CASE
         WHEN (SELECT n FROM acq_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM acq_n) = 1
              AND (SELECT names FROM acq_cols_p0) = (SELECT names FROM acq_expected)
           THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 20, 'stage07.resale_absent',
       (SELECT n::text FROM resale_n), '0',
       CASE WHEN (SELECT n FROM resale_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'stage06.rpc_name_no_conflict',
       ((SELECT n::text FROM rpc_n) || '/' || (SELECT n::text FROM rpc_sig)), '0 or 10/10',
       CASE
         WHEN (SELECT n FROM rpc_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM rpc_n) = 10 AND (SELECT n FROM rpc_sig) = 10 THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 22, 'anon.decisions_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'stage04.market_batches',
       (SELECT batches::text FROM core), 'true',
       CASE WHEN (SELECT batches FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'stage04.rule_versions',
       (SELECT rules::text FROM core), 'true',
       CASE WHEN (SELECT rules FROM core) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;


-- ============================================================
-- SECTION M1_ACQUISITION
-- 單一 transaction。可安全重試。
-- 允許：used_acquisition_links、Stage 06 helpers/RPC、decisions Admin-only SELECT。
-- 禁止：ALTER Stage 02 欄位、seed、inventory / resale / CRM。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_valuation_cases') IS NULL
     OR to_regclass('public.used_valuation_decisions') IS NULL
     OR to_regclass('public.used_valuation_results') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.dk_used_valuation_require_admin()') IS NULL
     OR to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NULL
     OR to_regprocedure('public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NULL
  THEN
    RAISE EXCEPTION 'M1 blocked: Stage 02/04 foundation missing.';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.used_acquisition_links (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.used_valuation_cases(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES public.used_valuation_decisions(id) ON DELETE RESTRICT,
  actual_acquisition_price numeric NOT NULL,
  acquired_at timestamptz NOT NULL,
  note text NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_acquisition_links_case_uidx UNIQUE (case_id),
  CONSTRAINT used_acquisition_links_price_ck CHECK (actual_acquisition_price >= 0),
  CONSTRAINT used_acquisition_links_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 2000)
);

COMMENT ON TABLE public.used_acquisition_links IS
  'Stage 06 actual acquisition event. One row per case. INSERT-only.';

ALTER TABLE public.used_acquisition_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.used_acquisition_links FROM PUBLIC;
REVOKE ALL ON TABLE public.used_acquisition_links FROM anon;
REVOKE ALL ON TABLE public.used_acquisition_links FROM authenticated;
GRANT SELECT ON TABLE public.used_acquisition_links TO authenticated;

DROP POLICY IF EXISTS used_acquisition_links_select_admin ON public.used_acquisition_links;
CREATE POLICY used_acquisition_links_select_admin
  ON public.used_acquisition_links
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.used_acquisition_links_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'used_acquisition_links is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_used_acquisition_links_immutable ON public.used_acquisition_links;
CREATE TRIGGER trg_used_acquisition_links_immutable
  BEFORE UPDATE OR DELETE ON public.used_acquisition_links
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_acquisition_links_immutable();

REVOKE ALL ON FUNCTION public.used_acquisition_links_immutable() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS used_valuation_decisions_select_backoffice ON public.used_valuation_decisions;
DROP POLICY IF EXISTS used_valuation_decisions_select_admin ON public.used_valuation_decisions;
CREATE POLICY used_valuation_decisions_select_admin
  ON public.used_valuation_decisions
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_floor_amount(p_amount numeric, p_step numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_amount IS NULL OR p_step IS NULL OR p_step < 1 THEN NULL
    WHEN p_amount <= 0 THEN 0
    ELSE p_step * pg_catalog.floor(p_amount / p_step)
  END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_compute_v1(
  p_resale numeric,
  p_refurb numeric,
  p_margin_pct numeric,
  p_reserve numeric,
  p_step numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_profit numeric;
  v_raw_max numeric;
  v_max numeric;
  v_raw_rec numeric;
  v_rec numeric;
  v_gross numeric;
  v_margin numeric;
BEGIN
  IF p_resale IS NULL OR p_resale <= 0
     OR p_refurb IS NULL OR p_refurb < 0
     OR p_margin_pct IS NULL OR p_margin_pct < 1 OR p_margin_pct > 90
     OR p_reserve IS NULL OR p_reserve < 0
     OR p_step IS NULL OR p_step < 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;
  v_profit := p_resale * (p_margin_pct / 100);
  v_raw_max := p_resale - p_refurb - v_profit;
  IF v_raw_max <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'UNECONOMIC_ACQUISITION');
  END IF;
  v_max := public.dk_used_acquisition_floor_amount(v_raw_max, p_step);
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'UNECONOMIC_ACQUISITION');
  END IF;
  v_raw_rec := v_max - p_reserve;
  v_rec := public.dk_used_acquisition_floor_amount(v_raw_rec, p_step);
  IF v_rec IS NULL OR v_rec < 0 THEN
    v_rec := 0;
  END IF;
  IF v_rec > v_max THEN
    v_rec := v_max;
  END IF;
  v_gross := p_resale - v_rec - p_refurb;
  IF p_resale > 0 THEN
    v_margin := (v_gross / p_resale) * 100;
  ELSE
    v_margin := NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'estimated_resale_price', p_resale::numeric(14, 2),
    'estimated_refurbishment_cost', p_refurb::numeric(14, 2),
    'target_margin_pct', p_margin_pct::numeric(8, 4),
    'risk_reserve_amount', p_reserve::numeric(14, 2),
    'rounding_step', p_step,
    'recommended_acquisition', v_rec,
    'maximum_acquisition', v_max,
    'estimated_gross_profit', v_gross::numeric(14, 2),
    'estimated_margin_pct', v_margin::numeric(8, 4)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_encode_reason(p_snap jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v text;
  t text;
BEGIN
  IF p_snap IS NULL OR pg_catalog.jsonb_typeof(p_snap) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  t := p_snap->>'record_type';
  IF t IS NULL OR t NOT IN ('ACQUISITION_EVALUATION', 'OFFER') THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  v := pg_catalog.btrim(COALESCE(p_snap::text, ''));
  IF v = '' OR pg_catalog.length(v) > 2000 THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_parse_reason(p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v jsonb;
  t text;
BEGIN
  IF p_reason IS NULL OR pg_catalog.btrim(p_reason) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v := p_reason::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF pg_catalog.jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  t := v->>'record_type';
  IF t IS NULL OR t NOT IN ('ACQUISITION_EVALUATION', 'OFFER') THEN
    RETURN NULL;
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_reason_type(p_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT public.dk_used_acquisition_parse_reason(p_reason)->>'record_type';
$$;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_rounding_step(
  p_rule_snapshot jsonb,
  p_rule_version_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v numeric;
BEGIN
  IF p_rule_snapshot IS NOT NULL
     AND p_rule_snapshot ? 'rounding_step'
     AND pg_catalog.jsonb_typeof(p_rule_snapshot->'rounding_step') = 'number' THEN
    BEGIN
      v := (p_rule_snapshot->>'rounding_step')::numeric;
    EXCEPTION WHEN others THEN
      v := NULL;
    END;
  END IF;
  IF v IS NULL OR v < 1 THEN
    SELECT (r.private_config->>'rounding_step')::numeric
      INTO v
    FROM public.used_valuation_rule_versions r
    WHERE r.id = p_rule_version_id;
  END IF;
  IF v IS NULL OR v < 1 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_acquisition_floor_amount(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_acquisition_compute_v1(numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_acquisition_encode_reason(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_acquisition_parse_reason(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_acquisition_reason_type(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dk_used_acquisition_rounding_step(jsonb, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_used_acquisition_read_inputs(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_refurb numeric;
  v_margin numeric;
  v_reserve numeric;
  v_liq text;
  v_mkt text;
  v_inv text;
  v_note text;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'estimated_refurbishment_cost') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END IF;
  BEGIN
    v_refurb := (p_payload->>'estimated_refurbishment_cost')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END;
  IF v_refurb IS NULL
     OR v_refurb::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_refurb < 0
     OR v_refurb > 10000000 THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'target_margin_pct') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_TARGET_MARGIN';
  END IF;
  BEGIN
    v_margin := (p_payload->>'target_margin_pct')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_TARGET_MARGIN';
  END;
  IF v_margin IS NULL
     OR v_margin::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_margin < 1
     OR v_margin > 90 THEN
    RAISE EXCEPTION 'INVALID_TARGET_MARGIN';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'risk_reserve_amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  BEGIN
    v_reserve := (p_payload->>'risk_reserve_amount')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END;
  IF v_reserve IS NULL
     OR v_reserve::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_reserve < 0
     OR v_reserve > 10000000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'liquidity_level') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_payload->'market_risk_level') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_payload->'inventory_risk_level') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_liq := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'liquidity_level', '')), ''));
  v_mkt := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'market_risk_level', '')), ''));
  v_inv := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'inventory_risk_level', '')), ''));
  IF v_liq IS NULL OR v_liq NOT IN ('LOW', 'MEDIUM', 'HIGH')
     OR v_mkt IS NULL OR v_mkt NOT IN ('LOW', 'MEDIUM', 'HIGH')
     OR v_inv IS NULL OR v_inv NOT IN ('LOW', 'MEDIUM', 'HIGH') THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF p_payload ? 'note'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'string'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 500 THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'estimated_refurbishment_cost', v_refurb,
    'target_margin_pct', v_margin,
    'risk_reserve_amount', v_reserve,
    'liquidity_level', v_liq,
    'market_risk_level', v_mkt,
    'inventory_risk_level', v_inv,
    'note', to_jsonb(v_note)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_acquisition_read_inputs(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_preview(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_result public.used_valuation_results%ROWTYPE;
  v_step numeric;
  v_in jsonb;
  v_out jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF NULLIF(p_payload->>'valuation_result_id', '') IS NULL THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  SELECT * INTO v_result
  FROM public.used_valuation_results
  WHERE id = (p_payload->>'valuation_result_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  IF v_result.market_mid IS NULL OR v_result.market_mid <= 0 THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  v_step := public.dk_used_acquisition_rounding_step(v_result.rule_snapshot, v_result.rule_version_id);
  v_in := public.dk_used_acquisition_read_inputs(p_payload);
  v_out := public.dk_used_acquisition_compute_v1(
    v_result.market_mid,
    (v_in->>'estimated_refurbishment_cost')::numeric,
    (v_in->>'target_margin_pct')::numeric,
    (v_in->>'risk_reserve_amount')::numeric,
    v_step
  );
  IF COALESCE((v_out->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_out->>'code', 'INVALID_REQUEST');
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok', true, 'valuation_result_id', v_result.id)
    || v_out
    || pg_catalog.jsonb_build_object(
      'liquidity_level', v_in->>'liquidity_level',
      'market_risk_level', v_in->>'market_risk_level',
      'inventory_risk_level', v_in->>'inventory_risk_level'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_create_case(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_ch text;
  v_comps jsonb;
  v_comp jsonb;
  v_id uuid;
  v_code text;
  v_n int := 0;
  v_type text;
  v_brand text;
  v_model text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_ch := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'source_channel', '')), ''));
  IF v_ch IS NULL OR v_ch NOT IN ('LINE', 'PHONE', 'WALK_IN', 'OTHER') THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_comps := p_payload->'components';
  IF v_comps IS NULL OR pg_catalog.jsonb_typeof(v_comps) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_comps) < 1 THEN
    RAISE EXCEPTION 'NO_COMPONENTS';
  END IF;
  LOOP
    v_code := 'ACQ-' || to_char(pg_catalog.now() AT TIME ZONE 'Asia/Taipei', 'YYYYMMDD')
      || '-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.used_valuation_cases c WHERE c.public_code = v_code
    );
  END LOOP;
  INSERT INTO public.used_valuation_cases (public_code, status, source_channel, created_by)
  VALUES (v_code, 'CONTACTED', v_ch, v_uid)
  RETURNING id INTO v_id;
  FOR v_comp IN SELECT value FROM pg_catalog.jsonb_array_elements(v_comps)
  LOOP
    v_type := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'component_type', v_comp->>'category', '')), ''));
    v_brand := NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'brand', '')), '');
    v_model := NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'model', '')), '');
    IF v_type IS NULL OR v_type NOT IN (
      'CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'STORAGE', 'PSU', 'CASE', 'COOLER', 'LAPTOP', 'OTHER'
    ) OR v_brand IS NULL OR v_model IS NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
    INSERT INTO public.used_valuation_components (
      case_id, component_type, brand, model, variant, spec, age_months,
      condition_grade, warranty_end_date, note, ordinal
    ) VALUES (
      v_id,
      v_type,
      v_brand,
      v_model,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'variant', '')), ''),
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'spec', '')), ''),
      NULLIF(v_comp->>'age_months', '')::int,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'condition_grade', '')), ''),
      NULLIF(v_comp->>'warranty_end_date', '')::date,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'note', '')), ''),
      v_n
    );
    v_n := v_n + 1;
  END LOOP;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'ACQUISITION_CASE_CREATED', 'VALUATION_CASE', v_id, NULL,
    '{}'::jsonb,
    pg_catalog.jsonb_build_object('id', v_id, 'public_code', v_code, 'source_channel', v_ch, 'status', 'CONTACTED')
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'public_code', v_code, 'status', 'CONTACTED');
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_replace_components(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_comps jsonb;
  v_comp jsonb;
  v_n int := 0;
  v_type text;
  v_brand text;
  v_model text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  SELECT * INTO v_case
  FROM public.used_valuation_cases
  WHERE id = (p_payload->>'case_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status NOT IN ('CONTACTED', 'INSPECTION_PENDING') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  v_comps := p_payload->'components';
  IF v_comps IS NULL OR pg_catalog.jsonb_typeof(v_comps) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_comps) < 1 THEN
    RAISE EXCEPTION 'NO_COMPONENTS';
  END IF;
  DELETE FROM public.used_valuation_components WHERE case_id = v_case.id;
  FOR v_comp IN SELECT value FROM pg_catalog.jsonb_array_elements(v_comps)
  LOOP
    v_type := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'component_type', v_comp->>'category', '')), ''));
    v_brand := NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'brand', '')), '');
    v_model := NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'model', '')), '');
    IF v_type IS NULL OR v_type NOT IN (
      'CPU', 'GPU', 'MOTHERBOARD', 'RAM', 'STORAGE', 'PSU', 'CASE', 'COOLER', 'LAPTOP', 'OTHER'
    ) OR v_brand IS NULL OR v_model IS NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST';
    END IF;
    INSERT INTO public.used_valuation_components (
      case_id, component_type, brand, model, variant, spec, age_months,
      condition_grade, warranty_end_date, note, ordinal
    ) VALUES (
      v_case.id, v_type, v_brand, v_model,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'variant', '')), ''),
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'spec', '')), ''),
      NULLIF(v_comp->>'age_months', '')::int,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'condition_grade', '')), ''),
      NULLIF(v_comp->>'warranty_end_date', '')::date,
      NULLIF(pg_catalog.btrim(COALESCE(v_comp->>'note', '')), ''),
      v_n
    );
    v_n := v_n + 1;
  END LOOP;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'ACQUISITION_CASE_COMPONENTS_UPDATED', 'VALUATION_CASE', v_case.id, NULL,
    '{}'::jsonb,
    pg_catalog.jsonb_build_object('case_id', v_case.id, 'component_count', v_n)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_case.id, 'component_count', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_create_decision(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_result public.used_valuation_results%ROWTYPE;
  v_case public.used_valuation_cases%ROWTYPE;
  v_step numeric;
  v_in jsonb;
  v_out jsonb;
  v_id uuid;
  v_reason text;
  v_snap jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF NULLIF(p_payload->>'valuation_result_id', '') IS NULL THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  SELECT * INTO v_result
  FROM public.used_valuation_results
  WHERE id = (p_payload->>'valuation_result_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  SELECT * INTO v_case FROM public.used_valuation_cases WHERE id = v_result.case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status NOT IN ('CONTACTED', 'INSPECTION_PENDING') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  IF v_result.market_mid IS NULL OR v_result.market_mid <= 0 THEN
    RAISE EXCEPTION 'NO_VALUATION_RESULT';
  END IF;
  v_step := public.dk_used_acquisition_rounding_step(v_result.rule_snapshot, v_result.rule_version_id);
  v_in := public.dk_used_acquisition_read_inputs(p_payload);
  v_out := public.dk_used_acquisition_compute_v1(
    v_result.market_mid,
    (v_in->>'estimated_refurbishment_cost')::numeric,
    (v_in->>'target_margin_pct')::numeric,
    (v_in->>'risk_reserve_amount')::numeric,
    v_step
  );
  IF COALESCE((v_out->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_out->>'code', 'INVALID_REQUEST');
  END IF;
  v_snap := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'record_type', 'ACQUISITION_EVALUATION',
    'estimated_refurbishment_cost', (v_in->>'estimated_refurbishment_cost')::numeric,
    'target_margin_pct', (v_in->>'target_margin_pct')::numeric,
    'risk_reserve_amount', (v_in->>'risk_reserve_amount')::numeric,
    'estimated_resale_price', (v_out->>'estimated_resale_price')::numeric,
    'estimated_gross_profit', (v_out->>'estimated_gross_profit')::numeric,
    'estimated_margin_pct', (v_out->>'estimated_margin_pct')::numeric,
    'liquidity_level', v_in->>'liquidity_level',
    'market_risk_level', v_in->>'market_risk_level',
    'inventory_risk_level', v_in->>'inventory_risk_level',
    'note', v_in->'note'
  );
  v_reason := public.dk_used_acquisition_encode_reason(v_snap);
  INSERT INTO public.used_valuation_decisions (
    case_id, valuation_result_id,
    system_recommended_acquisition, system_maximum_acquisition,
    final_offer, reason, actor_user_id
  ) VALUES (
    v_case.id, v_result.id,
    (v_out->>'recommended_acquisition')::numeric,
    (v_out->>'maximum_acquisition')::numeric,
    0, v_reason, v_uid
  )
  RETURNING id INTO v_id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'ACQUISITION_DECISION_CREATED', 'VALUATION_DECISION', v_id, NULL,
    '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'id', v_id,
      'case_id', v_case.id,
      'valuation_result_id', v_result.id,
      'record_type', 'ACQUISITION_EVALUATION',
      'recommended_acquisition', (v_out->>'recommended_acquisition')::numeric,
      'maximum_acquisition', (v_out->>'maximum_acquisition')::numeric
    )
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'case_id', v_case.id) || v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_record_offer(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_base public.used_valuation_decisions%ROWTYPE;
  v_case public.used_valuation_cases%ROWTYPE;
  v_offer numeric;
  v_note text;
  v_id uuid;
  v_reason text;
  v_snap jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF NULLIF(p_payload->>'base_decision_id', '') IS NULL THEN
    RAISE EXCEPTION 'INVALID_OFFER_DECISION';
  END IF;
  SELECT * INTO v_base
  FROM public.used_valuation_decisions
  WHERE id = (p_payload->>'base_decision_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_OFFER_DECISION';
  END IF;
  IF public.dk_used_acquisition_reason_type(v_base.reason) IS DISTINCT FROM 'ACQUISITION_EVALUATION' THEN
    RAISE EXCEPTION 'INVALID_OFFER_DECISION';
  END IF;
  SELECT * INTO v_case FROM public.used_valuation_cases WHERE id = v_base.case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status NOT IN ('CONTACTED', 'INSPECTION_PENDING', 'OFFERED') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'final_offer') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  BEGIN
    v_offer := (p_payload->>'final_offer')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END;
  IF v_offer IS NULL
     OR v_offer::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_offer < 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF v_offer > v_base.system_maximum_acquisition THEN
    RAISE EXCEPTION 'OFFER_EXCEEDS_MAXIMUM';
  END IF;
  IF p_payload ? 'note'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'string'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 500 THEN
    RAISE EXCEPTION 'INVALID_DECISION_PAYLOAD';
  END IF;
  v_snap := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'record_type', 'OFFER',
    'base_decision_id', v_base.id,
    'final_offer', v_offer,
    'note', to_jsonb(v_note)
  );
  v_reason := public.dk_used_acquisition_encode_reason(v_snap);
  INSERT INTO public.used_valuation_decisions (
    case_id, valuation_result_id,
    system_recommended_acquisition, system_maximum_acquisition,
    final_offer, reason, actor_user_id
  ) VALUES (
    v_base.case_id, v_base.valuation_result_id,
    v_base.system_recommended_acquisition, v_base.system_maximum_acquisition,
    v_offer, v_reason, v_uid
  )
  RETURNING id INTO v_id;
  UPDATE public.used_valuation_cases
  SET status = 'OFFERED'
  WHERE id = v_case.id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'ACQUISITION_OFFER_RECORDED', 'VALUATION_DECISION', v_id, v_note,
    pg_catalog.jsonb_build_object('status', v_case.status),
    pg_catalog.jsonb_build_object(
      'id', v_id,
      'case_id', v_case.id,
      'base_decision_id', v_base.id,
      'record_type', 'OFFER',
      'final_offer', v_offer,
      'status', 'OFFERED'
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', v_id, 'case_id', v_case.id, 'final_offer', v_offer, 'status', 'OFFERED'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_set_status(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_to text;
  v_note text;
  v_action text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  SELECT * INTO v_case
  FROM public.used_valuation_cases
  WHERE id = (p_payload->>'case_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  v_to := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'status', '')), ''));
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_to = 'RESOLD' OR v_to = 'ACQUIRED' OR v_to = 'OFFERED' THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  IF v_case.status = 'CONTACTED' AND v_to = 'INSPECTION_PENDING' THEN
    v_action := 'ACQUISITION_CASE_INSPECTION_PENDING';
  ELSIF v_case.status = 'OFFERED' AND v_to IN ('ACCEPTED', 'DECLINED', 'EXPIRED') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.used_valuation_decisions d
      WHERE d.case_id = v_case.id
        AND public.dk_used_acquisition_reason_type(d.reason) = 'OFFER'
    ) THEN
      RAISE EXCEPTION 'INVALID_OFFER_DECISION';
    END IF;
    IF v_to = 'ACCEPTED' THEN
      v_action := 'ACQUISITION_CASE_ACCEPTED';
    ELSIF v_to = 'DECLINED' THEN
      v_action := 'ACQUISITION_CASE_DECLINED';
    ELSE
      v_action := 'ACQUISITION_CASE_EXPIRED';
    END IF;
  ELSE
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  UPDATE public.used_valuation_cases
  SET status = v_to
  WHERE id = v_case.id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, v_action, 'VALUATION_CASE', v_case.id, v_note,
    pg_catalog.jsonb_build_object('status', v_case.status),
    pg_catalog.jsonb_build_object('status', v_to)
  );
  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', v_case.id, 'status', v_to);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_mark_acquired(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_dec public.used_valuation_decisions%ROWTYPE;
  v_price numeric;
  v_at timestamptz;
  v_note text;
  v_reason text;
  v_over boolean := false;
  v_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  SELECT * INTO v_case
  FROM public.used_valuation_cases
  WHERE id = (p_payload->>'case_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status = 'ACQUIRED' THEN
    RAISE EXCEPTION 'ALREADY_ACQUIRED';
  END IF;
  IF v_case.status IS DISTINCT FROM 'ACCEPTED' THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.used_acquisition_links a WHERE a.case_id = v_case.id
  ) THEN
    RAISE EXCEPTION 'ALREADY_ACQUIRED';
  END IF;
  SELECT * INTO v_dec
  FROM public.used_valuation_decisions
  WHERE id = (p_payload->>'decision_id')::uuid;
  IF NOT FOUND
     OR v_dec.case_id IS DISTINCT FROM v_case.id
     OR public.dk_used_acquisition_reason_type(v_dec.reason) IS DISTINCT FROM 'OFFER' THEN
    RAISE EXCEPTION 'INVALID_OFFER_DECISION';
  END IF;
  IF v_dec.id IS DISTINCT FROM (
    SELECT d.id
    FROM public.used_valuation_decisions d
    WHERE d.case_id = v_case.id
      AND public.dk_used_acquisition_reason_type(d.reason) = 'OFFER'
    ORDER BY d.created_at DESC
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'INVALID_OFFER_DECISION';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'actual_acquisition_price') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  BEGIN
    v_price := (p_payload->>'actual_acquisition_price')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END;
  IF v_price IS NULL
     OR v_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_price < 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  BEGIN
    v_at := COALESCE((p_payload->>'acquired_at')::timestamptz, pg_catalog.now());
  EXCEPTION WHEN invalid_datetime_format THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END;
  IF p_payload ? 'note'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'string'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'override_reason', p_payload->>'over_max_reason', '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF v_price > v_dec.system_maximum_acquisition THEN
    v_over := true;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'ACTUAL_PRICE_REASON_REQUIRED';
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.used_acquisition_links (
      case_id, decision_id, actual_acquisition_price, acquired_at, note, created_by
    ) VALUES (
      v_case.id, v_dec.id, v_price, v_at,
      NULLIF(pg_catalog.concat_ws(' / ', v_note, CASE WHEN v_over THEN v_reason ELSE NULL END), ''),
      v_uid
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ALREADY_ACQUIRED';
  END;
  UPDATE public.used_valuation_cases
  SET status = 'ACQUIRED'
  WHERE id = v_case.id;
  IF v_over THEN
    PERFORM public.dk_used_valuation_write_audit(
      v_uid, 'OVER_MAX_ACQUISITION', 'ACQUISITION_LINK', v_id, v_reason,
      '{}'::jsonb,
      pg_catalog.jsonb_build_object(
        'actual_acquisition_price', v_price,
        'maximum_acquisition', v_dec.system_maximum_acquisition
      )
    );
  END IF;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'ACQUISITION_COMPLETED', 'ACQUISITION_LINK', v_id, v_note,
    pg_catalog.jsonb_build_object('status', v_case.status),
    pg_catalog.jsonb_build_object(
      'id', v_id, 'case_id', v_case.id, 'decision_id', v_dec.id,
      'actual_acquisition_price', v_price, 'status', 'ACQUIRED'
    )
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'id', v_id, 'case_id', v_case.id, 'status', 'ACQUIRED',
    'over_max', v_over
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_list_cases()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_rows jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  SELECT COALESCE(pg_catalog.jsonb_agg(q.row ORDER BY (q.row->>'updated_at') DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'id', c.id,
      'public_code', c.public_code,
      'status', c.status,
      'source_channel', c.source_channel,
      'created_at', c.created_at,
      'updated_at', c.updated_at,
      'market_mid', r.market_mid,
      'recommended_acquisition', d.system_recommended_acquisition,
      'maximum_acquisition', d.system_maximum_acquisition,
      'final_offer', o.final_offer
    ) AS row
    FROM public.used_valuation_cases c
    LEFT JOIN LATERAL (
      SELECT x.market_mid
      FROM public.used_valuation_results x
      WHERE x.case_id = c.id
      ORDER BY x.created_at DESC
      LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT y.system_recommended_acquisition, y.system_maximum_acquisition
      FROM public.used_valuation_decisions y
      WHERE y.case_id = c.id
        AND public.dk_used_acquisition_reason_type(y.reason) = 'ACQUISITION_EVALUATION'
      ORDER BY y.created_at DESC
      LIMIT 1
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT z.final_offer
      FROM public.used_valuation_decisions z
      WHERE z.case_id = c.id
        AND public.dk_used_acquisition_reason_type(z.reason) = 'OFFER'
      ORDER BY z.created_at DESC
      LIMIT 1
    ) o ON true
  ) q;
  RETURN pg_catalog.jsonb_build_object('ok', true, 'cases', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_get_case(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_comps jsonb;
  v_results jsonb;
  v_decs jsonb;
  v_link jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  SELECT * INTO v_case FROM public.used_valuation_cases WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', c.id,
    'component_type', c.component_type,
    'brand', c.brand,
    'model', c.model,
    'variant', c.variant,
    'spec', c.spec,
    'age_months', c.age_months,
    'condition_grade', c.condition_grade,
    'warranty_end_date', c.warranty_end_date,
    'note', c.note,
    'ordinal', c.ordinal
  ) ORDER BY c.ordinal, c.created_at), '[]'::jsonb)
    INTO v_comps
  FROM public.used_valuation_components c
  WHERE c.case_id = p_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', r.id,
    'market_low', r.market_low,
    'market_mid', r.market_mid,
    'market_high', r.market_high,
    'value_score', r.value_score,
    'created_at', r.created_at,
    'market_updated_at', r.market_updated_at
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
    INTO v_results
  FROM public.used_valuation_results r
  WHERE r.case_id = p_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', d.id,
    'valuation_result_id', d.valuation_result_id,
    'recommended_acquisition', d.system_recommended_acquisition,
    'maximum_acquisition', d.system_maximum_acquisition,
    'final_offer', d.final_offer,
    'record_type', public.dk_used_acquisition_reason_type(d.reason),
    'snapshot', public.dk_used_acquisition_parse_reason(d.reason),
    'created_at', d.created_at
  ) ORDER BY d.created_at DESC), '[]'::jsonb)
    INTO v_decs
  FROM public.used_valuation_decisions d
  WHERE d.case_id = p_id;
  SELECT pg_catalog.jsonb_build_object(
    'id', a.id,
    'decision_id', a.decision_id,
    'actual_acquisition_price', a.actual_acquisition_price,
    'acquired_at', a.acquired_at,
    'note', a.note
  )
    INTO v_link
  FROM public.used_acquisition_links a
  WHERE a.case_id = p_id;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'case', pg_catalog.jsonb_build_object(
      'id', v_case.id,
      'public_code', v_case.public_code,
      'status', v_case.status,
      'source_channel', v_case.source_channel,
      'created_at', v_case.created_at,
      'updated_at', v_case.updated_at
    ),
    'components', v_comps,
    'results', v_results,
    'decisions', v_decs,
    'acquisition', v_link
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_acquisition_run_valuation(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  v_uid := public.dk_used_valuation_require_admin();
  IF p_case_id IS NULL THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  SELECT * INTO v_case FROM public.used_valuation_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status NOT IN ('CONTACTED', 'INSPECTION_PENDING') THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION';
  END IF;
  RETURN public.backoffice_used_valuation_run_case(p_case_id);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_preview(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_create_case(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_replace_components(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_create_decision(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_record_offer(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_set_status(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_mark_acquired(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_list_cases() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_get_case(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_acquisition_run_valuation(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_preview(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_create_case(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_replace_components(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_create_decision(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_record_offer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_set_status(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_mark_acquired(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_list_cases() TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_get_case(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_acquisition_run_valuation(uuid) TO authenticated;

COMMIT;


-- ============================================================
-- SECTION M2_VERIFY
-- 純 read-only scoreboard。最後一個 statement 必須是本 SELECT。
-- ============================================================

WITH acq AS (
  SELECT to_regclass('public.used_acquisition_links') AS reg
),
acq_cols AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'used_acquisition_links'
),
acq_types AS (
  SELECT
    MAX(CASE WHEN column_name = 'actual_acquisition_price' THEN data_type END) AS price_t,
    MAX(CASE WHEN column_name = 'acquired_at' THEN data_type END) AS at_t,
    MAX(CASE WHEN column_name = 'created_at' THEN data_type END) AS created_t,
    MAX(CASE WHEN column_name = 'case_id' THEN data_type END) AS case_t,
    MAX(CASE WHEN column_name = 'decision_id' THEN data_type END) AS dec_t
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_acquisition_links'
),
acq_uniq AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_acquisition_links'
    AND i.indisunique
    AND pg_get_indexdef(i.indexrelid) ILIKE '%(case_id)%'
),
acq_fk AS (
  SELECT
    COUNT(*) FILTER (WHERE pg_get_constraintdef(c.oid) ILIKE '%used_valuation_cases%')::int AS case_n,
    COUNT(*) FILTER (WHERE pg_get_constraintdef(c.oid) ILIKE '%used_valuation_decisions%')::int AS dec_n,
    COUNT(*) FILTER (WHERE pg_get_constraintdef(c.oid) ILIKE '%profiles%')::int AS prof_n
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_acquisition_links' AND c.contype = 'f'
),
acq_ck AS (
  SELECT COUNT(*)::int AS n
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_acquisition_links'
    AND c.conname = 'used_acquisition_links_price_ck'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%actual_acquisition_price%'
    AND pg_get_constraintdef(c.oid) ILIKE '%>=%'
),
acq_pol AS (
  SELECT
    COUNT(*) FILTER (
      WHERE p.polcmd = 'r' AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_admin()%'
    )::int AS admin_sel,
    COUNT(*) FILTER (WHERE p.polcmd = 'a')::int AS ins_n,
    COUNT(*) FILTER (WHERE p.polcmd = 'w')::int AS upd_n,
    COUNT(*) FILTER (WHERE p.polcmd = 'd')::int AS del_n
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_acquisition_links'
),
rpc_sigs AS (
  SELECT * FROM (VALUES
    ('public.backoffice_used_acquisition_preview(jsonb)'),
    ('public.backoffice_used_acquisition_create_decision(jsonb)'),
    ('public.backoffice_used_acquisition_record_offer(jsonb)'),
    ('public.backoffice_used_acquisition_create_case(jsonb)'),
    ('public.backoffice_used_acquisition_replace_components(jsonb)'),
    ('public.backoffice_used_acquisition_set_status(jsonb)'),
    ('public.backoffice_used_acquisition_mark_acquired(jsonb)'),
    ('public.backoffice_used_acquisition_list_cases()'),
    ('public.backoffice_used_acquisition_get_case(uuid)'),
    ('public.backoffice_used_acquisition_run_valuation(uuid)')
  ) AS t(sig)
),
rpc_meta AS (
  SELECT s.sig, to_regprocedure(s.sig) AS oid
  FROM rpc_sigs s
),
rpc_def AS (
  SELECT m.sig, m.oid, p.prosecdef, p.proconfig, p.proowner,
         CASE WHEN m.oid IS NULL THEN '' ELSE pg_get_functiondef(m.oid) END AS def
  FROM rpc_meta m
  LEFT JOIN pg_proc p ON p.oid = m.oid
),
helper_oids AS (
  SELECT
    to_regprocedure('public.dk_used_acquisition_compute_v1(numeric,numeric,numeric,numeric,numeric)') AS compute,
    to_regprocedure('public.dk_used_acquisition_floor_amount(numeric,numeric)') AS floor_fn,
    to_regprocedure('public.dk_used_acquisition_encode_reason(jsonb)') AS encode,
    to_regprocedure('public.dk_used_acquisition_parse_reason(text)') AS parse,
    to_regprocedure('public.dk_used_acquisition_reason_type(text)') AS reason_type,
    to_regprocedure('public.dk_used_acquisition_read_inputs(jsonb)') AS read_in,
    to_regprocedure('public.dk_used_acquisition_rounding_step(jsonb,uuid)') AS rounding,
    to_regprocedure('public.used_acquisition_links_immutable()') AS imm,
    to_regprocedure('public.used_valuation_decisions_immutable()') AS dec_imm,
    to_regprocedure('public.used_valuation_results_immutable()') AS res_imm
),
helper_exec AS (
  SELECT COUNT(*)::int AS n
  FROM unnest(ARRAY[
    (SELECT compute FROM helper_oids),
    (SELECT floor_fn FROM helper_oids),
    (SELECT encode FROM helper_oids),
    (SELECT parse FROM helper_oids),
    (SELECT reason_type FROM helper_oids),
    (SELECT read_in FROM helper_oids),
    (SELECT rounding FROM helper_oids),
    (SELECT imm FROM helper_oids)
  ]) AS oid
  WHERE oid IS NOT NULL
    AND (
      has_function_privilege('anon', oid, 'EXECUTE')
      OR has_function_privilege('authenticated', oid, 'EXECUTE')
    )
),
preview_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_preview(jsonb)'
),
decision_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_create_decision(jsonb)'
),
offer_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_record_offer(jsonb)'
),
acq_rpc_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_mark_acquired(jsonb)'
),
st_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_set_status(jsonb)'
),
list_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_list_cases()'
),
get_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_get_case(uuid)'
),
run_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_run_valuation(uuid)'
),
comp_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_replace_components(jsonb)'
),
compute_def AS (
  SELECT CASE WHEN compute IS NULL THEN '' ELSE pg_get_functiondef(compute) END AS def
  FROM helper_oids
),
floor_fn_def AS (
  SELECT CASE
    WHEN floor_fn IS NULL THEN ''
    ELSE pg_get_functiondef(floor_fn)
  END AS def
  FROM helper_oids
),
floor_rounding_ok AS (
  SELECT (
    (SELECT def FROM compute_def) ILIKE '%dk_used_acquisition_floor_amount%'
    AND (SELECT def FROM floor_fn_def) ILIKE '%pg_catalog.floor%'
    AND (SELECT def FROM compute_def) NOT ILIKE '%pg_catalog.round%'
    AND (SELECT def FROM compute_def) NOT ILIKE '%pg_catalog.ceil%'
    AND (SELECT def FROM floor_fn_def) NOT ILIKE '%pg_catalog.round%'
    AND (SELECT def FROM floor_fn_def) NOT ILIKE '%pg_catalog.ceil%'
  ) AS ok
),
encode_def AS (
  SELECT CASE WHEN encode IS NULL THEN '' ELSE pg_get_functiondef(encode) END AS def
  FROM helper_oids
),
read_def AS (
  SELECT CASE WHEN read_in IS NULL THEN '' ELSE pg_get_functiondef(read_in) END AS def
  FROM helper_oids
),
round_def AS (
  SELECT CASE WHEN rounding IS NULL THEN '' ELSE pg_get_functiondef(rounding) END AS def
  FROM helper_oids
),
all_rpc_def AS (
  SELECT string_agg(def, E'\n') AS def FROM rpc_def
),
dec_pol AS (
  SELECT COUNT(*)::int AS admin_n,
         COUNT(*) FILTER (
           WHERE pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_enabled_backoffice_user%'
         )::int AS staff_n,
         COUNT(*) FILTER (
           WHERE pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_admin()%'
         )::int AS is_admin_n
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_decisions' AND p.polcmd = 'r'
),
search_ok AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  CROSS JOIN LATERAL unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
  WHERE f.oid IS NOT NULL
    AND pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
),
definer_n AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  WHERE f.oid IS NOT NULL AND f.prosecdef IS TRUE
),
admin_guard AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  WHERE f.def ILIKE '%is_admin()%' AND f.def ILIKE '%dk_used_valuation_require_admin%'
),
anon_rpc AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  WHERE f.oid IS NOT NULL
    AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
seed_n AS (
  SELECT CASE
    WHEN (SELECT reg FROM acq) IS NULL THEN 0
    ELSE (SELECT COUNT(*)::int FROM public.used_acquisition_links)
  END AS n
)
SELECT 1 AS seq, 'acquisition.table_exists'::text AS check_name,
       ((SELECT reg FROM acq) IS NOT NULL)::text AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT reg FROM acq) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'acquisition.columns',
       array_to_string((SELECT names FROM acq_cols), ','),
       'id,case_id,decision_id,actual_acquisition_price,acquired_at,note,created_by,created_at',
       CASE WHEN (SELECT names FROM acq_cols) = ARRAY[
         'id','case_id','decision_id','actual_acquisition_price','acquired_at','note','created_by','created_at'
       ]::text[] THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'acquisition.column_types',
       ((SELECT price_t FROM acq_types) || '/' || (SELECT at_t FROM acq_types) || '/' || (SELECT created_t FROM acq_types)),
       'numeric/timestamptz',
       CASE WHEN (SELECT price_t FROM acq_types) = 'numeric'
             AND (SELECT at_t FROM acq_types) = 'timestamp with time zone'
             AND (SELECT created_t FROM acq_types) = 'timestamp with time zone'
             AND (SELECT case_t FROM acq_types) = 'uuid'
             AND (SELECT dec_t FROM acq_types) = 'uuid'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'acquisition.unique_case',
       ((SELECT n::text FROM acq_uniq)), '>=1',
       CASE WHEN (SELECT n FROM acq_uniq) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'acquisition.fk_case',
       ((SELECT case_n::text FROM acq_fk)), '>=1',
       CASE WHEN (SELECT case_n FROM acq_fk) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'acquisition.fk_decision',
       ((SELECT dec_n::text FROM acq_fk)), '>=1',
       CASE WHEN (SELECT dec_n FROM acq_fk) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'acquisition.fk_profile',
       ((SELECT prof_n::text FROM acq_fk)), '>=1',
       CASE WHEN (SELECT prof_n FROM acq_fk) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'acquisition.price_nonnegative',
       ((SELECT n::text FROM acq_ck)), '>=1',
       CASE WHEN (SELECT n FROM acq_ck) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'acquisition.rls_enabled',
       (SELECT c.relrowsecurity::text
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relname = 'used_acquisition_links'), 'true',
       CASE WHEN (SELECT c.relrowsecurity
                  FROM pg_class c
                  JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  WHERE ns.nspname = 'public' AND c.relname = 'used_acquisition_links')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'acquisition.admin_select_policy',
       ((SELECT admin_sel::text FROM acq_pol)), '>=1',
       CASE WHEN (SELECT admin_sel FROM acq_pol) >= 1
             AND (SELECT ins_n FROM acq_pol) = 0
             AND (SELECT upd_n FROM acq_pol) = 0
             AND (SELECT del_n FROM acq_pol) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'decisions.admin_select_only',
       ((SELECT admin_n::text FROM dec_pol) || '/' || (SELECT staff_n::text FROM dec_pol) || '/' || (SELECT is_admin_n::text FROM dec_pol)), '>=1/0/>=1',
       CASE WHEN (SELECT admin_n FROM dec_pol) >= 1
             AND (SELECT staff_n FROM dec_pol) = 0
             AND (SELECT is_admin_n FROM dec_pol) >= 1
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'decisions.anon_denied',
       ((NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'INSERT')
             AND NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'UPDATE')
             AND NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'DELETE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'acquisition.anon_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'direct_writes.denied',
       'true', 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_acquisition_links', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.used_acquisition_links', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.used_acquisition_links', 'UPDATE')
             AND NOT has_table_privilege('authenticated', 'public.used_acquisition_links', 'DELETE')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_decisions', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_decisions', 'UPDATE')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_decisions', 'DELETE')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_cases', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_components', 'INSERT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'append_only.acquisition_trigger',
       ((SELECT imm FROM helper_oids) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT imm FROM helper_oids) IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM pg_trigger g
               JOIN pg_class t ON t.oid = g.tgrelid
               JOIN pg_namespace ns ON ns.oid = t.relnamespace
               WHERE ns.nspname = 'public' AND t.relname = 'used_acquisition_links'
                 AND NOT g.tgisinternal
                 AND g.tgtype::int & 16 = 16
                 AND g.tgtype::int & 8 = 8
             )
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'append_only.decisions',
       ((SELECT dec_imm FROM helper_oids) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT dec_imm FROM helper_oids) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'append_only.results',
       ((SELECT res_imm FROM helper_oids) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT res_imm FROM helper_oids) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'helper.execute_denied',
       ((SELECT n::text FROM helper_exec)), '0',
       CASE WHEN (SELECT compute FROM helper_oids) IS NOT NULL
             AND (SELECT encode FROM helper_oids) IS NOT NULL
             AND (SELECT parse FROM helper_oids) IS NOT NULL
             AND (SELECT rounding FROM helper_oids) IS NOT NULL
             AND (SELECT n FROM helper_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'rpc.all_exist',
       ((SELECT COUNT(*)::int FROM rpc_meta WHERE oid IS NOT NULL)::text), '10',
       CASE WHEN (SELECT COUNT(*) FROM rpc_meta WHERE oid IS NOT NULL) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'rpc.security_definer',
       ((SELECT n::text FROM definer_n)), '10',
       CASE WHEN (SELECT n FROM definer_n) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'rpc.search_path_safe',
       ((SELECT n::text FROM search_ok)), '10',
       CASE WHEN (SELECT n FROM search_ok) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'rpc.admin_guard',
       ((SELECT n::text FROM admin_guard)), '10',
       CASE WHEN (SELECT n FROM admin_guard) = 10 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'rpc.anon_execute_denied',
       ((SELECT n::text FROM anon_rpc)), '0',
       CASE WHEN (SELECT n FROM anon_rpc) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'preview.read_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM preview_def) NOT ILIKE '%INSERT%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%UPDATE%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%DELETE%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%write_audit%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'formula.resale_market_mid',
       'true', 'true',
       CASE WHEN (SELECT def FROM preview_def) ILIKE '%market_mid%'
             AND (SELECT def FROM preview_def) ILIKE '%dk_used_acquisition_compute_v1%'
             AND (SELECT def FROM decision_def) ILIKE '%market_mid%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%market_high%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''estimated_resale_price''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->''estimated_resale_price''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'formula.historical_rounding',
       'true', 'true',
       CASE WHEN (SELECT def FROM preview_def) ILIKE '%dk_used_acquisition_rounding_step%'
             AND (SELECT def FROM decision_def) ILIKE '%dk_used_acquisition_rounding_step%'
             AND (SELECT def FROM round_def) ILIKE '%rule_snapshot%'
             AND (SELECT def FROM round_def) ILIKE '%rule_version_id%'
             AND (SELECT def FROM round_def) NOT ILIKE '%ACTIVE%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%ACTIVE%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%ACTIVE%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'formula.floor_rounding',
       (SELECT ok FROM floor_rounding_ok)::text, 'true',
       CASE WHEN (SELECT ok FROM floor_rounding_ok) IS TRUE THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'formula.target_margin',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%p_margin_pct < 1%'
             AND (SELECT def FROM compute_def) ILIKE '%p_margin_pct > 90%'
             AND (SELECT def FROM read_def) ILIKE '%INVALID_TARGET_MARGIN%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'formula.refurb_validation',
       'true', 'true',
       CASE WHEN (SELECT def FROM read_def) ILIKE '%INVALID_REFURBISHMENT_COST%'
             AND (SELECT def FROM read_def) ILIKE '%10000000%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'formula.reserve_validation',
       'true', 'true',
       CASE WHEN (SELECT def FROM read_def) ILIKE '%risk_reserve_amount%'
             AND (SELECT def FROM read_def) ILIKE '%10000000%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'formula.no_hidden_coefficient',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) NOT ILIKE '%0.8%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%0.9%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%0.15%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%0.20%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%0.10%'
             AND (SELECT def FROM preview_def) NOT ILIKE '%0.8%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%0.8%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'formula.recommended_le_maximum',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%v_rec > v_max%'
             AND (SELECT def FROM compute_def) ILIKE '%recommended_acquisition%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'formula.uneconomic',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%UNECONOMIC_ACQUISITION%'
             AND (SELECT def FROM compute_def) ILIKE '%v_raw_max <= 0%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'formula.gross_profit_server',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%estimated_gross_profit%'
             AND (SELECT def FROM compute_def) ILIKE '%p_resale - v_rec - p_refurb%'
             AND (SELECT def FROM compute_def) ILIKE '%estimated_margin_pct%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'record_type.evaluation',
       'true', 'true',
       CASE WHEN (SELECT def FROM decision_def) ILIKE '%ACQUISITION_EVALUATION%'
             AND (SELECT def FROM decision_def) ILIKE '%schema_version%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%''kind''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'record_type.offer',
       'true', 'true',
       CASE WHEN (SELECT def FROM offer_def) ILIKE '%record_type%'
             AND (SELECT def FROM offer_def) ILIKE '%OFFER%'
             AND (SELECT def FROM offer_def) ILIKE '%base_decision_id%'
             AND (SELECT def FROM encode_def) ILIKE '%INVALID_DECISION_PAYLOAD%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'sentinel.evaluation_not_offer',
       'true', 'true',
       CASE WHEN (SELECT def FROM decision_def) ILIKE '%ACQUISITION_EVALUATION%'
             AND (SELECT def FROM list_def) ILIKE '%ACQUISITION_EVALUATION%'
             AND (SELECT def FROM list_def) ILIKE '%OFFER%'
             AND (SELECT def FROM list_def) ILIKE '%dk_used_acquisition_reason_type%'
             AND (SELECT def FROM list_def) NOT ILIKE '%NULLIF%final_offer%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'offer.base_evaluation',
       'true', 'true',
       CASE WHEN (SELECT def FROM offer_def) ILIKE '%INVALID_OFFER_DECISION%'
             AND (SELECT def FROM offer_def) ILIKE '%ACQUISITION_EVALUATION%'
             AND (SELECT def FROM offer_def) ILIKE '%system_recommended_acquisition%'
             AND (SELECT def FROM offer_def) ILIKE '%system_maximum_acquisition%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'offer.le_maximum',
       'true', 'true',
       CASE WHEN (SELECT def FROM offer_def) ILIKE '%OFFER_EXCEEDS_MAXIMUM%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'offer.atomic_transition',
       'true', 'true',
       CASE WHEN (SELECT def FROM offer_def) ILIKE '%status = ''OFFERED''%'
             AND (SELECT def FROM offer_def) ILIKE '%CONTACTED%'
             AND (SELECT def FROM offer_def) ILIKE '%INSPECTION_PENDING%'
             AND (SELECT def FROM offer_def) ILIKE '%ACQUISITION_OFFER_RECORDED%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'lifecycle.offered_accept_decline_expire',
       'true', 'true',
       CASE WHEN (SELECT def FROM st_def) ILIKE '%ACQUISITION_CASE_ACCEPTED%'
             AND (SELECT def FROM st_def) ILIKE '%ACQUISITION_CASE_DECLINED%'
             AND (SELECT def FROM st_def) ILIKE '%ACQUISITION_CASE_EXPIRED%'
             AND (SELECT def FROM st_def) ILIKE '%INVALID_OFFER_DECISION%'
             AND (SELECT def FROM st_def) ILIKE '%CONTACTED%'
             AND (SELECT def FROM st_def) ILIKE '%INSPECTION_PENDING%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'lifecycle.acquired_from_accepted',
       'true', 'true',
       CASE WHEN (SELECT def FROM acq_rpc_def) ILIKE '%ACCEPTED%'
             AND (SELECT def FROM acq_rpc_def) ILIKE '%ALREADY_ACQUIRED%'
             AND (SELECT def FROM acq_rpc_def) ILIKE '%INVALID_OFFER_DECISION%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'lifecycle.no_resold',
       'true', 'true',
       CASE WHEN (SELECT def FROM st_def) ILIKE '%RESOLD%'
             AND (SELECT def FROM st_def) ILIKE '%INVALID_STATUS_TRANSITION%'
             AND (SELECT def FROM acq_rpc_def) NOT ILIKE '%RESOLD%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'acquired.over_max_reason',
       'true', 'true',
       CASE WHEN (SELECT def FROM acq_rpc_def) ILIKE '%ACTUAL_PRICE_REASON_REQUIRED%'
             AND (SELECT def FROM acq_rpc_def) ILIKE '%OVER_MAX_ACQUISITION%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'audit.integration',
       'true', 'true',
       CASE WHEN (SELECT def FROM decision_def) ILIKE '%ACQUISITION_DECISION_CREATED%'
             AND (SELECT def FROM offer_def) ILIKE '%ACQUISITION_OFFER_RECORDED%'
             AND (SELECT def FROM acq_rpc_def) ILIKE '%ACQUISITION_COMPLETED%'
             AND (SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_acquisition_create_case(jsonb)') ILIKE '%ACQUISITION_CASE_CREATED%'
             AND (SELECT def FROM comp_def) ILIKE '%ACQUISITION_CASE_COMPONENTS_UPDATED%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'client.no_financial_outputs',
       'true', 'true',
       CASE WHEN (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''system_recommended_acquisition''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''system_maximum_acquisition''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''estimated_resale_price''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''estimated_gross_profit''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''estimated_margin_pct''%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%p_payload->>''rounding_step''%'
             AND (SELECT def FROM offer_def) NOT ILIKE '%dk_used_acquisition_compute_v1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'get_case.no_raw_reason',
       'true', 'true',
       CASE WHEN (SELECT def FROM get_def) ILIKE '%dk_used_acquisition_parse_reason%'
             AND (SELECT def FROM get_def) ILIKE '%record_type%'
             AND (SELECT def FROM get_def) NOT ILIKE '%''reason'', d.reason%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'revaluation.status_gate',
       'true', 'true',
       CASE WHEN (SELECT def FROM run_def) ILIKE '%CONTACTED%'
             AND (SELECT def FROM run_def) ILIKE '%INSPECTION_PENDING%'
             AND (SELECT def FROM run_def) ILIKE '%backoffice_used_valuation_run_case%'
             AND (SELECT def FROM decision_def) ILIKE '%CONTACTED%'
             AND (SELECT def FROM decision_def) ILIKE '%INSPECTION_PENDING%'
             AND (SELECT def FROM comp_def) ILIKE '%CONTACTED%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'no_stage04_formula_copy',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) NOT ILIKE '%condition_multipliers%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%value_score%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%dk_used_valuation_compute_v1%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'no_stage05_modification',
       (to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NOT NULL
             AND to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'no_inventory_order_writes',
       'true', 'true',
       CASE WHEN (SELECT def FROM all_rpc_def) NOT ILIKE '%INSERT INTO public.inventory%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%UPDATE public.inventory%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%INSERT INTO public.orders%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%UPDATE public.orders%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'no_attendance_payroll_refs',
       'true', 'true',
       CASE WHEN (SELECT def FROM all_rpc_def) NOT ILIKE '%attendance%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%payroll%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'no_dynamic_sql',
       'true', 'true',
       CASE WHEN (SELECT def FROM all_rpc_def) NOT ILIKE '%EXECUTE format%'
             AND (SELECT def FROM all_rpc_def) NOT ILIKE '%EXECUTE v_%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'no_seed_data',
       ((SELECT n::text FROM seed_n)), '0',
       CASE WHEN (SELECT n FROM seed_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 55, 'stage04.run_case_still_present',
       (to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 56, 'create_decision.write_boundary',
       'true', 'true',
       CASE WHEN (SELECT def FROM decision_def) ILIKE '%INSERT INTO public.used_valuation_decisions%'
             AND (SELECT def FROM decision_def) ILIKE '%write_audit%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%UPDATE public.used_valuation_cases%'
             AND (SELECT def FROM decision_def) NOT ILIKE '%UPDATE public.used_valuation_results%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 57, 'encode.payload_limit',
       'true', 'true',
       CASE WHEN (SELECT def FROM encode_def) ILIKE '%INVALID_DECISION_PAYLOAD%'
             AND (SELECT def FROM encode_def) ILIKE '%2000%'
             AND (SELECT def FROM read_def) ILIKE '%500%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 58, 'risk_levels.record_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) NOT ILIKE '%LOW%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%MEDIUM%'
             AND (SELECT def FROM compute_def) NOT ILIKE '%HIGH%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 59, 'helpers.present',
       'true', 'true',
       CASE WHEN (SELECT compute FROM helper_oids) IS NOT NULL
             AND (SELECT floor_fn FROM helper_oids) IS NOT NULL
             AND (SELECT encode FROM helper_oids) IS NOT NULL
             AND (SELECT parse FROM helper_oids) IS NOT NULL
             AND (SELECT reason_type FROM helper_oids) IS NOT NULL
             AND (SELECT read_in FROM helper_oids) IS NOT NULL
             AND (SELECT rounding FROM helper_oids) IS NOT NULL
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'resale_stage07.absent',
       ((to_regclass('public.used_resale_links') IS NULL)::text), 'true',
       CASE WHEN to_regclass('public.used_resale_links') IS NULL
             AND to_regclass('public.used_valuation_external_links') IS NULL
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
