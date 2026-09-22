-- DK Computer Stage 24｜訂單客戶來源持久化
-- 使用 orders.extra.customer_source，不新增或修改資料表欄位。
-- 可安全重複執行；不改寫既有訂單，舊訂單由前端顯示為「未填寫」。

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'Stage 24 preflight failed: public.orders is missing';
  END IF;
  IF to_regprocedure('public.dk_require_backoffice()') IS NULL THEN
    RAISE EXCEPTION 'Stage 24 preflight failed: dk_require_backoffice() is missing';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.backoffice_set_order_customer_source(
  p_order_id TEXT,
  p_customer_source TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source TEXT := pg_catalog.btrim(COALESCE(p_customer_source, ''));
BEGIN
  PERFORM public.dk_require_backoffice();

  IF COALESCE(p_order_id, '') = '' THEN
    RAISE EXCEPTION 'order_id required';
  END IF;
  IF v_source = '' THEN
    RAISE EXCEPTION 'customer_source required';
  END IF;

  UPDATE public.orders
  SET extra = pg_catalog.jsonb_set(
        COALESCE(extra, '{}'::jsonb),
        '{customer_source}',
        pg_catalog.to_jsonb(v_source),
        true
      ),
      updated_at = pg_catalog.now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_order_id, 'customer_source', v_source);
END;
$$;

REVOKE ALL ON FUNCTION public.backoffice_set_order_customer_source(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backoffice_set_order_customer_source(TEXT, TEXT)
  TO authenticated;

COMMIT;

SELECT
  to_regprocedure('public.backoffice_set_order_customer_source(text,text)') IS NOT NULL AS stage24_ready;
