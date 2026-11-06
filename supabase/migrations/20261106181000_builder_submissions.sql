-- Stage 37: public builder submissions -> backoffice review queue
-- Safe migration: additive only. Does not modify orders/inventory/purchase data.
BEGIN;

CREATE TABLE IF NOT EXISTS public.builder_submissions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  build_no TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','converted','cancelled')),
  converted_order_id TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS builder_submissions_created_idx
  ON public.builder_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS builder_submissions_status_idx
  ON public.builder_submissions(status, created_at DESC);

ALTER TABLE public.builder_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.builder_submissions FROM PUBLIC, anon, authenticated;

-- Public visitors may submit, but can never list/read/update submissions.
GRANT INSERT ON TABLE public.builder_submissions TO anon;
DROP POLICY IF EXISTS builder_submissions_public_insert ON public.builder_submissions;
CREATE POLICY builder_submissions_public_insert ON public.builder_submissions
  FOR INSERT TO anon
  WITH CHECK (
    status = 'new'
    AND converted_order_id IS NULL
    AND pg_catalog.jsonb_typeof(payload) = 'object'
    AND pg_catalog.length(payload::text) <= 50000
    AND COALESCE(payload->>'website','') = ''
  );

-- Backoffice access is authenticated and still gated by existing role function.
GRANT SELECT, UPDATE ON TABLE public.builder_submissions TO authenticated;
DROP POLICY IF EXISTS builder_submissions_backoffice_select ON public.builder_submissions;
CREATE POLICY builder_submissions_backoffice_select ON public.builder_submissions
  FOR SELECT TO authenticated
  USING (public.dk_require_backoffice() IN ('admin','staff'));
DROP POLICY IF EXISTS builder_submissions_backoffice_update ON public.builder_submissions;
CREATE POLICY builder_submissions_backoffice_update ON public.builder_submissions
  FOR UPDATE TO authenticated
  USING (public.dk_require_backoffice() IN ('admin','staff'))
  WITH CHECK (public.dk_require_backoffice() IN ('admin','staff'));

CREATE OR REPLACE FUNCTION public.backoffice_list_builder_submissions(p_limit INTEGER DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_rows JSONB;
BEGIN
  PERFORM public.dk_require_backoffice();
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',s.id,'build_no',s.build_no,'payload',s.payload,'status',s.status,
    'converted_order_id',s.converted_order_id,'created_at',s.created_at,'updated_at',s.updated_at
  ) ORDER BY s.created_at DESC),'[]'::jsonb)
  INTO v_rows
  FROM (SELECT * FROM public.builder_submissions ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),500)) s;
  RETURN pg_catalog.jsonb_build_object('ok',true,'submissions',v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.backoffice_set_builder_submission_status(
  p_id UUID, p_status TEXT, p_converted_order_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  PERFORM public.dk_require_backoffice();
  IF p_status NOT IN ('new','reviewing','converted','cancelled') THEN RAISE EXCEPTION 'invalid builder submission status'; END IF;
  IF p_status='converted' AND COALESCE(NULLIF(p_converted_order_id,''),'')='' THEN RAISE EXCEPTION 'converted order id required'; END IF;
  IF p_status<>'converted' AND p_converted_order_id IS NOT NULL THEN RAISE EXCEPTION 'order id only allowed for converted status'; END IF;
  UPDATE public.builder_submissions
  SET status=p_status, converted_order_id=CASE WHEN p_status='converted' THEN p_converted_order_id ELSE NULL END,
      updated_at=pg_catalog.now()
  WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'builder submission not found'; END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'id',p_id,'status',p_status,'converted_order_id',p_converted_order_id);
END $$;

REVOKE ALL ON FUNCTION public.backoffice_list_builder_submissions(INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.backoffice_set_builder_submission_status(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_list_builder_submissions(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_builder_submission_status(UUID,TEXT,TEXT) TO authenticated;

COMMIT;

SELECT
  to_regclass('public.builder_submissions') IS NOT NULL AS builder_submissions_ready,
  to_regprocedure('public.backoffice_list_builder_submissions(integer)') IS NOT NULL AS builder_list_ready,
  to_regprocedure('public.backoffice_set_builder_submission_status(uuid,text,text)') IS NOT NULL AS builder_status_ready;
