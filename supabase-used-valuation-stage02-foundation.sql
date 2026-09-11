-- ============================================================
-- DK Computer｜Stage 02 Used Valuation Schema / Security Foundation
--
-- 只建立二手估價 domain 的 8 張核心表 + RLS / GRANT / append-only。
-- 不建立 Edge Function、RPC、前台、行情 UI、Engine、seed 價格。
-- 不碰 inventory / orders / profiles schema / 既有 auth helper。
-- 不建立 used_acquisition_links / used_resale_links /
-- used_valuation_external_links。
--
-- 本檔尚未對 Production 執行。Owner 複製各 SECTION 到 SQL Editor。
-- 建議順序：P0_PREFLIGHT → M0_SCHEMA → M1_SECURITY → M2_VERIFY
-- 每一 SECTION 請單獨複製執行（含 /* */ 內全文）。
--
-- 沿用既有 helper（不修改）：
--   public.is_admin()
--   public.is_enabled_backoffice_user()
-- 不新增 valuation_staff，不改 profiles.role。
-- ============================================================


-- ============================================================
-- SECTION P0_PREFLIGHT
-- read-only：確認 helper / profiles / UUID 可用，且 used_* 尚未存在。
-- 若 8 張 used_* 任一已存在：不要 DROP、不要 ALTER、不要繼續 M0。
-- 先執行 DO gate（existence RAISE），通過後最後一個 statement 輸出 24 列 scoreboard。
-- ============================================================
/*

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'P0 FAIL: public.profiles missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'P0 FAIL: public.is_admin() missing.';
  END IF;
  IF to_regprocedure('public.is_enabled_backoffice_user()') IS NULL THEN
    RAISE EXCEPTION 'P0 FAIL: public.is_enabled_backoffice_user() missing.';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'P0 FAIL: pg_catalog.gen_random_uuid() missing.';
  END IF;
  IF to_regclass('public.used_valuation_cases') IS NOT NULL
     OR to_regclass('public.used_valuation_components') IS NOT NULL
     OR to_regclass('public.used_market_batches') IS NOT NULL
     OR to_regclass('public.used_market_prices') IS NOT NULL
     OR to_regclass('public.used_valuation_rule_versions') IS NOT NULL
     OR to_regclass('public.used_valuation_results') IS NOT NULL
     OR to_regclass('public.used_valuation_decisions') IS NOT NULL
     OR to_regclass('public.used_valuation_audit_logs') IS NOT NULL
  THEN
    RAISE EXCEPTION 'P0 FAIL: a Stage 02 used_* table already exists. Do not DROP or ALTER.';
  END IF;
  IF to_regclass('public.used_acquisition_links') IS NOT NULL
     OR to_regclass('public.used_resale_links') IS NOT NULL
     OR to_regclass('public.used_valuation_external_links') IS NOT NULL
  THEN
    RAISE EXCEPTION 'P0 FAIL: a deferred used_* link table already exists. Do not DROP.';
  END IF;
  IF to_regprocedure('public.used_valuation_set_updated_at()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_audit_immutable()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_results_immutable()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_decisions_immutable()') IS NOT NULL
  THEN
    RAISE EXCEPTION 'P0 FAIL: a used_valuation helper function already exists. Do not DROP or REPLACE.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND t.tgname IN (
        'trg_used_valuation_cases_set_updated_at',
        'trg_used_market_prices_set_updated_at',
        'trg_used_valuation_audit_logs_immutable',
        'trg_used_valuation_results_immutable',
        'trg_used_valuation_decisions_immutable'
      )
  ) THEN
    RAISE EXCEPTION 'P0 FAIL: a used_valuation trigger already exists. Do not DROP.';
  END IF;
END
$$;

SELECT 1 AS seq, 'table.profiles' AS check_name,
       (to_regclass('public.profiles') IS NOT NULL)::text AS actual, 'true' AS expected,
       CASE WHEN to_regclass('public.profiles') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS verdict
UNION ALL SELECT 2, 'helper.is_admin',
       (to_regprocedure('public.is_admin()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 3, 'helper.is_enabled_backoffice_user',
       (to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.is_enabled_backoffice_user()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 4, 'helper.gen_random_uuid',
       (to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL)::text, 'true',
       CASE WHEN to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 5, 'absent.used_valuation_cases',
       (to_regclass('public.used_valuation_cases') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_cases') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 6, 'absent.used_valuation_components',
       (to_regclass('public.used_valuation_components') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_components') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 7, 'absent.used_market_batches',
       (to_regclass('public.used_market_batches') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_market_batches') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 8, 'absent.used_market_prices',
       (to_regclass('public.used_market_prices') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_market_prices') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 9, 'absent.used_valuation_rule_versions',
       (to_regclass('public.used_valuation_rule_versions') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_rule_versions') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 10, 'absent.used_valuation_results',
       (to_regclass('public.used_valuation_results') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_results') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 11, 'absent.used_valuation_decisions',
       (to_regclass('public.used_valuation_decisions') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_decisions') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 12, 'absent.used_valuation_audit_logs',
       (to_regclass('public.used_valuation_audit_logs') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_audit_logs') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 13, 'absent.used_acquisition_links',
       (to_regclass('public.used_acquisition_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_acquisition_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 14, 'absent.used_resale_links',
       (to_regclass('public.used_resale_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_resale_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 15, 'absent.used_valuation_external_links',
       (to_regclass('public.used_valuation_external_links') IS NULL)::text, 'true',
       CASE WHEN to_regclass('public.used_valuation_external_links') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 16, 'absent.fn.used_valuation_set_updated_at',
       (to_regprocedure('public.used_valuation_set_updated_at()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_set_updated_at()') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 17, 'absent.fn.used_valuation_audit_immutable',
       (to_regprocedure('public.used_valuation_audit_immutable()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_audit_immutable()') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 18, 'absent.fn.used_valuation_results_immutable',
       (to_regprocedure('public.used_valuation_results_immutable()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_results_immutable()') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 19, 'absent.fn.used_valuation_decisions_immutable',
       (to_regprocedure('public.used_valuation_decisions_immutable()') IS NULL)::text, 'true',
       CASE WHEN to_regprocedure('public.used_valuation_decisions_immutable()') IS NULL THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 20, 'absent.trg.used_valuation_cases_set_updated_at',
       (NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_cases_set_updated_at'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_cases_set_updated_at'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 21, 'absent.trg.used_market_prices_set_updated_at',
       (NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_market_prices_set_updated_at'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_market_prices_set_updated_at'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 22, 'absent.trg.used_valuation_audit_logs_immutable',
       (NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_audit_logs_immutable'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_audit_logs_immutable'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 23, 'absent.trg.used_valuation_results_immutable',
       (NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_results_immutable'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_results_immutable'
       ) THEN 'PASS' ELSE 'FAIL' END
UNION ALL SELECT 24, 'absent.trg.used_valuation_decisions_immutable',
       (NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_decisions_immutable'
       ))::text, 'true',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT t.tgisinternal
           AND t.tgname = 'trg_used_valuation_decisions_immutable'
       ) THEN 'PASS' ELSE 'FAIL' END
ORDER BY 1;

*/

