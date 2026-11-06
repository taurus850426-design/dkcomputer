-- DK barcode / serial foundations. NOT applied to production.
-- Apply only after staging validation. All changes are additive.
begin;
create table if not exists public.inventory_barcodes (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references public.inventory_items(id) on delete restrict,
  barcode text not null,
  barcode_type text not null default 'internal' check (barcode_type in ('internal','ean13','upca','code128','code39','other')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint inventory_barcodes_nonempty check (length(btrim(barcode)) > 0),
  constraint inventory_barcodes_unique_code unique(barcode)
);
create index if not exists inventory_barcodes_item_idx on public.inventory_barcodes(item_id);
create table if not exists public.inventory_serials (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references public.inventory_items(id) on delete restrict,
  manufacturer text not null default '',
  serial_number text not null,
  serial_normalized text generated always as (upper(btrim(serial_number))) stored,
  status text not null default 'received' check(status in ('received','reserved','sold','returned','void')),
  inbound_ledger_id text references public.inventory_ledger(id) on delete restrict,
  outbound_ledger_id text references public.inventory_ledger(id) on delete restrict,
  order_id text references public.orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_serials_nonempty check(length(btrim(serial_number)) > 0),
  constraint inventory_serials_unique_serial unique(manufacturer,serial_normalized)
);
create index if not exists inventory_serials_item_status_idx on public.inventory_serials(item_id,status);
create index if not exists inventory_serials_order_idx on public.inventory_serials(order_id);
create table if not exists public.inventory_scan_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('receive','ship','count','adjust')),
  status text not null default 'draft' check(status in ('draft','committed','cancelled')),
  source_type text,
  source_id text,
  idempotency_key uuid not null unique default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);
create table if not exists public.inventory_serial_events (
  id bigint generated always as identity primary key,
  serial_id uuid not null references public.inventory_serials(id) on delete restrict,
  event_type text not null check(event_type in ('receive','reserve','ship','return','correct','void')),
  scan_batch_id uuid references public.inventory_scan_batches(id) on delete restrict,
  order_id text references public.orders(id) on delete restrict,
  ledger_id text references public.inventory_ledger(id) on delete restrict,
  detail jsonb not null default '{}'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists inventory_serial_events_serial_idx on public.inventory_serial_events(serial_id,created_at);
alter table public.inventory_barcodes enable row level security;
alter table public.inventory_serials enable row level security;
alter table public.inventory_scan_batches enable row level security;
alter table public.inventory_serial_events enable row level security;
-- Deliberately no permissive direct table policies: add tightly scoped
-- SECURITY DEFINER RPCs after existing backoffice role checks are audited.
-- No inventory quantity changes in this migration.
commit;
