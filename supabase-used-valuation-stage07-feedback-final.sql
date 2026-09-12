-- ============================================================
-- DK Computer｜Stage 07 Feedback Loop + Final Security
--
-- 已收購案件的正式出售回饋：used_resale_links + Admin RPC。
-- 不寫 inventory / orders，不改 Stage 03～06 formula / public API。
-- 不建立 used_valuation_external_links。
--
-- Owner 複製各 SECTION 到 SQL Editor，必須分開執行：
--   1) P0_PREFLIGHT（read-only；任一 FAIL 則 STOP）
--   2) M1_FEEDBACK_LOOP（僅 P0 ALL PASS 後執行）
--   3) M2_FINAL_VERIFY（M1 成功後；要求 ALL PASS）
-- 本檔不得由 Cursor 對 Production 執行。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- 純 read-only scoreboard。不寫資料、不 CREATE/ALTER/DROP。
-- ============================================================

WITH core AS (
  SELECT
    to_regclass('public.used_valuation_cases') IS NOT NULL AS cases,
    to_regclass('public.used_valuation_components') IS NOT NULL AS components,
    to_regclass('public.used_valuation_results') IS NOT NULL AS results,
    to_regclass('public.used_valuation_decisions') IS NOT NULL AS decisions,
    to_regclass('public.used_valuation_audit_logs') IS NOT NULL AS audit_logs,
    to_regclass('public.used_acquisition_links') IS NOT NULL AS acq,
    to_regclass('public.used_market_batches') IS NOT NULL AS batches,
    to_regclass('public.used_valuation_rule_versions') IS NOT NULL AS rules,
    to_regclass('public.profiles') IS NOT NULL AS profiles
),
helpers AS (
  SELECT
    to_regprocedure('public.is_admin()') IS NOT NULL AS is_admin,
    to_regprocedure('public.dk_used_valuation_require_admin()') IS NOT NULL AS require_admin,
    to_regprocedure('public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NOT NULL AS write_audit,
    to_regprocedure('public.backoffice_used_valuation_run_case(uuid)') IS NOT NULL AS run_case,
    to_regprocedure('public.dk_used_acquisition_parse_reason(text)') IS NOT NULL AS parse_reason
),
stage05 AS (
  SELECT
    to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') IS NOT NULL AS estimate,
    to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL AS rate_limit
),
resold AS (
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'used_valuation_cases'
      AND c.conname = 'used_valuation_cases_status_ck'
      AND pg_get_constraintdef(c.oid) ILIKE '%RESOLD%'
  ) AS ok
),
resale_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_resale_links' AND c.relkind = 'r'
),
resale_cols AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'used_resale_links'
),
resale_expected AS (
  SELECT ARRAY[
    'id','case_id','acquisition_link_id',
    'actual_resale_price','actual_refurbishment_cost','sold_at','note',
    'actual_acquisition_price','actual_gross_profit','actual_margin_pct',
    'inventory_days','inventory_days_basis',
    'valuation_result_id','decision_id',
    'estimated_market_mid','estimated_recommended_acquisition','estimated_maximum_acquisition',
    'estimated_gross_profit','estimated_margin_pct',
    'created_by','created_at'
  ]::text[] AS names
),
ext_n AS (
  SELECT (to_regclass('public.used_valuation_external_links') IS NOT NULL)::int AS n
),
rpc_n AS (
  SELECT COUNT(*)::int AS n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'backoffice_used_valuation_create_resale',
      'backoffice_used_valuation_get_feedback'
    )
),
rpc_sig AS (
  SELECT (
    (to_regprocedure('public.backoffice_used_valuation_create_resale(uuid,jsonb)') IS NOT NULL)::int
    + (to_regprocedure('public.backoffice_used_valuation_get_feedback(uuid)') IS NOT NULL)::int
  ) AS n
),
acq_cols AS (
  SELECT COUNT(*)::int AS n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'used_acquisition_links'
    AND column_name IN (
      'id','case_id','decision_id','actual_acquisition_price','acquired_at','created_by','created_at'
    )
)
SELECT 1 AS seq, 'table.used_valuation_cases'::text AS check_name,
       (SELECT cases::text FROM core) AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT cases FROM core) THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'table.used_valuation_results',
       (SELECT results::text FROM core), 'true',
       CASE WHEN (SELECT results FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'table.used_valuation_decisions',
       (SELECT decisions::text FROM core), 'true',
       CASE WHEN (SELECT decisions FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'table.used_valuation_audit_logs',
       (SELECT audit_logs::text FROM core), 'true',
       CASE WHEN (SELECT audit_logs FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'table.used_acquisition_links',
       (SELECT acq::text FROM core), 'true',
       CASE WHEN (SELECT acq FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'acquisition.core_columns',
       (SELECT n::text FROM acq_cols), '7',
       CASE WHEN (SELECT n FROM acq_cols) = 7 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'helper.is_admin',
       (SELECT is_admin::text FROM helpers), 'true',
       CASE WHEN (SELECT is_admin FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'helper.require_admin',
       (SELECT require_admin::text FROM helpers), 'true',
       CASE WHEN (SELECT require_admin FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'helper.write_audit',
       (SELECT write_audit::text FROM helpers), 'true',
       CASE WHEN (SELECT write_audit FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'rpc.run_case',
       (SELECT run_case::text FROM helpers), 'true',
       CASE WHEN (SELECT run_case FROM helpers) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'stage05.estimate',
       (SELECT estimate::text FROM stage05), 'true',
       CASE WHEN (SELECT estimate FROM stage05) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'stage05.rate_limit',
       (SELECT rate_limit::text FROM stage05), 'true',
       CASE WHEN (SELECT rate_limit FROM stage05) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'lifecycle.resold_allowed',
       (SELECT ok::text FROM resold), 'true',
       CASE WHEN (SELECT ok FROM resold) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'used_resale_links.state',
       CASE
         WHEN (SELECT n FROM resale_n) = 0 THEN 'absent'
         WHEN (SELECT n FROM resale_n) = 1
              AND (SELECT names FROM resale_cols) = (SELECT names FROM resale_expected)
           THEN 'compatible'
         WHEN (SELECT n FROM resale_n) = 1 THEN 'incompatible'
         ELSE (SELECT n::text FROM resale_n)
       END,
       'absent or compatible',
       CASE
         WHEN (SELECT n FROM resale_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM resale_n) = 1
              AND (SELECT names FROM resale_cols) = (SELECT names FROM resale_expected)
           THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 15, 'stage02.external_links_absent',
       (SELECT n::text FROM ext_n), '0',
       CASE WHEN (SELECT n FROM ext_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'stage07.rpc_no_conflict',
       ((SELECT n::text FROM rpc_n) || '/' || (SELECT n::text FROM rpc_sig)), '0 or 2/2',
       CASE
         WHEN (SELECT n FROM rpc_n) = 0 THEN 'PASS'
         WHEN (SELECT n FROM rpc_n) = 2 AND (SELECT n FROM rpc_sig) = 2 THEN 'PASS'
         ELSE 'FAIL'
       END
UNION ALL SELECT 17, 'anon.decisions_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_valuation_decisions', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'anon.acquisition_select_denied',
       ((NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT') THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'stage04.market_batches',
       (SELECT batches::text FROM core), 'true',
       CASE WHEN (SELECT batches FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'stage04.rule_versions',
       (SELECT rules::text FROM core), 'true',
       CASE WHEN (SELECT rules FROM core) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'helper.parse_reason',
       (SELECT parse_reason::text FROM helpers), 'true',
       CASE WHEN (SELECT parse_reason FROM helpers) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;


-- ============================================================
-- SECTION M1_FEEDBACK_LOOP
-- 單一 transaction。可安全重試。
-- 允許：used_resale_links、Stage 07 helpers/RPC、ACL。
-- 禁止：ALTER Stage 02～06 欄位、seed、inventory / orders / public API。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_valuation_cases') IS NULL
     OR to_regclass('public.used_acquisition_links') IS NULL
     OR to_regclass('public.used_valuation_decisions') IS NULL
     OR to_regclass('public.used_valuation_results') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.dk_used_valuation_require_admin()') IS NULL
     OR to_regprocedure('public.dk_used_valuation_write_audit(uuid,text,text,uuid,text,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.dk_used_acquisition_parse_reason(text)') IS NULL
     OR to_regprocedure('public.dk_used_acquisition_reason_type(text)') IS NULL
  THEN
    RAISE EXCEPTION 'M1 blocked: Stage 02/06 foundation missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'used_valuation_cases'
      AND c.conname = 'used_valuation_cases_status_ck'
      AND pg_get_constraintdef(c.oid) ILIKE '%RESOLD%'
  ) THEN
    RAISE EXCEPTION 'M1 blocked: SCHEMA GAP: RESOLD STATUS NOT ALLOWED';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.used_resale_links (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.used_valuation_cases(id) ON DELETE RESTRICT,
  acquisition_link_id uuid NOT NULL REFERENCES public.used_acquisition_links(id) ON DELETE RESTRICT,
  actual_resale_price numeric NOT NULL,
  actual_refurbishment_cost numeric NOT NULL,
  sold_at timestamptz NOT NULL,
  note text NULL,
  actual_acquisition_price numeric NOT NULL,
  actual_gross_profit numeric NOT NULL,
  actual_margin_pct numeric NULL,
  inventory_days integer NOT NULL,
  inventory_days_basis text NOT NULL,
  valuation_result_id uuid NULL REFERENCES public.used_valuation_results(id) ON DELETE RESTRICT,
  decision_id uuid NULL REFERENCES public.used_valuation_decisions(id) ON DELETE RESTRICT,
  estimated_market_mid numeric NULL,
  estimated_recommended_acquisition numeric NULL,
  estimated_maximum_acquisition numeric NULL,
  estimated_gross_profit numeric NULL,
  estimated_margin_pct numeric NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_resale_links_case_uidx UNIQUE (case_id),
  CONSTRAINT used_resale_links_acq_uidx UNIQUE (acquisition_link_id),
  CONSTRAINT used_resale_links_resale_price_ck CHECK (actual_resale_price >= 0),
  CONSTRAINT used_resale_links_refurb_ck CHECK (actual_refurbishment_cost >= 0),
  CONSTRAINT used_resale_links_acq_price_ck CHECK (actual_acquisition_price >= 0),
  CONSTRAINT used_resale_links_days_ck CHECK (inventory_days >= 0),
  CONSTRAINT used_resale_links_basis_ck
    CHECK (inventory_days_basis IN ('acquired_at')),
  CONSTRAINT used_resale_links_note_ck
    CHECK (note IS NULL OR pg_catalog.length(note) <= 1000)
);

COMMENT ON TABLE public.used_resale_links IS
  'Stage 07 actual resale feedback. One row per acquired case. INSERT-only. No inventory/order writes.';

ALTER TABLE public.used_resale_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.used_resale_links FROM PUBLIC;
REVOKE ALL ON TABLE public.used_resale_links FROM anon;
REVOKE ALL ON TABLE public.used_resale_links FROM authenticated;
GRANT SELECT ON TABLE public.used_resale_links TO authenticated;

DROP POLICY IF EXISTS used_resale_links_select_admin ON public.used_resale_links;
CREATE POLICY used_resale_links_select_admin
  ON public.used_resale_links
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.used_resale_links_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'used_resale_links is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_used_resale_links_immutable ON public.used_resale_links;
CREATE TRIGGER trg_used_resale_links_immutable
  BEFORE UPDATE OR DELETE ON public.used_resale_links
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_resale_links_immutable();

REVOKE ALL ON FUNCTION public.used_resale_links_immutable() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_used_resale_compute_v1(
  p_resale numeric,
  p_acq numeric,
  p_refurb numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_gross numeric;
  v_margin numeric;
BEGIN
  IF p_resale IS NULL OR p_resale < 0
     OR p_acq IS NULL OR p_acq < 0
     OR p_refurb IS NULL OR p_refurb < 0 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  END IF;
  v_gross := p_resale - p_acq - p_refurb;
  IF p_resale > 0 THEN
    v_margin := (v_gross / p_resale) * 100;
  ELSE
    v_margin := NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'actual_resale_price', p_resale::numeric(14, 2),
    'actual_acquisition_price', p_acq::numeric(14, 2),
    'actual_refurbishment_cost', p_refurb::numeric(14, 2),
    'actual_gross_profit', v_gross::numeric(14, 2),
    'actual_margin_pct', v_margin::numeric(8, 4)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_resale_compute_v1(numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dk_used_resale_read_inputs(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_price numeric;
  v_refurb numeric;
  v_sold timestamptz;
  v_note text;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'actual_resale_price') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_RESALE_PRICE';
  END IF;
  BEGIN
    v_price := (p_payload->>'actual_resale_price')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_RESALE_PRICE';
  END;
  IF v_price IS NULL
     OR v_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_price < 0
     OR v_price > 10000000 THEN
    RAISE EXCEPTION 'INVALID_RESALE_PRICE';
  END IF;
  IF pg_catalog.jsonb_typeof(p_payload->'actual_refurbishment_cost') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END IF;
  BEGIN
    v_refurb := (p_payload->>'actual_refurbishment_cost')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END;
  IF v_refurb IS NULL
     OR v_refurb::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_refurb < 0
     OR v_refurb > 10000000 THEN
    RAISE EXCEPTION 'INVALID_REFURBISHMENT_COST';
  END IF;
  IF p_payload ? 'sold_at'
     AND pg_catalog.jsonb_typeof(p_payload->'sold_at') IS DISTINCT FROM 'string'
     AND pg_catalog.jsonb_typeof(p_payload->'sold_at') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'INVALID_SOLD_AT';
  END IF;
  BEGIN
    v_sold := (p_payload->>'sold_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'INVALID_SOLD_AT';
  END;
  IF v_sold IS NULL THEN
    RAISE EXCEPTION 'INVALID_SOLD_AT';
  END IF;
  IF p_payload ? 'note'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'string'
     AND pg_catalog.jsonb_typeof(p_payload->'note') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'note', '')), '');
  IF v_note IS NOT NULL AND pg_catalog.length(v_note) > 1000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'actual_resale_price', v_price,
    'actual_refurbishment_cost', v_refurb,
    'sold_at', to_jsonb(v_sold),
    'note', to_jsonb(v_note)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dk_used_resale_read_inputs(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_create_resale(p_case_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_acq public.used_acquisition_links%ROWTYPE;
  v_dec public.used_valuation_decisions%ROWTYPE;
  v_eval public.used_valuation_decisions%ROWTYPE;
  v_result public.used_valuation_results%ROWTYPE;
  v_in jsonb;
  v_out jsonb;
  v_sold timestamptz;
  v_days integer;
  v_id uuid;
  v_snap jsonb;
  v_est_gross numeric;
  v_est_margin numeric;
  v_val_id uuid;
  v_dec_id uuid;
  v_est_mid numeric;
  v_est_rec numeric;
  v_est_max numeric;
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
  WHERE id = p_case_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASE_NOT_FOUND';
  END IF;
  IF v_case.status = 'RESOLD' THEN
    RAISE EXCEPTION 'RESALE_ALREADY_EXISTS';
  END IF;
  IF v_case.status IS DISTINCT FROM 'ACQUIRED' THEN
    RAISE EXCEPTION 'CASE_NOT_ACQUIRED';
  END IF;
  SELECT * INTO v_acq
  FROM public.used_acquisition_links
  WHERE case_id = v_case.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACQUISITION_NOT_FOUND';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.used_resale_links r WHERE r.case_id = v_case.id
  ) THEN
    RAISE EXCEPTION 'RESALE_ALREADY_EXISTS';
  END IF;
  v_in := public.dk_used_resale_read_inputs(p_payload);
  v_sold := (v_in->>'sold_at')::timestamptz;
  IF v_sold < v_acq.acquired_at THEN
    RAISE EXCEPTION 'INVALID_SOLD_AT';
  END IF;
  IF v_sold > pg_catalog.now() + interval '1 day' THEN
    RAISE EXCEPTION 'INVALID_SOLD_AT';
  END IF;
  v_days := GREATEST(
    0,
    pg_catalog.floor(
      EXTRACT(EPOCH FROM (v_sold - v_acq.acquired_at)) / 86400
    )::integer
  );
  v_out := public.dk_used_resale_compute_v1(
    (v_in->>'actual_resale_price')::numeric,
    v_acq.actual_acquisition_price,
    (v_in->>'actual_refurbishment_cost')::numeric
  );
  IF COALESCE((v_out->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_out->>'code', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_dec
  FROM public.used_valuation_decisions
  WHERE id = v_acq.decision_id
    AND case_id = v_case.id;
  IF FOUND THEN
    v_dec_id := v_dec.id;
    v_val_id := v_dec.valuation_result_id;
    v_est_rec := v_dec.system_recommended_acquisition;
    v_est_max := v_dec.system_maximum_acquisition;
    SELECT * INTO v_result
    FROM public.used_valuation_results
    WHERE id = v_dec.valuation_result_id
      AND case_id = v_case.id;
    IF FOUND THEN
      v_est_mid := v_result.market_mid;
    END IF;
    SELECT * INTO v_eval
    FROM public.used_valuation_decisions e
    WHERE e.case_id = v_case.id
      AND e.valuation_result_id = v_dec.valuation_result_id
      AND public.dk_used_acquisition_reason_type(e.reason) = 'ACQUISITION_EVALUATION'
    ORDER BY e.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      v_snap := public.dk_used_acquisition_parse_reason(v_eval.reason);
      IF v_snap IS NOT NULL THEN
        BEGIN
          v_est_gross := (v_snap->>'estimated_gross_profit')::numeric;
          v_est_margin := (v_snap->>'estimated_margin_pct')::numeric;
        EXCEPTION WHEN others THEN
          v_est_gross := NULL;
          v_est_margin := NULL;
        END;
      END IF;
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.used_resale_links (
      case_id, acquisition_link_id,
      actual_resale_price, actual_refurbishment_cost, sold_at, note,
      actual_acquisition_price, actual_gross_profit, actual_margin_pct,
      inventory_days, inventory_days_basis,
      valuation_result_id, decision_id,
      estimated_market_mid, estimated_recommended_acquisition, estimated_maximum_acquisition,
      estimated_gross_profit, estimated_margin_pct,
      created_by
    ) VALUES (
      v_case.id, v_acq.id,
      (v_out->>'actual_resale_price')::numeric,
      (v_out->>'actual_refurbishment_cost')::numeric,
      v_sold,
      NULLIF(v_in->>'note', ''),
      (v_out->>'actual_acquisition_price')::numeric,
      (v_out->>'actual_gross_profit')::numeric,
      NULLIF(v_out->>'actual_margin_pct', '')::numeric,
      v_days,
      'acquired_at',
      v_val_id,
      v_dec_id,
      v_est_mid,
      v_est_rec,
      v_est_max,
      v_est_gross,
      v_est_margin,
      v_uid
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'RESALE_ALREADY_EXISTS';
  END;
  UPDATE public.used_valuation_cases
  SET status = 'RESOLD'
  WHERE id = v_case.id;
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'RESALE_CREATED', 'RESALE_LINK', v_id, NULLIF(v_in->>'note', ''),
    pg_catalog.jsonb_build_object('status', v_case.status),
    pg_catalog.jsonb_build_object(
      'id', v_id,
      'case_id', v_case.id,
      'acquisition_link_id', v_acq.id,
      'actual_resale_price', (v_out->>'actual_resale_price')::numeric,
      'actual_gross_profit', (v_out->>'actual_gross_profit')::numeric,
      'inventory_days', v_days,
      'status', 'RESOLD'
    )
  );
  PERFORM public.dk_used_valuation_write_audit(
    v_uid, 'CASE_STATUS_CHANGED', 'VALUATION_CASE', v_case.id, NULL,
    pg_catalog.jsonb_build_object('status', v_case.status),
    pg_catalog.jsonb_build_object('status', 'RESOLD', 'resale_id', v_id)
  );
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', v_id,
    'case_id', v_case.id,
    'status', 'RESOLD'
  ) || v_out
    || pg_catalog.jsonb_build_object('inventory_days', v_days);
END;
$$;

CREATE OR REPLACE FUNCTION public.backoffice_used_valuation_get_feedback(p_case_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_case public.used_valuation_cases%ROWTYPE;
  v_row jsonb;
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
  SELECT pg_catalog.jsonb_build_object(
    'id', r.id,
    'case_id', r.case_id,
    'acquisition_link_id', r.acquisition_link_id,
    'actual_resale_price', r.actual_resale_price,
    'actual_refurbishment_cost', r.actual_refurbishment_cost,
    'sold_at', r.sold_at,
    'note', r.note,
    'actual_acquisition_price', r.actual_acquisition_price,
    'actual_gross_profit', r.actual_gross_profit,
    'actual_margin_pct', r.actual_margin_pct,
    'inventory_days', r.inventory_days,
    'inventory_days_basis', r.inventory_days_basis,
    'valuation_result_id', r.valuation_result_id,
    'decision_id', r.decision_id,
    'estimated_market_mid', r.estimated_market_mid,
    'estimated_recommended_acquisition', r.estimated_recommended_acquisition,
    'estimated_maximum_acquisition', r.estimated_maximum_acquisition,
    'estimated_gross_profit', r.estimated_gross_profit,
    'estimated_margin_pct', r.estimated_margin_pct,
    'created_at', r.created_at
  )
    INTO v_row
  FROM public.used_resale_links r
  WHERE r.case_id = p_case_id;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'case_id', v_case.id,
    'status', v_case.status,
    'resale', v_row
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_used_valuation_create_resale(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backoffice_used_valuation_get_feedback(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_create_resale(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_used_valuation_get_feedback(uuid) TO authenticated;

COMMIT;


-- ============================================================
-- SECTION M2_FINAL_VERIFY
-- 純 read-only scoreboard。最後一個 statement 必須是本 SELECT。
-- ============================================================

WITH resale AS (
  SELECT to_regclass('public.used_resale_links') AS reg
),
resale_cols AS (
  SELECT COALESCE(array_agg(c.column_name::text ORDER BY c.ordinal_position), ARRAY[]::text[]) AS names
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'used_resale_links'
),
resale_uniq AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_resale_links'
    AND i.indisunique
    AND pg_get_indexdef(i.indexrelid) ILIKE '%(case_id)%'
),
resale_ck AS (
  SELECT
    COUNT(*) FILTER (WHERE c.conname = 'used_resale_links_resale_price_ck')::int AS price_n,
    COUNT(*) FILTER (WHERE c.conname = 'used_resale_links_refurb_ck')::int AS refurb_n,
    COUNT(*) FILTER (WHERE c.conname = 'used_resale_links_case_uidx')::int AS uniq_n
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_resale_links'
),
resale_gross_ck AS (
  SELECT COUNT(*)::int AS n
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'used_resale_links'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%actual_gross_profit%'
    AND pg_get_constraintdef(c.oid) ILIKE '%>=%'
),
rpc_sigs AS (
  SELECT * FROM (VALUES
    ('public.backoffice_used_valuation_create_resale(uuid,jsonb)'),
    ('public.backoffice_used_valuation_get_feedback(uuid)')
  ) AS t(sig)
),
rpc_meta AS (
  SELECT s.sig, to_regprocedure(s.sig) AS oid FROM rpc_sigs s
),
rpc_def AS (
  SELECT m.sig, m.oid, p.prosecdef, p.proconfig,
         CASE WHEN m.oid IS NULL THEN '' ELSE pg_get_functiondef(m.oid) END AS def
  FROM rpc_meta m
  LEFT JOIN pg_proc p ON p.oid = m.oid
),
create_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_valuation_create_resale(uuid,jsonb)'
),
get_def AS (
  SELECT def FROM rpc_def WHERE sig = 'public.backoffice_used_valuation_get_feedback(uuid)'
),
compute_oid AS (
  SELECT to_regprocedure('public.dk_used_resale_compute_v1(numeric,numeric,numeric)') AS oid
),
compute_def AS (
  SELECT CASE WHEN oid IS NULL THEN '' ELSE pg_get_functiondef(oid) END AS def
  FROM compute_oid
),
helper_oids AS (
  SELECT
    to_regprocedure('public.dk_used_resale_compute_v1(numeric,numeric,numeric)') AS compute,
    to_regprocedure('public.dk_used_resale_read_inputs(jsonb)') AS read_in,
    to_regprocedure('public.used_resale_links_immutable()') AS imm,
    to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') AS stage04_compute
),
helper_exec AS (
  SELECT COUNT(*)::int AS n
  FROM unnest(ARRAY[
    (SELECT compute FROM helper_oids),
    (SELECT read_in FROM helper_oids),
    (SELECT imm FROM helper_oids)
  ]) AS oid
  WHERE oid IS NOT NULL
    AND (
      has_function_privilege('anon', oid, 'EXECUTE')
      OR has_function_privilege('authenticated', oid, 'EXECUTE')
    )
),
search_ok AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  CROSS JOIN LATERAL unnest(COALESCE(f.proconfig, ARRAY[]::text[])) cfg
  WHERE f.oid IS NOT NULL
    AND pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(cfg, '"', ''), '''', '')) = 'search_path='
),
definer_n AS (
  SELECT COUNT(*)::int AS n FROM rpc_def f WHERE f.oid IS NOT NULL AND f.prosecdef IS TRUE
),
admin_guard AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  WHERE f.def ILIKE '%is_admin()%' AND f.def ILIKE '%dk_used_valuation_require_admin%'
),
anon_rpc AS (
  SELECT COUNT(*)::int AS n
  FROM rpc_def f
  WHERE f.oid IS NOT NULL AND has_function_privilege('anon', f.oid, 'EXECUTE')
),
resale_pol AS (
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
  WHERE ns.nspname = 'public' AND c.relname = 'used_resale_links'
),
dec_pol AS (
  SELECT
    COUNT(*) FILTER (
      WHERE pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_enabled_backoffice_user%'
    )::int AS staff_n,
    COUNT(*) FILTER (
      WHERE pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_admin()%'
    )::int AS admin_n
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_valuation_decisions' AND p.polcmd = 'r'
),
est_oid AS (
  SELECT to_regprocedure('public.service_used_valuation_public_estimate(jsonb)') AS oid
),
est_def AS (
  SELECT CASE WHEN oid IS NULL THEN '' ELSE pg_get_functiondef(oid) END AS def
  FROM est_oid
),
s04_oid AS (
  SELECT to_regprocedure('public.dk_used_valuation_compute_v1(jsonb,uuid,uuid)') AS oid
),
seed_n AS (
  SELECT CASE
    WHEN (SELECT reg FROM resale) IS NULL THEN 0
    ELSE (SELECT COUNT(*)::int FROM public.used_resale_links)
  END AS n
),
resale_trg AS (
  SELECT COUNT(*)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'used_resale_links'
    AND NOT t.tgisinternal
    AND t.tgname = 'trg_used_resale_links_immutable'
),
resale_staff_pol AS (
  SELECT COUNT(*)::int AS n
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'used_resale_links'
    AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_enabled_backoffice_user%'
),
rl_oid AS (
  SELECT to_regprocedure('public.service_used_valuation_rate_limit(text)') AS oid
),
rpc_blob AS (
  SELECT pg_catalog.string_agg(def, E'\n') AS def FROM rpc_def
)
SELECT 1 AS seq, 'resale.table_exists'::text AS check_name,
       ((SELECT reg FROM resale) IS NOT NULL)::text AS actual, 'true'::text AS expected,
       CASE WHEN (SELECT reg FROM resale) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'resale.columns',
       array_to_string((SELECT names FROM resale_cols), ','),
       'typed feedback columns',
       CASE WHEN (SELECT names FROM resale_cols) = ARRAY[
         'id','case_id','acquisition_link_id',
         'actual_resale_price','actual_refurbishment_cost','sold_at','note',
         'actual_acquisition_price','actual_gross_profit','actual_margin_pct',
         'inventory_days','inventory_days_basis',
         'valuation_result_id','decision_id',
         'estimated_market_mid','estimated_recommended_acquisition','estimated_maximum_acquisition',
         'estimated_gross_profit','estimated_margin_pct',
         'created_by','created_at'
       ]::text[] THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'resale.unique_case',
       ((SELECT n::text FROM resale_uniq)), '>=1',
       CASE WHEN (SELECT n FROM resale_uniq) >= 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'resale.price_constraints',
       ((SELECT price_n::text FROM resale_ck) || '/' || (SELECT refurb_n::text FROM resale_ck)), '1/1',
       CASE WHEN (SELECT price_n FROM resale_ck) = 1 AND (SELECT refurb_n FROM resale_ck) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'resale.negative_gross_allowed',
       ((SELECT n::text FROM resale_gross_ck)), '0',
       CASE WHEN (SELECT n FROM resale_gross_ck) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'resale.rls_enabled',
       (SELECT c.relrowsecurity::text
        FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relname = 'used_resale_links'), 'true',
       CASE WHEN (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  WHERE ns.nspname = 'public' AND c.relname = 'used_resale_links')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'resale.admin_select_policy',
       ((SELECT admin_sel::text FROM resale_pol)), '>=1',
       CASE WHEN (SELECT admin_sel FROM resale_pol) >= 1
             AND (SELECT ins_n FROM resale_pol) = 0
             AND (SELECT upd_n FROM resale_pol) = 0
             AND (SELECT del_n FROM resale_pol) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'resale.anon_denied',
       ((NOT has_table_privilege('anon', 'public.used_resale_links', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_resale_links', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.used_resale_links', 'INSERT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'resale.direct_writes_denied',
       'true', 'true',
       CASE WHEN NOT has_table_privilege('authenticated', 'public.used_resale_links', 'INSERT')
             AND NOT has_table_privilege('authenticated', 'public.used_resale_links', 'UPDATE')
             AND NOT has_table_privilege('authenticated', 'public.used_resale_links', 'DELETE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'resale.append_only_trigger',
       ((SELECT imm FROM helper_oids) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT imm FROM helper_oids) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'rpc.all_exist',
       ((SELECT COUNT(*)::int FROM rpc_meta WHERE oid IS NOT NULL)::text), '2',
       CASE WHEN (SELECT COUNT(*) FROM rpc_meta WHERE oid IS NOT NULL) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'rpc.security_definer',
       ((SELECT n::text FROM definer_n)), '2',
       CASE WHEN (SELECT n FROM definer_n) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'rpc.search_path_safe',
       ((SELECT n::text FROM search_ok)), '2',
       CASE WHEN (SELECT n FROM search_ok) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'rpc.admin_guard',
       ((SELECT n::text FROM admin_guard)), '2',
       CASE WHEN (SELECT n FROM admin_guard) = 2 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'rpc.anon_execute_denied',
       ((SELECT n::text FROM anon_rpc)), '0',
       CASE WHEN (SELECT n FROM anon_rpc) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'helper.execute_denied',
       ((SELECT n::text FROM helper_exec)), '0',
       CASE WHEN (SELECT compute FROM helper_oids) IS NOT NULL
             AND (SELECT n FROM helper_exec) = 0
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'create.acquired_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%CASE_NOT_ACQUIRED%'
             AND (SELECT def FROM create_def) ILIKE '%ACQUIRED%'
             AND (SELECT def FROM create_def) ILIKE '%RESOLD%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'create.atomic_status',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%INSERT INTO public.used_resale_links%'
             AND (SELECT def FROM create_def) ILIKE '%status = ''RESOLD''%'
             AND (SELECT def FROM create_def) ILIKE '%FOR UPDATE%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'create.duplicate_denied',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%RESALE_ALREADY_EXISTS%'
             AND (SELECT def FROM create_def) ILIKE '%unique_violation%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'create.acquisition_binding',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%ACQUISITION_NOT_FOUND%'
             AND (SELECT def FROM create_def) ILIKE '%used_acquisition_links%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'create.server_acquisition_price',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%v_acq.actual_acquisition_price%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''actual_acquisition_price''%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''actual_gross_profit''%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''inventory_days''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'metrics.gross_profit',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%p_resale - p_acq - p_refurb%'
             AND (SELECT def FROM compute_def) ILIKE '%actual_gross_profit%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'metrics.zero_sale_margin_null',
       'true', 'true',
       CASE WHEN (SELECT def FROM compute_def) ILIKE '%p_resale > 0%'
             AND (SELECT def FROM compute_def) ILIKE '%v_margin := NULL%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'metrics.inventory_days_server',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%acquired_at%'
             AND (SELECT def FROM create_def) ILIKE '%inventory_days%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''inventory_days''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 25, 'metrics.sold_at_validation',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%INVALID_SOLD_AT%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 26, 'audit.resale',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%RESALE_CREATED%'
             AND (SELECT def FROM create_def) ILIKE '%CASE_STATUS_CHANGED%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 27, 'no_inventory_order_writes',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) NOT ILIKE '%INSERT INTO public.inventory%'
             AND (SELECT def FROM create_def) NOT ILIKE '%UPDATE public.inventory%'
             AND (SELECT def FROM create_def) NOT ILIKE '%INSERT INTO public.orders%'
             AND (SELECT def FROM create_def) NOT ILIKE '%UPDATE public.orders%'
             AND (SELECT def FROM get_def) NOT ILIKE '%INSERT INTO public.inventory%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 28, 'no_auto_rule_market_update',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) NOT ILIKE '%used_market_prices%'
             AND (SELECT def FROM create_def) NOT ILIKE '%used_valuation_rule_versions%'
             AND (SELECT def FROM create_def) NOT ILIKE '%private_config%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 29, 'no_dynamic_sql',
       'true', 'true',
       CASE WHEN (SELECT string_agg(def, E'\n') FROM rpc_def) NOT ILIKE '%EXECUTE format%'
             AND (SELECT string_agg(def, E'\n') FROM rpc_def) NOT ILIKE '%EXECUTE v_%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 30, 'no_ai_scraping',
       'true', 'true',
       CASE WHEN (SELECT string_agg(def, E'\n') FROM rpc_def) NOT ILIKE '%openai%'
             AND (SELECT string_agg(def, E'\n') FROM rpc_def) NOT ILIKE '%scrape%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 31, 'no_seed_data',
       ((SELECT n::text FROM seed_n)), '0',
       CASE WHEN (SELECT n FROM seed_n) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 32, 'get_feedback.read_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM get_def) NOT ILIKE '%INSERT%'
             AND (SELECT def FROM get_def) NOT ILIKE '%UPDATE%'
             AND (SELECT def FROM get_def) NOT ILIKE '%DELETE%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 33, 'v1.decisions_admin_only',
       ((SELECT admin_n::text FROM dec_pol) || '/' || (SELECT staff_n::text FROM dec_pol)), '>=1/0',
       CASE WHEN (SELECT admin_n FROM dec_pol) >= 1 AND (SELECT staff_n FROM dec_pol) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 34, 'v1.acquisition_admin_select',
       ((NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_acquisition_links', 'SELECT')
             AND NOT has_table_privilege('authenticated', 'public.used_acquisition_links', 'INSERT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 35, 'v1.public_estimate_exists',
       ((SELECT oid FROM est_oid) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 36, 'v1.public_estimate_no_financial',
       'true', 'true',
       CASE WHEN (SELECT def FROM est_def) NOT ILIKE '%system_recommended_acquisition%'
             AND (SELECT def FROM est_def) NOT ILIKE '%actual_acquisition_price%'
             AND (SELECT def FROM est_def) NOT ILIKE '%used_resale_links%'
             AND (SELECT def FROM est_def) NOT ILIKE '%used_acquisition_links%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 37, 'v1.public_estimate_anon_execute_denied',
       ((NOT has_function_privilege('anon', (SELECT oid FROM est_oid), 'EXECUTE'))::text), 'true',
       CASE WHEN (SELECT oid FROM est_oid) IS NOT NULL
             AND NOT has_function_privilege('anon', (SELECT oid FROM est_oid), 'EXECUTE')
             AND NOT has_function_privilege('authenticated', (SELECT oid FROM est_oid), 'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 38, 'v1.rate_limit_exists',
       (to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.service_used_valuation_rate_limit(text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 39, 'v1.stage04_compute_present',
       ((SELECT oid FROM s04_oid) IS NOT NULL)::text, 'true',
       CASE WHEN (SELECT oid FROM s04_oid) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 40, 'v1.stage04_compute_browser_denied',
       'true', 'true',
       CASE WHEN (SELECT oid FROM s04_oid) IS NOT NULL
             AND NOT has_function_privilege('anon', (SELECT oid FROM s04_oid), 'EXECUTE')
             AND NOT has_function_privilege('authenticated', (SELECT oid FROM s04_oid), 'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 41, 'v1.anon_market_denied',
       ((NOT has_table_privilege('anon', 'public.used_market_prices', 'SELECT'))::text), 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_market_prices', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.used_valuation_rule_versions', 'SELECT')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 42, 'v1.append_only.results',
       (to_regprocedure('public.used_valuation_results_immutable()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_results_immutable()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 43, 'v1.append_only.decisions',
       (to_regprocedure('public.used_valuation_decisions_immutable()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_decisions_immutable()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 44, 'v1.append_only.audit',
       (to_regprocedure('public.used_valuation_audit_immutable()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_audit_immutable()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 45, 'v1.append_only.acquisition',
       (to_regprocedure('public.used_acquisition_links_immutable()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_acquisition_links_immutable()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 46, 'v1.external_links_absent',
       ((to_regclass('public.used_valuation_external_links') IS NULL)::text), 'true',
       CASE WHEN to_regclass('public.used_valuation_external_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 47, 'v1.stage06.create_decision_present',
       (to_regprocedure('public.backoffice_used_acquisition_create_decision(jsonb)') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.backoffice_used_acquisition_create_decision(jsonb)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 48, 'v1.no_attendance_payroll',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) NOT ILIKE '%attendance%'
             AND (SELECT def FROM create_def) NOT ILIKE '%payroll%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 49, 'create.lock_case',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%FOR UPDATE%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 50, 'get_feedback.admin_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM get_def) ILIKE '%is_admin()%'
             AND (SELECT def FROM get_def) ILIKE '%dk_used_valuation_require_admin%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 51, 'resale.append_only_trigger_bound',
       ((SELECT n::text FROM resale_trg)), '1',
       CASE WHEN (SELECT n FROM resale_trg) = 1 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 52, 'resale.staff_select_policy_absent',
       ((SELECT n::text FROM resale_staff_pol)), '0',
       CASE WHEN (SELECT n FROM resale_staff_pol) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 53, 'v1.rate_limit_browser_denied',
       'true', 'true',
       CASE WHEN (SELECT oid FROM rl_oid) IS NOT NULL
             AND NOT has_function_privilege('anon', (SELECT oid FROM rl_oid), 'EXECUTE')
             AND NOT has_function_privilege('authenticated', (SELECT oid FROM rl_oid), 'EXECUTE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 54, 'no_service_key_in_rpc',
       'true', 'true',
       CASE WHEN (SELECT def FROM rpc_blob) NOT ILIKE '%service_role%'
             AND (SELECT def FROM rpc_blob) NOT ILIKE '%SUPABASE_SERVICE%'
             AND (SELECT def FROM rpc_blob) NOT ILIKE '%apikey%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 55, 'create.no_client_status',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''status''%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''created_by''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 56, 'create.no_client_link_ids',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''decision_id''%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''acquisition_link_id''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 57, 'create.inventory_days_acquired_at_only',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%v_sold - v_acq.acquired_at%'
             AND (SELECT def FROM create_def) NOT ILIKE '%v_sold - v_acq.created_at%'
             AND (SELECT def FROM create_def) NOT ILIKE '%p_payload->>''inventory_days''%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 58, 'create.decision_same_case',
       'true', 'true',
       CASE WHEN (SELECT def FROM create_def) ILIKE '%id = v_acq.decision_id%'
             AND (SELECT def FROM create_def) ILIKE '%case_id = v_case.id%'
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 59, 'resale.truncate_denied',
       'true', 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_resale_links', 'TRUNCATE')
             AND NOT has_table_privilege('authenticated', 'public.used_resale_links', 'TRUNCATE')
             AND NOT has_table_privilege('anon', 'public.used_acquisition_links', 'TRUNCATE')
             AND NOT has_table_privilege('authenticated', 'public.used_acquisition_links', 'TRUNCATE')
            THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 60, 'lifecycle.direct_case_update_denied',
       'true', 'true',
       CASE WHEN NOT has_table_privilege('anon', 'public.used_valuation_cases', 'UPDATE')
             AND NOT has_table_privilege('authenticated', 'public.used_valuation_cases', 'UPDATE')
            THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;