-- P0_PREFLIGHT END


-- ============================================================
-- SECTION M0_SCHEMA
-- 8 tables + constraints + FK + indexes + append-only triggers
-- 若同名表已存在：RAISE，不 DROP、不 ALTER。
-- Production 以單一 transaction 執行：失敗則整段 rollback。
-- ============================================================
/*

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: public.profiles missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: pg_catalog.gen_random_uuid() missing.';
  END IF;
  IF to_regclass('public.used_valuation_cases') IS NOT NULL
     OR to_regclass('public.used_valuation_components') IS NOT NULL
     OR to_regclass('public.used_market_batches') IS NOT NULL
     OR to_regclass('public.used_market_prices') IS NOT NULL
     OR to_regclass('public.used_valuation_rule_versions') IS NOT NULL
     OR to_regclass('public.used_valuation_results') IS NOT NULL
     OR to_regclass('public.used_valuation_decisions') IS NOT NULL
     OR to_regclass('public.used_valuation_audit_logs') IS NOT NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: a used_* table already exists. Do not DROP or ALTER.';
  END IF;
  IF to_regclass('public.used_acquisition_links') IS NOT NULL
     OR to_regclass('public.used_resale_links') IS NOT NULL
     OR to_regclass('public.used_valuation_external_links') IS NOT NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: deferred link table already exists. Do not continue.';
  END IF;
  IF to_regprocedure('public.used_valuation_set_updated_at()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_audit_immutable()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_results_immutable()') IS NOT NULL
     OR to_regprocedure('public.used_valuation_decisions_immutable()') IS NOT NULL
  THEN
    RAISE EXCEPTION 'M0_SCHEMA blocked: used_valuation helper already exists. Do not REPLACE.';
  END IF;
END
$$;

CREATE TABLE public.used_valuation_cases (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  public_code text NULL,
  status text NOT NULL DEFAULT 'ESTIMATED',
  source_channel text NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_valuation_cases_public_code_key UNIQUE (public_code),
  CONSTRAINT used_valuation_cases_public_code_len_ck
    CHECK (public_code IS NULL OR (pg_catalog.length(public_code) >= 6 AND pg_catalog.length(public_code) <= 40)),
  CONSTRAINT used_valuation_cases_status_ck
    CHECK (status IN (
      'ESTIMATED',
      'SELL_INTENT',
      'CONTACTED',
      'INSPECTION_PENDING',
      'OFFERED',
      'ACCEPTED',
      'DECLINED',
      'EXPIRED',
      'ACQUIRED',
      'RESOLD'
    )),
  CONSTRAINT used_valuation_cases_source_channel_len_ck
    CHECK (source_channel IS NULL OR pg_catalog.length(source_channel) <= 40)
);

COMMENT ON TABLE public.used_valuation_cases IS
  'Stage 02 valuation case header. public_code unique, nullable until server generator exists. Status vocabulary only; no workflow RPC.';

CREATE INDEX used_valuation_cases_status_idx
  ON public.used_valuation_cases (status);

CREATE INDEX used_valuation_cases_created_at_idx
  ON public.used_valuation_cases (created_at DESC);

CREATE TABLE public.used_valuation_components (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.used_valuation_cases(id) ON DELETE RESTRICT,
  component_type text NOT NULL,
  brand text NULL,
  model text NULL,
  variant text NULL,
  spec text NULL,
  age_months integer NULL,
  condition_grade text NULL,
  warranty_end_date date NULL,
  note text NULL,
  raw_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_valuation_components_type_ck
    CHECK (component_type IN (
      'CPU',
      'GPU',
      'MOTHERBOARD',
      'RAM',
      'STORAGE',
      'PSU',
      'CASE',
      'COOLER',
      'LAPTOP',
      'OTHER'
    )),
  CONSTRAINT used_valuation_components_age_ck
    CHECK (age_months IS NULL OR age_months >= 0),
  CONSTRAINT used_valuation_components_ordinal_ck
    CHECK (ordinal >= 0),
  CONSTRAINT used_valuation_components_condition_len_ck
    CHECK (condition_grade IS NULL OR pg_catalog.length(condition_grade) <= 32)
);

COMMENT ON TABLE public.used_valuation_components IS
  'Stage 02 hardware spec snapshot for a valuation case. TEXT + CHECK types; no PostgreSQL ENUM.';

CREATE UNIQUE INDEX used_valuation_components_case_ordinal_uidx
  ON public.used_valuation_components (case_id, ordinal);

CREATE TABLE public.used_market_batches (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  batch_code text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  effective_date date NULL,
  source_summary text NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  published_at timestamptz NULL,
  CONSTRAINT used_market_batches_batch_code_key UNIQUE (batch_code),
  CONSTRAINT used_market_batches_status_ck
    CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  CONSTRAINT used_market_batches_batch_code_len_ck
    CHECK (pg_catalog.length(batch_code) >= 1 AND pg_catalog.length(batch_code) <= 80)
);

COMMENT ON TABLE public.used_market_batches IS
  'Stage 02 market data batch/version. At most one ACTIVE row. No activation RPC in this Stage.';

CREATE UNIQUE INDEX used_market_batches_one_active_uidx
  ON public.used_market_batches (status)
  WHERE status = 'ACTIVE';

CREATE TABLE public.used_market_prices (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  market_batch_id uuid NOT NULL REFERENCES public.used_market_batches(id) ON DELETE RESTRICT,
  category text NULL,
  brand text NULL,
  model text NULL,
  variant text NULL,
  market_low numeric NOT NULL,
  market_mid numeric NOT NULL,
  market_high numeric NOT NULL,
  sample_count integer NOT NULL DEFAULT 0,
  confidence integer NOT NULL DEFAULT 0,
  source_type text NULL,
  effective_date date NULL,
  note text NULL,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_market_prices_low_ck CHECK (market_low >= 0),
  CONSTRAINT used_market_prices_mid_ck CHECK (market_mid >= market_low),
  CONSTRAINT used_market_prices_high_ck CHECK (market_high >= market_mid),
  CONSTRAINT used_market_prices_sample_ck CHECK (sample_count >= 0),
  CONSTRAINT used_market_prices_confidence_ck CHECK (confidence >= 0 AND confidence <= 100)
);

COMMENT ON TABLE public.used_market_prices IS
  'Stage 02 manual/semi-auto market quotes. confidence integer 0-100. No price seed.';
COMMENT ON COLUMN public.used_market_prices.confidence IS
  'Integer 0-100, same scale as value_score. Not a 0-1 fraction.';

CREATE INDEX used_market_prices_batch_id_idx
  ON public.used_market_prices (market_batch_id);

CREATE INDEX used_market_prices_lookup_idx
  ON public.used_market_prices (category, brand, model);

CREATE UNIQUE INDEX used_market_prices_batch_model_uidx
  ON public.used_market_prices (
    market_batch_id,
    COALESCE(category, ''),
    COALESCE(brand, ''),
    COALESCE(model, ''),
    COALESCE(variant, '')
  );

CREATE TABLE public.used_valuation_rule_versions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  version_code text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  private_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  activated_at timestamptz NULL,
  CONSTRAINT used_valuation_rule_versions_version_code_key UNIQUE (version_code),
  CONSTRAINT used_valuation_rule_versions_status_ck
    CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  CONSTRAINT used_valuation_rule_versions_version_code_len_ck
    CHECK (pg_catalog.length(version_code) >= 1 AND pg_catalog.length(version_code) <= 80)
);

COMMENT ON TABLE public.used_valuation_rule_versions IS
  'Stage 02 private engine config container. At most one ACTIVE row. Empty JSONB only; no real coefficients in this Stage.';

CREATE UNIQUE INDEX used_valuation_rule_versions_one_active_uidx
  ON public.used_valuation_rule_versions (status)
  WHERE status = 'ACTIVE';
COMMENT ON COLUMN public.used_valuation_rule_versions.private_config IS
  'Server-side private. Staff/anon must not SELECT this table.';

CREATE TABLE public.used_valuation_results (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.used_valuation_cases(id) ON DELETE RESTRICT,
  market_batch_id uuid NOT NULL REFERENCES public.used_market_batches(id) ON DELETE RESTRICT,
  rule_version_id uuid NOT NULL REFERENCES public.used_valuation_rule_versions(id) ON DELETE RESTRICT,
  market_low numeric NULL,
  market_mid numeric NULL,
  market_high numeric NULL,
  value_score integer NULL,
  public_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  market_updated_at timestamptz NULL,
  recommended_acquisition numeric NULL,
  maximum_acquisition numeric NULL,
  estimated_refurbishment_cost numeric NULL,
  estimated_resale_price numeric NULL,
  estimated_gross_profit numeric NULL,
  estimated_margin_pct numeric NULL,
  liquidity_level text NULL,
  market_risk_level text NULL,
  inventory_risk_level text NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  market_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_valuation_results_value_score_ck
    CHECK (value_score IS NULL OR (value_score >= 0 AND value_score <= 100)),
  CONSTRAINT used_valuation_results_market_low_ck
    CHECK (market_low IS NULL OR market_low >= 0),
  CONSTRAINT used_valuation_results_market_mid_ck
    CHECK (market_mid IS NULL OR market_mid >= 0),
  CONSTRAINT used_valuation_results_market_high_ck
    CHECK (market_high IS NULL OR market_high >= 0),
  CONSTRAINT used_valuation_results_market_order_ck
    CHECK (
      market_low IS NULL OR market_mid IS NULL OR market_high IS NULL
      OR (market_mid >= market_low AND market_high >= market_mid)
    ),
  CONSTRAINT used_valuation_results_acq_ck
    CHECK (recommended_acquisition IS NULL OR recommended_acquisition >= 0),
  CONSTRAINT used_valuation_results_max_acq_ck
    CHECK (maximum_acquisition IS NULL OR maximum_acquisition >= 0),
  CONSTRAINT used_valuation_results_acq_bounds_ck
    CHECK (
      recommended_acquisition IS NULL
      OR maximum_acquisition IS NULL
      OR recommended_acquisition <= maximum_acquisition
    ),
  CONSTRAINT used_valuation_results_refurb_ck
    CHECK (estimated_refurbishment_cost IS NULL OR estimated_refurbishment_cost >= 0),
  CONSTRAINT used_valuation_results_resale_ck
    CHECK (estimated_resale_price IS NULL OR estimated_resale_price >= 0),
  CONSTRAINT used_valuation_results_level_len_ck
    CHECK (
      (liquidity_level IS NULL OR pg_catalog.length(liquidity_level) <= 32)
      AND (market_risk_level IS NULL OR pg_catalog.length(market_risk_level) <= 32)
      AND (inventory_risk_level IS NULL OR pg_catalog.length(inventory_risk_level) <= 32)
    )
);

COMMENT ON TABLE public.used_valuation_results IS
  'Stage 02 immutable estimate snapshot. Public and internal columns on one row; anon has no SELECT. Re-estimate = new row.';

CREATE INDEX used_valuation_results_case_id_idx
  ON public.used_valuation_results (case_id);

CREATE INDEX used_valuation_results_created_at_idx
  ON public.used_valuation_results (created_at DESC);

CREATE TABLE public.used_valuation_decisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.used_valuation_cases(id) ON DELETE RESTRICT,
  valuation_result_id uuid NOT NULL REFERENCES public.used_valuation_results(id) ON DELETE RESTRICT,
  system_recommended_acquisition numeric NOT NULL,
  system_maximum_acquisition numeric NOT NULL,
  final_offer numeric NOT NULL,
  reason text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_valuation_decisions_sys_rec_ck
    CHECK (system_recommended_acquisition >= 0),
  CONSTRAINT used_valuation_decisions_sys_max_ck
    CHECK (system_maximum_acquisition >= 0),
  CONSTRAINT used_valuation_decisions_acq_bounds_ck
    CHECK (system_recommended_acquisition <= system_maximum_acquisition),
  CONSTRAINT used_valuation_decisions_final_ck
    CHECK (final_offer >= 0),
  CONSTRAINT used_valuation_decisions_reason_ck
    CHECK (pg_catalog.length(btrim(reason)) >= 1 AND pg_catalog.length(reason) <= 2000)
);

COMMENT ON TABLE public.used_valuation_decisions IS
  'Stage 02 append-only acquisition decision. Keeps system recommendation and final offer. No override RPC in this Stage.';

CREATE INDEX used_valuation_decisions_case_id_idx
  ON public.used_valuation_decisions (case_id);

CREATE TABLE public.used_valuation_audit_logs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  actor_user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NULL,
  reason text NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT used_valuation_audit_logs_action_len_ck
    CHECK (pg_catalog.length(action) >= 1 AND pg_catalog.length(action) <= 80),
  CONSTRAINT used_valuation_audit_logs_entity_type_len_ck
    CHECK (pg_catalog.length(entity_type) >= 1 AND pg_catalog.length(entity_type) <= 80)
);

COMMENT ON TABLE public.used_valuation_audit_logs IS
  'Stage 02 append-only valuation audit. UPDATE/DELETE blocked by trigger.';

CREATE INDEX used_valuation_audit_logs_entity_idx
  ON public.used_valuation_audit_logs (entity_type, entity_id);

CREATE INDEX used_valuation_audit_logs_created_at_idx
  ON public.used_valuation_audit_logs (created_at DESC);

CREATE FUNCTION public.used_valuation_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.used_valuation_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'used_valuation_audit_logs is append-only';
END;
$$;

CREATE FUNCTION public.used_valuation_results_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'used_valuation_results is append-only';
END;
$$;

CREATE FUNCTION public.used_valuation_decisions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'used_valuation_decisions is append-only';
END;
$$;

CREATE TRIGGER trg_used_valuation_cases_set_updated_at
  BEFORE UPDATE ON public.used_valuation_cases
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_valuation_set_updated_at();

CREATE TRIGGER trg_used_market_prices_set_updated_at
  BEFORE UPDATE ON public.used_market_prices
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_valuation_set_updated_at();

CREATE TRIGGER trg_used_valuation_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.used_valuation_audit_logs
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_valuation_audit_immutable();

CREATE TRIGGER trg_used_valuation_results_immutable
  BEFORE UPDATE OR DELETE ON public.used_valuation_results
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_valuation_results_immutable();

CREATE TRIGGER trg_used_valuation_decisions_immutable
  BEFORE UPDATE OR DELETE ON public.used_valuation_decisions
  FOR EACH ROW
  EXECUTE PROCEDURE public.used_valuation_decisions_immutable();

ALTER TABLE public.used_valuation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_valuation_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_market_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_market_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_valuation_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_valuation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_valuation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.used_valuation_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.used_valuation_cases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_valuation_components FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_market_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_market_prices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_valuation_rule_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_valuation_results FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_valuation_decisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.used_valuation_audit_logs FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.used_valuation_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.used_valuation_audit_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.used_valuation_results_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.used_valuation_decisions_immutable() FROM PUBLIC, anon, authenticated;

COMMIT;

*/

