-- Isolated research tables only. No reads/writes to orders, stock or operational data.
-- Disabled until billing, secrets and provider prices have been verified.
begin;
create table if not exists public.builder_research_config (
 id boolean primary key default true check(id), enabled boolean not null default false,
 billing_confirmed boolean not null default false,
 monthly_limit_milli integer not null default 2000000 check(monthly_limit_milli between 0 and 2000000),
 fixed_cost_milli integer not null default 1000000 check(fixed_cost_milli>=0),
 buffer_milli integer not null default 200000 check(buffer_milli>=0),
 reserve_per_lookup_milli integer not null default 10000 check(reserve_per_lookup_milli>=10000),
 check(fixed_cost_milli+buffer_milli<=monthly_limit_milli)
);
insert into public.builder_research_config(id) values(true) on conflict do nothing;
create table if not exists public.builder_research_months (
 month text primary key, reserved_milli integer not null default 0 check(reserved_milli>=0)
);
create table if not exists public.builder_research_cache (
 cache_key text primary key, query text not null, kind text not null check(kind in ('game','software')),
 payload jsonb not null, checked_at timestamptz not null default now(), expires_at timestamptz not null
);
create table if not exists public.builder_research_requests (
 id uuid primary key default gen_random_uuid(), month text not null, cache_key text not null,
 client_hash text not null, reserved_milli integer not null check(reserved_milli>0),
 state text not null default 'reserved' check(state in ('reserved','completed','failed')),
 created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists builder_research_requests_client_time on public.builder_research_requests(client_hash,created_at);
create index if not exists builder_research_requests_key_time on public.builder_research_requests(cache_key,created_at);
create table if not exists public.builder_research_runs (
 id bigint generated always as identity primary key, kind text not null, count integer not null, status text not null,
 created_at timestamptz not null default now()
);
alter table public.builder_research_config enable row level security;
alter table public.builder_research_months enable row level security;
alter table public.builder_research_cache enable row level security;
alter table public.builder_research_requests enable row level security;
alter table public.builder_research_runs enable row level security;
revoke all on public.builder_research_config,public.builder_research_months,public.builder_research_cache,public.builder_research_requests,public.builder_research_runs from public,anon,authenticated;
grant all on public.builder_research_config,public.builder_research_months,public.builder_research_cache,public.builder_research_requests,public.builder_research_runs to service_role;
grant usage, select on sequence public.builder_research_runs_id_seq to service_role;

create or replace function public.builder_reserve_research(p_key text,p_client text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.builder_research_config; m text:=to_char(now() at time zone 'Asia/Taipei','YYYY-MM'); spent integer; rid uuid;
begin
 -- One locked configuration row serializes all quota checks, including same-key requests.
 select * into c from public.builder_research_config where id=true for update;
 if not found or not c.enabled or not c.billing_confirmed then return jsonb_build_object('allowed',false,'reason','not_enabled');end if;
 if p_key is null or length(p_key)<7 or length(p_key)>110 or p_key !~ '^(game|software):' or p_client is null or length(p_client)>128 then return jsonb_build_object('allowed',false,'reason','invalid');end if;
 if exists(select 1 from public.builder_research_requests where cache_key=p_key and created_at>now()-interval '1 minute') then return jsonb_build_object('allowed',false,'reason','busy');end if;
 if (select count(*) from public.builder_research_requests where client_hash=p_client and created_at>now()-interval '1 day') >= (case when p_client='cron' then 3 else 5 end) then return jsonb_build_object('allowed',false,'reason','rate_limited');end if;
 if (select count(*) from public.builder_research_requests where created_at>now()-interval '1 hour')>=12 then return jsonb_build_object('allowed',false,'reason','rate_limited');end if;
 insert into public.builder_research_months(month) values(m) on conflict do nothing;
 select reserved_milli into spent from public.builder_research_months where month=m for update;
 if spent+c.reserve_per_lookup_milli+c.fixed_cost_milli+c.buffer_milli>c.monthly_limit_milli then return jsonb_build_object('allowed',false,'reason','budget_limit');end if;
 update public.builder_research_months set reserved_milli=reserved_milli+c.reserve_per_lookup_milli where month=m;
 insert into public.builder_research_requests(month,cache_key,client_hash,reserved_milli) values(m,p_key,p_client,c.reserve_per_lookup_milli) returning id into rid;
 return jsonb_build_object('allowed',true,'id',rid);
end;$$;

create or replace function public.builder_finish_research(p_id uuid,p_payload jsonb,p_success boolean) returns boolean
language plpgsql security invoker set search_path='' as $$
declare r public.builder_research_requests;
begin
 select * into r from public.builder_research_requests where id=p_id for update;
 if not found or r.state<>'reserved' then return false;end if;
 if p_success and (p_payload is null or jsonb_typeof(p_payload->'candidates') is distinct from 'array' or length(p_payload::text)>40000) then raise exception 'invalid research payload';end if;
 update public.builder_research_requests set state=case when p_success then 'completed' else 'failed' end,finished_at=now() where id=p_id;
 if p_success then
  insert into public.builder_research_cache(cache_key,query,kind,payload,checked_at,expires_at)
  values(r.cache_key,substring(r.cache_key from position(':' in r.cache_key)+1),split_part(r.cache_key,':',1),p_payload,now(),now()+case when exists(select 1 from jsonb_array_elements(p_payload->'candidates') item where jsonb_typeof(item->'profile')='object') then interval '7 days' else interval '1 day' end)
  on conflict(cache_key) do update set payload=excluded.payload,checked_at=excluded.checked_at,expires_at=excluded.expires_at;
 end if;
 return true;
end;$$;

create or replace function public.builder_research_usage() returns jsonb
language sql security invoker set search_path='' as $$
 select jsonb_build_object('month',to_char(now() at time zone 'Asia/Taipei','YYYY-MM'),'limitTwd',c.monthly_limit_milli/1000.0,'fixedReserveTwd',c.fixed_cost_milli/1000.0,'bufferTwd',c.buffer_milli/1000.0,'lookupReserveTwd',coalesce(m.reserved_milli,0)/1000.0,'remainingTwd',greatest(0,c.monthly_limit_milli-c.fixed_cost_milli-c.buffer_milli-coalesce(m.reserved_milli,0))/1000.0,'warning',coalesce(m.reserved_milli,0)>=0.8*(c.monthly_limit_milli-c.fixed_cost_milli-c.buffer_milli),'enabled',c.enabled and c.billing_confirmed,'schedulerPrerequisitesReady',(select count(*)=2 from pg_extension where extname in ('pg_cron','pg_net')),'accounting','conservative reservations; not provider invoice')
 from public.builder_research_config c left join public.builder_research_months m on m.month=to_char(now() at time zone 'Asia/Taipei','YYYY-MM') where c.id=true;
$$;
revoke all on function public.builder_reserve_research(text,text),public.builder_finish_research(uuid,jsonb,boolean),public.builder_research_usage() from public,anon,authenticated;
grant execute on function public.builder_reserve_research(text,text),public.builder_finish_research(uuid,jsonb,boolean),public.builder_research_usage() to service_role;
commit;
