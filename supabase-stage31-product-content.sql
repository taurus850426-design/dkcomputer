-- Stage 31：前台商品結構化內容欄位
-- 執行位置：Supabase Dashboard → SQL Editor → New query → Run

BEGIN;

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS cpu TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS gpu TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS ram TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS ssd TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS highlight TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS suitable_use TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS warranty_info TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS delivery_info TEXT DEFAULT '';

UPDATE public.inventory
SET
  cpu = COALESCE(cpu, ''),
  gpu = COALESCE(gpu, ''),
  ram = COALESCE(ram, ''),
  ssd = COALESCE(ssd, ''),
  highlight = COALESCE(highlight, ''),
  suitable_use = COALESCE(suitable_use, ''),
  warranty_info = COALESCE(warranty_info, ''),
  delivery_info = COALESCE(delivery_info, '');

COMMIT;