-- M0_SCHEMA END


-- ============================================================
-- SECTION M1_SECURITY
-- 正式 GRANT SELECT + SELECT policies。
-- 無 INSERT / UPDATE / DELETE policy。
-- anon: 不 GRANT、不建 policy。
-- M0 已 ENABLE RLS 並 REVOKE ALL；本段不再重複 bootstrap lock。
-- Future writes: Edge Function / service_role / later RPC.
-- ============================================================
/*

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.used_valuation_cases') IS NULL
     OR to_regclass('public.used_valuation_components') IS NULL
     OR to_regclass('public.used_market_batches') IS NULL
     OR to_regclass('public.used_market_prices') IS NULL
     OR to_regclass('public.used_valuation_rule_versions') IS NULL
     OR to_regclass('public.used_valuation_results') IS NULL
     OR to_regclass('public.used_valuation_decisions') IS NULL
     OR to_regclass('public.used_valuation_audit_logs') IS NULL
  THEN
    RAISE EXCEPTION 'M1_SECURITY blocked: used_* tables missing. Run M0_SCHEMA first.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.is_enabled_backoffice_user()') IS NULL
  THEN
    RAISE EXCEPTION 'M1_SECURITY blocked: is_admin / is_enabled_backoffice_user missing.';
  END IF;
END
$$;

GRANT SELECT ON TABLE public.used_valuation_cases TO authenticated;
GRANT SELECT ON TABLE public.used_valuation_components TO authenticated;
GRANT SELECT ON TABLE public.used_market_batches TO authenticated;
GRANT SELECT ON TABLE public.used_market_prices TO authenticated;
GRANT SELECT ON TABLE public.used_valuation_rule_versions TO authenticated;
GRANT SELECT ON TABLE public.used_valuation_results TO authenticated;
GRANT SELECT ON TABLE public.used_valuation_decisions TO authenticated;
GRANT SELECT ON TABLE public.used_valuation_audit_logs TO authenticated;

CREATE POLICY used_valuation_cases_select_backoffice
  ON public.used_valuation_cases
  FOR SELECT
  TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY used_valuation_components_select_backoffice
  ON public.used_valuation_components
  FOR SELECT
  TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY used_valuation_results_select_backoffice
  ON public.used_valuation_results
  FOR SELECT
  TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY used_valuation_decisions_select_backoffice
  ON public.used_valuation_decisions
  FOR SELECT
  TO authenticated
  USING (public.is_enabled_backoffice_user());

CREATE POLICY used_market_batches_select_admin
  ON public.used_market_batches
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY used_market_prices_select_admin
  ON public.used_market_prices
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY used_valuation_rule_versions_select_admin
  ON public.used_valuation_rule_versions
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

CREATE POLICY used_valuation_audit_logs_select_admin
  ON public.used_valuation_audit_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

COMMIT;

*/

