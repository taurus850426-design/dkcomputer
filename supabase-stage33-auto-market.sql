-- DK電競電腦｜Stage 33 自動行情蒐集 MVP
-- 先執行本檔，再部署 used-market-collector Edge Function。
-- 自動結果只進候選區，不會直接修改正式 used_market_prices。

create table if not exists public.used_market_watchlist (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  brand text not null default '',
  model text not null,
  variant text not null default '',
  search_query text not null,
  min_price numeric(14,2) not null default 100,
  max_price numeric(14,2) not null default 300000,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(category, brand, model, variant)
);

create table if not exists public.used_market_observations (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.used_market_watchlist(id) on delete cascade,
  provider text not null,
  source_name text not null default '',
  title text not null,
  price numeric(14,2) not null,
  currency text not null default 'TWD',
  item_url text not null,
  condition_label text not null default '',
  accepted boolean not null default false,
  reject_reason text not null default '',
  collected_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb,
  unique(watchlist_id, provider, item_url, collected_at)
);

create index if not exists used_market_obs_watch_time_idx
  on public.used_market_observations(watchlist_id, collected_at desc);

alter table public.used_market_watchlist enable row level security;
alter table public.used_market_observations enable row level security;
revoke all on public.used_market_watchlist, public.used_market_observations from anon, authenticated;
grant select on public.used_market_watchlist, public.used_market_observations to authenticated;

drop policy if exists used_market_watchlist_admin_read on public.used_market_watchlist;
create policy used_market_watchlist_admin_read on public.used_market_watchlist
  for select to authenticated using (public.is_admin());
drop policy if exists used_market_observations_admin_read on public.used_market_observations;
create policy used_market_observations_admin_read on public.used_market_observations
  for select to authenticated using (public.is_admin());

insert into public.used_market_watchlist(category, brand, model, variant, search_query, min_price, max_price)
values
 ('GPU','NVIDIA','RTX 2060','6GB','RTX 2060 6GB 二手 顯示卡',1500,9000),
 ('GPU','NVIDIA','RTX 3060','12GB','RTX 3060 12GB 二手 顯示卡',2500,12000),
 ('GPU','NVIDIA','RTX 3060 Ti','8GB','RTX 3060 Ti 8GB 二手 顯示卡',3000,15000),
 ('GPU','NVIDIA','RTX 3070','8GB','RTX 3070 8GB 二手 顯示卡',3500,18000),
 ('GPU','NVIDIA','RTX 4060','8GB','RTX 4060 8GB 二手 顯示卡',4500,16000),
 ('GPU','NVIDIA','RTX 4060 Ti','8GB','RTX 4060 Ti 8GB 二手 顯示卡',6000,22000),
 ('GPU','AMD','RX 6600','8GB','RX 6600 8GB 二手 顯示卡',2000,10000),
 ('GPU','AMD','RX 6700 XT','12GB','RX 6700 XT 12GB 二手 顯示卡',3500,16000),
 ('CPU','Intel','i5-10400F','','Intel i5-10400F 二手 CPU',800,5000),
 ('CPU','Intel','i5-11400F','','Intel i5-11400F 二手 CPU',1000,6000),
 ('CPU','Intel','i5-12400F','','Intel i5-12400F 二手 CPU',1500,8000),
 ('CPU','Intel','i5-13400F','','Intel i5-13400F 二手 CPU',2500,12000),
 ('CPU','Intel','i7-10700','','Intel i7-10700 二手 CPU',1500,9000),
 ('CPU','Intel','i7-11700','','Intel i7-11700 二手 CPU',1800,10000),
 ('CPU','AMD','Ryzen 5 3600','','AMD Ryzen 5 3600 二手 CPU',800,5000),
 ('CPU','AMD','Ryzen 5 5600','','AMD Ryzen 5 5600 二手 CPU',1200,7000),
 ('CPU','AMD','Ryzen 5 5600X','','AMD Ryzen 5 5600X 二手 CPU',1500,8000),
 ('CPU','AMD','Ryzen 7 5700X','','AMD Ryzen 7 5700X 二手 CPU',2000,10000),
 ('CPU','AMD','Ryzen 5 7600','','AMD Ryzen 5 7600 二手 CPU',2500,12000),
 ('CPU','AMD','Ryzen 7 7700','','AMD Ryzen 7 7700 二手 CPU',3500,16000)
on conflict(category, brand, model, variant) do update set
  search_query=excluded.search_query,
  min_price=excluded.min_price,
  max_price=excluded.max_price,
  updated_at=now();

create or replace view public.used_market_candidate_summary
with (security_invoker = true) as
select
  w.id as watchlist_id, w.category, w.brand, w.model, w.variant, w.search_query,
  count(o.id) filter (where o.accepted) as accepted_count,
  count(o.id) filter (where not o.accepted) as rejected_count,
  percentile_cont(0.25) within group (order by o.price) filter (where o.accepted) as market_low,
  percentile_cont(0.50) within group (order by o.price) filter (where o.accepted) as market_mid,
  percentile_cont(0.75) within group (order by o.price) filter (where o.accepted) as market_high,
  max(o.collected_at) as last_collected_at
from public.used_market_watchlist w
left join public.used_market_observations o
  on o.watchlist_id=w.id and o.collected_at >= now() - interval '30 days'
where w.enabled
group by w.id;

revoke all on public.used_market_candidate_summary from anon;
grant select on public.used_market_candidate_summary to authenticated;