-- M1_SECURITY END


-- ============================================================
-- SECTION M2_VERIFY
-- 純 read-only catalog / privilege scoreboard。
-- 本段是真正可執行 SQL，不要再用區塊註解包住整段 query。
-- 不得 CREATE / ALTER / DROP / INSERT / UPDATE / DELETE / TRUNCATE。
-- 不得 GRANT / REVOKE / CREATE POLICY。
-- 不得 DO block 寫入、不得製造測試資料。
-- 最後一個 statement 必須是 scoreboard SELECT。
-- row count 僅 INFO（本段不列入 PASS/FAIL）。
-- ============================================================

WITH used_tables AS (
  SELECT * FROM (
    VALUES
      ('used_valuation_cases'),
      ('used_valuation_components'),
      ('used_market_batches'),
      ('used_market_prices'),
      ('used_valuation_rule_versions'),
      ('used_valuation_results'),
      ('used_valuation_decisions'),
      ('used_valuation_audit_logs')
  ) AS t(table_name)
),
deferred_tables AS (
  SELECT * FROM (
    VALUES
      ('used_acquisition_links'),
      ('used_resale_links'),
      ('used_valuation_external_links')
  ) AS t(table_name)
),
trigger_functions AS (
  SELECT * FROM (
    VALUES
      ('used_valuation_set_updated_at'),
      ('used_valuation_audit_immutable'),
      ('used_valuation_results_immutable'),
      ('used_valuation_decisions_immutable')
  ) AS t(proname)
),
backoffice_tables AS (
  SELECT * FROM (
    VALUES
      ('used_valuation_cases'),
      ('used_valuation_components'),
      ('used_valuation_results'),
      ('used_valuation_decisions')
  ) AS t(table_name)
),
admin_tables AS (
  SELECT * FROM (
    VALUES
      ('used_market_batches'),
      ('used_market_prices'),
      ('used_valuation_rule_versions'),
      ('used_valuation_audit_logs')
  ) AS t(table_name)
),
core_present AS (
  SELECT COUNT(*)::int AS n
  FROM used_tables t
  WHERE to_regclass('public.' || t.table_name) IS NOT NULL
),
deferred_present AS (
  SELECT COUNT(*)::int AS n
  FROM deferred_tables t
  WHERE to_regclass('public.' || t.table_name) IS NOT NULL
),
external_links_present AS (
  SELECT CASE
           WHEN to_regclass('public.used_valuation_external_links') IS NULL THEN 0
           ELSE 1
         END AS n
),
rls_on AS (
  SELECT COUNT(*)::int AS n
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN used_tables t ON t.table_name = c.relname
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity IS TRUE
),
existing_core AS (
  SELECT t.table_name
  FROM used_tables t
  WHERE to_regclass('public.' || t.table_name) IS NOT NULL
),
anon_select AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('anon', format('public.%I', t.table_name), 'SELECT')
),
anon_insert AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('anon', format('public.%I', t.table_name), 'INSERT')
),
anon_update AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('anon', format('public.%I', t.table_name), 'UPDATE')
),
anon_delete AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('anon', format('public.%I', t.table_name), 'DELETE')
),
auth_select AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'SELECT')
),
auth_insert AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'INSERT')
),
auth_update AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'UPDATE')
),
auth_delete AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'DELETE')
),
auth_truncate AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'TRUNCATE')
),
auth_references AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'REFERENCES')
),
auth_trigger AS (
  SELECT COUNT(*)::int AS n
  FROM existing_core t
  WHERE has_table_privilege('authenticated', format('public.%I', t.table_name), 'TRIGGER')
),
public_table_acl AS (
  SELECT
    c.relname AS table_name,
    acl.privilege_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN existing_core t ON t.table_name = c.relname
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) acl
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND acl.grantee = 0
),
public_select AS (
  SELECT COUNT(DISTINCT table_name)::int AS n
  FROM public_table_acl
  WHERE privilege_type = 'SELECT'
),
public_write AS (
  SELECT COUNT(*)::int AS n
  FROM public_table_acl
  WHERE privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
),
used_policies AS (
  SELECT
    p.tablename,
    p.policyname,
    p.cmd,
    p.roles,
    p.qual
  FROM pg_policies p
  JOIN used_tables t ON t.table_name = p.tablename
  WHERE p.schemaname = 'public'
),
select_policies AS (
  SELECT COUNT(*)::int AS n
  FROM used_policies
  WHERE cmd = 'SELECT'
),
write_policies AS (
  SELECT COUNT(*)::int AS n
  FROM used_policies
  WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
),
anon_policies AS (
  SELECT COUNT(*)::int AS n
  FROM used_policies p
  WHERE 'anon' = ANY (p.roles)
     OR 'public' = ANY (p.roles)
),
policy_roles_ok AS (
  SELECT COUNT(*)::int AS n
  FROM used_policies p
  WHERE cmd = 'SELECT'
    AND 'authenticated' = ANY (p.roles)
    AND NOT ('anon' = ANY (p.roles))
    AND NOT ('public' = ANY (p.roles))
),
backoffice_helpers AS (
  SELECT COUNT(DISTINCT p.tablename)::int AS n
  FROM used_policies p
  JOIN backoffice_tables b ON b.table_name = p.tablename
  WHERE p.cmd = 'SELECT'
    AND 'authenticated' = ANY (p.roles)
    AND p.qual ILIKE '%is_enabled_backoffice_user()%'
),
admin_helpers AS (
  SELECT COUNT(DISTINCT p.tablename)::int AS n
  FROM used_policies p
  JOIN admin_tables a ON a.table_name = p.tablename
  WHERE p.cmd = 'SELECT'
    AND 'authenticated' = ANY (p.roles)
    AND p.qual ILIKE '%is_admin()%'
    AND p.qual NOT ILIKE '%is_enabled_backoffice_user()%'
),
single_active_batches AS (
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
single_active_rules AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_valuation_rule_versions'
    AND i.indisunique
    AND i.indisvalid
    AND i.indpred IS NOT NULL
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%status%'
    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%ACTIVE%'
),
market_unique AS (
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
component_unique AS (
  SELECT COUNT(*)::int AS n
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'used_valuation_components'
    AND i.indisunique
    AND i.indisvalid
    AND pg_get_indexdef(i.indexrelid) ILIKE '%case_id%'
    AND pg_get_indexdef(i.indexrelid) ILIKE '%ordinal%'
),
check_on AS (
  SELECT
    cls.relname AS table_name,
    pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = cls.relnamespace
  WHERE n.nspname = 'public'
    AND con.contype = 'c'
),
unique_on AS (
  SELECT
    cls.relname AS table_name,
    COALESCE(pg_get_constraintdef(con.oid), '') AS def
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = cls.relnamespace
  WHERE n.nspname = 'public'
    AND con.contype IN ('u', 'p')
  UNION ALL
  SELECT
    t.relname AS table_name,
    pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND i.indisunique
    AND i.indisvalid
),
fk_rows AS (
  SELECT
    src.relname AS src_table,
    ndst.nspname AS dst_schema,
    dst.relname AS dst_table
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace nsrc ON nsrc.oid = src.relnamespace
  JOIN pg_class dst ON dst.oid = con.confrelid
  JOIN pg_namespace ndst ON ndst.oid = dst.relnamespace
  WHERE con.contype = 'f'
    AND nsrc.nspname = 'public'
    AND src.relname LIKE 'used_%'
),
external_fk AS (
  SELECT COUNT(*)::int AS n
  FROM fk_rows f
  WHERE NOT (
          (f.dst_schema = 'public' AND f.dst_table LIKE 'used_%')
          OR (f.dst_schema = 'public' AND f.dst_table = 'profiles')
        )
),
inventory_order_fk AS (
  SELECT COUNT(*)::int AS n
  FROM fk_rows f
  WHERE f.dst_schema = 'public'
    AND f.dst_table IN (
      'inventory',
      'inventory_items',
      'inventory_costs',
      'inventory_ledger',
      'orders',
      'order_items',
      'order_costs'
    )
),
results_fk AS (
  SELECT COUNT(DISTINCT f.dst_table)::int AS n
  FROM fk_rows f
  WHERE f.src_table = 'used_valuation_results'
    AND f.dst_schema = 'public'
    AND f.dst_table IN (
      'used_valuation_cases',
      'used_market_batches',
      'used_valuation_rule_versions'
    )
),
decisions_fk AS (
  SELECT COUNT(DISTINCT f.dst_table)::int AS n
  FROM fk_rows f
  WHERE f.src_table = 'used_valuation_decisions'
    AND f.dst_schema = 'public'
    AND f.dst_table IN (
      'used_valuation_cases',
      'used_valuation_results'
    )
),
append_only_trg AS (
  SELECT COUNT(DISTINCT c.relname)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public'
    AND NOT t.tgisinternal
    AND t.tgenabled IN ('O', 'A')
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 8) <> 0
    AND (t.tgtype & 16) <> 0
    AND (
      (c.relname = 'used_valuation_results'
       AND p.proname = 'used_valuation_results_immutable')
      OR (c.relname = 'used_valuation_decisions'
          AND p.proname = 'used_valuation_decisions_immutable')
      OR (c.relname = 'used_valuation_audit_logs'
          AND p.proname = 'used_valuation_audit_immutable')
    )
),
updated_at_trg AS (
  SELECT COUNT(DISTINCT c.relname)::int AS n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE ns.nspname = 'public'
    AND NOT t.tgisinternal
    AND t.tgenabled IN ('O', 'A')
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 16) <> 0
    AND p.proname = 'used_valuation_set_updated_at'
    AND c.relname IN ('used_valuation_cases', 'used_market_prices')
),
fn_oids AS (
  SELECT
    tf.proname,
    p.oid
  FROM trigger_functions tf
  JOIN pg_proc p ON p.proname = tf.proname AND p.pronargs = 0
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
fn_exist AS (
  SELECT COUNT(*)::int AS n FROM fn_oids
),
fn_exec_anon AS (
  SELECT COUNT(*)::int AS n
  FROM fn_oids f
  WHERE has_function_privilege('anon', f.oid, 'EXECUTE')
),
fn_exec_auth AS (
  SELECT COUNT(*)::int AS n
  FROM fn_oids f
  WHERE has_function_privilege('authenticated', f.oid, 'EXECUTE')
),
fn_exec_public AS (
  SELECT COUNT(DISTINCT f.oid)::int AS n
  FROM fn_oids f
  JOIN pg_proc p ON p.oid = f.oid
  CROSS JOIN LATERAL aclexplode(
    COALESCE(p.proacl, acldefault('f'::"char", p.proowner))
  ) acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
),
expected_tstz AS (
  SELECT * FROM (
    VALUES
      ('used_valuation_cases', 'created_at'),
      ('used_valuation_cases', 'updated_at'),
      ('used_valuation_components', 'created_at'),
      ('used_market_batches', 'created_at'),
      ('used_market_batches', 'published_at'),
      ('used_market_prices', 'created_at'),
      ('used_market_prices', 'updated_at'),
      ('used_valuation_rule_versions', 'created_at'),
      ('used_valuation_rule_versions', 'activated_at'),
      ('used_valuation_results', 'market_updated_at'),
      ('used_valuation_results', 'created_at'),
      ('used_valuation_decisions', 'created_at'),
      ('used_valuation_audit_logs', 'created_at')
  ) AS t(table_name, column_name)
),
ts_match AS (
  SELECT
    e.table_name,
    e.column_name,
    c.data_type
  FROM expected_tstz e
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = e.table_name
   AND c.column_name = e.column_name
),
ts_summary AS (
  SELECT
    COUNT(*)::int AS n_expected,
    COUNT(*) FILTER (WHERE data_type IS NOT NULL)::int AS n_present,
    COUNT(*) FILTER (
      WHERE data_type = 'timestamp with time zone'
    )::int AS n_ok,
    COUNT(*) FILTER (
      WHERE data_type IS NOT NULL
        AND data_type IS DISTINCT FROM 'timestamp with time zone'
    )::int AS n_bad
  FROM ts_match
),
expected_effective_dates AS (
  SELECT * FROM (
    VALUES
      ('used_market_batches', 'effective_date'),
      ('used_market_prices', 'effective_date')
  ) AS t(table_name, column_name)
),
effective_date_match AS (
  SELECT
    e.table_name,
    e.column_name,
    c.data_type
  FROM expected_effective_dates e
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public'
   AND c.table_name = e.table_name
   AND c.column_name = e.column_name
),
effective_date_ok AS (
  SELECT
    COUNT(*)::int AS n_total,
    COUNT(*) FILTER (WHERE data_type IS NOT NULL)::int AS n_present,
    COUNT(*) FILTER (WHERE data_type = 'date')::int AS n_date
  FROM effective_date_match
),
scoreboard AS (
  SELECT 1 AS seq, 'tables.core_count'::text AS check_name,
         (SELECT n::text FROM core_present) AS actual,
         '8'::text AS expected,
         CASE WHEN (SELECT n FROM core_present) = 8 THEN 'PASS' ELSE 'FAIL' END AS verdict
  UNION ALL SELECT 2, 'tables.deferred_absent',
         (SELECT n::text FROM deferred_present), '0',
         CASE WHEN (SELECT n FROM deferred_present) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 3, 'rls.enabled',
         (SELECT n::text FROM rls_on), '8',
         CASE WHEN (SELECT n FROM rls_on) = 8 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 4, 'anon.select',
         (SELECT n::text FROM anon_select), '0',
         CASE WHEN (SELECT n FROM anon_select) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 5, 'anon.insert',
         (SELECT n::text FROM anon_insert), '0',
         CASE WHEN (SELECT n FROM anon_insert) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 6, 'anon.update',
         (SELECT n::text FROM anon_update), '0',
         CASE WHEN (SELECT n FROM anon_update) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 7, 'anon.delete',
         (SELECT n::text FROM anon_delete), '0',
         CASE WHEN (SELECT n FROM anon_delete) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 8, 'authenticated.select',
         (SELECT n::text FROM auth_select), '8',
         CASE WHEN (SELECT n FROM auth_select) = 8 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 9, 'authenticated.insert',
         (SELECT n::text FROM auth_insert), '0',
         CASE WHEN (SELECT n FROM auth_insert) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 10, 'authenticated.update',
         (SELECT n::text FROM auth_update), '0',
         CASE WHEN (SELECT n FROM auth_update) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 11, 'authenticated.delete',
         (SELECT n::text FROM auth_delete), '0',
         CASE WHEN (SELECT n FROM auth_delete) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 12, 'policies.total_select',
         (SELECT n::text FROM select_policies), '8',
         CASE WHEN (SELECT n FROM select_policies) = 8 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 13, 'policies.backoffice_helpers',
         (SELECT n::text FROM backoffice_helpers), '4',
         CASE WHEN (SELECT n FROM backoffice_helpers) = 4 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 14, 'policies.admin_helpers',
         (SELECT n::text FROM admin_helpers), '4',
         CASE WHEN (SELECT n FROM admin_helpers) = 4 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 15, 'policies.write_none',
         (SELECT n::text FROM write_policies), '0',
         CASE WHEN (SELECT n FROM write_policies) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 16, 'market_batches.single_active',
         (SELECT n::text FROM single_active_batches), '1',
         CASE WHEN (SELECT n FROM single_active_batches) >= 1 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 17, 'rule_versions.single_active',
         (SELECT n::text FROM single_active_rules), '1',
         CASE WHEN (SELECT n FROM single_active_rules) >= 1 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 18, 'market_prices.batch_model_unique',
         (SELECT n::text FROM market_unique), '1',
         CASE WHEN (SELECT n FROM market_unique) >= 1 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 19, 'components.case_ordinal_unique',
         (SELECT n::text FROM component_unique), '1',
         CASE WHEN (SELECT n FROM component_unique) >= 1 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 20, 'results.acquisition_bounds',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%recommended_acquisition%'
             AND def ILIKE '%maximum_acquisition%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%recommended_acquisition%'
             AND def ILIKE '%maximum_acquisition%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 21, 'timestamps.use_timestamptz',
         ((SELECT n_ok::text FROM ts_summary)
          || '/' ||
          (SELECT n_expected::text FROM ts_summary)
          || '; bad=' ||
          (SELECT n_bad::text FROM ts_summary)),
         '13/13; bad=0',
         CASE WHEN (SELECT n_expected FROM ts_summary) = 13
               AND (SELECT n_present FROM ts_summary) = 13
               AND (SELECT n_ok FROM ts_summary) = 13
               AND (SELECT n_bad FROM ts_summary) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 22, 'fk.no_inventory_orders',
         (SELECT n::text FROM inventory_order_fk), '0',
         CASE WHEN (SELECT n FROM inventory_order_fk) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 23, 'triggers.append_only',
         (SELECT n::text FROM append_only_trg), '3',
         CASE WHEN (SELECT n FROM append_only_trg) = 3 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 24, 'triggers.updated_at',
         (SELECT n::text FROM updated_at_trg), '2',
         CASE WHEN (SELECT n FROM updated_at_trg) = 2 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 25, 'function_execute.anon',
         (SELECT n::text FROM fn_exec_anon), '0',
         CASE WHEN (SELECT n FROM fn_exist) = 4
               AND (SELECT n FROM fn_exec_anon) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 26, 'function_execute.authenticated',
         (SELECT n::text FROM fn_exec_auth), '0',
         CASE WHEN (SELECT n FROM fn_exist) = 4
               AND (SELECT n FROM fn_exec_auth) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 27, 'function_execute.public',
         (SELECT n::text FROM fn_exec_public), '0',
         CASE WHEN (SELECT n FROM fn_exist) = 4
               AND (SELECT n FROM fn_exec_public) = 0
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 28, 'deferred.external_links_absent',
         (SELECT n::text FROM external_links_present), '0',
         CASE WHEN (SELECT n FROM external_links_present) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 29, 'public.select',
         (SELECT n::text FROM public_select), '0',
         CASE WHEN (SELECT n FROM public_select) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 30, 'public.write',
         (SELECT n::text FROM public_write), '0',
         CASE WHEN (SELECT n FROM public_write) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 31, 'authenticated.truncate',
         (SELECT n::text FROM auth_truncate), '0',
         CASE WHEN (SELECT n FROM auth_truncate) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 32, 'authenticated.references',
         (SELECT n::text FROM auth_references), '0',
         CASE WHEN (SELECT n FROM auth_references) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 33, 'authenticated.trigger',
         (SELECT n::text FROM auth_trigger), '0',
         CASE WHEN (SELECT n FROM auth_trigger) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 34, 'policies.role_authenticated',
         (SELECT n::text FROM policy_roles_ok), '8',
         CASE WHEN (SELECT n FROM policy_roles_ok) = 8 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 35, 'policies.anon_none',
         (SELECT n::text FROM anon_policies), '0',
         CASE WHEN (SELECT n FROM anon_policies) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 36, 'functions.exist',
         (SELECT n::text FROM fn_exist), '4',
         CASE WHEN (SELECT n FROM fn_exist) = 4 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 37, 'cases.public_code_unique',
         EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_valuation_cases'
             AND def ILIKE '%public_code%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_valuation_cases'
             AND def ILIKE '%public_code%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 38, 'cases.status_check',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_cases'
             AND def ILIKE '%status%'
             AND def ILIKE '%ESTIMATED%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_cases'
             AND def ILIKE '%status%'
             AND def ILIKE '%ESTIMATED%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 39, 'components.component_type_check',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_components'
             AND def ILIKE '%component_type%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_components'
             AND def ILIKE '%component_type%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 40, 'market_batches.batch_code_unique',
         EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_market_batches'
             AND def ILIKE '%batch_code%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_market_batches'
             AND def ILIKE '%batch_code%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 41, 'market_batches.status_check',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_market_batches'
             AND def ILIKE '%status%'
             AND def ILIKE '%ACTIVE%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_market_batches'
             AND def ILIKE '%status%'
             AND def ILIKE '%ACTIVE%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 42, 'market_prices.range_constraints',
         (
           EXISTS (
             SELECT 1 FROM check_on
             WHERE table_name = 'used_market_prices'
               AND def ILIKE '%market_low%'
           )
           AND EXISTS (
             SELECT 1 FROM check_on
             WHERE table_name = 'used_market_prices'
               AND def ILIKE '%market_mid%'
               AND def ILIKE '%market_low%'
           )
           AND EXISTS (
             SELECT 1 FROM check_on
             WHERE table_name = 'used_market_prices'
               AND def ILIKE '%market_high%'
               AND def ILIKE '%market_mid%'
           )
         )::text, 'true',
         CASE WHEN EXISTS (
                SELECT 1 FROM check_on
                WHERE table_name = 'used_market_prices'
                  AND def ILIKE '%market_low%'
              )
              AND EXISTS (
                SELECT 1 FROM check_on
                WHERE table_name = 'used_market_prices'
                  AND def ILIKE '%market_mid%'
                  AND def ILIKE '%market_low%'
              )
              AND EXISTS (
                SELECT 1 FROM check_on
                WHERE table_name = 'used_market_prices'
                  AND def ILIKE '%market_high%'
                  AND def ILIKE '%market_mid%'
              )
              THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 43, 'market_prices.confidence',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_market_prices'
             AND def ILIKE '%confidence%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_market_prices'
             AND def ILIKE '%confidence%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 44, 'rule_versions.version_code_unique',
         EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_valuation_rule_versions'
             AND def ILIKE '%version_code%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM unique_on
           WHERE table_name = 'used_valuation_rule_versions'
             AND def ILIKE '%version_code%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 45, 'rule_versions.status_check',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_rule_versions'
             AND def ILIKE '%status%'
             AND def ILIKE '%ACTIVE%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_rule_versions'
             AND def ILIKE '%status%'
             AND def ILIKE '%ACTIVE%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 46, 'results.value_score_bounds',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%value_score%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%value_score%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 47, 'results.market_ordering',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%market_low%'
             AND def ILIKE '%market_mid%'
             AND def ILIKE '%market_high%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_results'
             AND def ILIKE '%market_low%'
             AND def ILIKE '%market_mid%'
             AND def ILIKE '%market_high%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 48, 'results.fk_case_batch_rule',
         (SELECT n::text FROM results_fk), '3',
         CASE WHEN (SELECT n FROM results_fk) = 3 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 49, 'decisions.system_acquisition_bounds',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_decisions'
             AND def ILIKE '%system_recommended_acquisition%'
             AND def ILIKE '%system_maximum_acquisition%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_decisions'
             AND def ILIKE '%system_recommended_acquisition%'
             AND def ILIKE '%system_maximum_acquisition%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 50, 'decisions.final_offer',
         EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_decisions'
             AND def ILIKE '%final_offer%'
         )::text, 'true',
         CASE WHEN EXISTS (
           SELECT 1 FROM check_on
           WHERE table_name = 'used_valuation_decisions'
             AND def ILIKE '%final_offer%'
         ) THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 51, 'decisions.fk_case_result',
         (SELECT n::text FROM decisions_fk), '2',
         CASE WHEN (SELECT n FROM decisions_fk) = 2 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 52, 'foreign_keys.external_business_domains',
         (SELECT n::text FROM external_fk), '0',
         CASE WHEN (SELECT n FROM external_fk) = 0 THEN 'PASS' ELSE 'FAIL' END
  UNION ALL SELECT 53, 'timestamps.effective_date_is_date',
         ((SELECT n_date FROM effective_date_ok)::text
          || '/' ||
          (SELECT n_total FROM effective_date_ok)::text),
         '2/2',
         CASE WHEN (SELECT n_total FROM effective_date_ok) = 2
               AND (SELECT n_present FROM effective_date_ok) = 2
               AND (SELECT n_date FROM effective_date_ok) = 2
              THEN 'PASS' ELSE 'FAIL' END
)
SELECT seq, check_name, actual, expected, verdict
FROM scoreboard
ORDER BY seq;

-- M2_VERIFY END
