-- Apply after Stage 33/34 and used-valuation Stage 03. Safe to rerun.
begin;
create table if not exists public.used_market_reviews (
  observation_id uuid primary key references public.used_market_observations(id),
  region text not null check (region in ('TW','OVERSEAS','UNKNOWN')),
  approved boolean not null,
  confirmed_price numeric(14,2),
  evidence_note text not null,
  reviewed_by uuid not null,
  reviewed_at timestamptz not null default now(),
  check (not approved or (region <> 'UNKNOWN' and confirmed_price > 0 and confirmed_price < 1000000))
);
alter table public.used_market_reviews enable row level security;
revoke all on public.used_market_reviews from public, anon, authenticated;
grant select on public.used_market_reviews to authenticated;
drop policy if exists used_market_reviews_admin_read on public.used_market_reviews;
create policy used_market_reviews_admin_read on public.used_market_reviews
  for select to authenticated using (public.is_admin());

create or replace view public.used_market_review_candidates with (security_invoker=true) as
select o.*, r.region, r.approved, r.confirmed_price, r.evidence_note, r.reviewed_at,
  case when r.region is not null then r.region
       when lower(o.source_name) ~ 'ebay|banzaihobby' then 'OVERSEAS'
       else 'UNKNOWN' end as source_region
from (
  select distinct on (watchlist_id, provider, item_url) *
  from public.used_market_observations
  where raw_data->>'rules_version' = '2' and collected_at >= now() - interval '30 days'
  order by watchlist_id, provider, item_url, collected_at desc, id desc
) o
left join public.used_market_reviews r on r.observation_id=o.id;

create or replace view public.used_market_review_summary with (security_invoker=true) as
select w.id as watchlist_id, w.category,w.brand,w.model,w.variant,w.search_query,
  count(o.id) filter(where o.approved and o.region='TW' and o.accepted) as accepted_count,
  count(o.id) filter(where o.source_region='OVERSEAS') as overseas_count,
  count(o.id) filter(where o.approved is null and o.accepted and o.source_region<>'OVERSEAS') as pending_count,
  count(o.id) filter(where not o.accepted or o.approved=false) as rejected_count,
  case when count(o.id) filter(where o.approved and o.region='TW' and o.accepted)>=3 then
    percentile_cont(0.25) within group(order by o.confirmed_price) filter(where o.approved and o.region='TW' and o.accepted) end as market_low,
  case when count(o.id) filter(where o.approved and o.region='TW' and o.accepted)>=3 then
    percentile_cont(0.5) within group(order by o.confirmed_price) filter(where o.approved and o.region='TW' and o.accepted) end as market_mid,
  case when count(o.id) filter(where o.approved and o.region='TW' and o.accepted)>=3 then
    percentile_cont(0.75) within group(order by o.confirmed_price) filter(where o.approved and o.region='TW' and o.accepted) end as market_high,
  max(o.collected_at) as last_collected_at
from public.used_market_watchlist w
left join public.used_market_review_candidates o on o.watchlist_id=w.id
where w.enabled group by w.id;

revoke all on public.used_market_review_candidates, public.used_market_review_summary from public, anon, authenticated;
grant select on public.used_market_review_candidates, public.used_market_review_summary to authenticated;

create or replace function public.backoffice_used_market_review(
  p_observation_id uuid, p_region text, p_approved boolean,
  p_confirmed_price numeric, p_evidence_note text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_obs public.used_market_observations%rowtype; v_before jsonb;
begin
  v_uid:=public.dk_used_market_require_admin();
  if p_region is null or p_region not in ('TW','OVERSEAS','UNKNOWN') or p_approved is null
     or length(trim(coalesce(p_evidence_note,'')))<5 or length(p_evidence_note)>1000 then
    raise exception '請選擇地區並填寫至少 5 字的核對依據（最多 1000 字）';
  end if;
  select * into v_obs from public.used_market_observations where id=p_observation_id;
  if not found then raise exception '找不到候選資料'; end if;
  perform 1 from public.used_market_watchlist where id=v_obs.watchlist_id for update;
  if not exists(select 1 from public.used_market_review_candidates where id=p_observation_id) then
    raise exception '此樣本已過期或已有較新抓取，請重新整理';
  end if;
  if p_approved and (not v_obs.accepted or p_region='UNKNOWN' or p_confirmed_price is null
     or p_confirmed_price<=0 or p_confirmed_price>=1000000) then
    raise exception '只能確認通過初篩且地區、台幣價格已核實的樣本';
  end if;
  select to_jsonb(r) into v_before from public.used_market_reviews r where observation_id=p_observation_id;
  insert into public.used_market_reviews values
    (p_observation_id,p_region,p_approved,case when p_approved then p_confirmed_price end,trim(p_evidence_note),v_uid,now())
  on conflict(observation_id) do update set region=excluded.region,approved=excluded.approved,
    confirmed_price=excluded.confirmed_price,evidence_note=excluded.evidence_note,
    reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at;
  perform public.dk_used_market_write_audit(v_uid,'MARKET_CANDIDATE_REVIEWED','MARKET_OBSERVATION',p_observation_id,
    p_evidence_note,coalesce(v_before,'{}'::jsonb),
    (select to_jsonb(r) from public.used_market_reviews r where observation_id=p_observation_id));
  return jsonb_build_object('ok',true);
end $$;

create table if not exists public.used_market_candidate_imports (
  batch_id uuid not null references public.used_market_batches(id),
  watchlist_id uuid not null references public.used_market_watchlist(id),
  price_id uuid references public.used_market_prices(id) on delete set null,
  snapshot jsonb not null, created_by uuid not null, created_at timestamptz not null default now(),
  primary key(batch_id,watchlist_id)
);
alter table public.used_market_candidate_imports enable row level security;
revoke all on public.used_market_candidate_imports from public,anon,authenticated;
grant select on public.used_market_candidate_imports to authenticated;
drop policy if exists used_market_imports_admin_read on public.used_market_candidate_imports;
create policy used_market_imports_admin_read on public.used_market_candidate_imports
  for select to authenticated using(public.is_admin());

create or replace function public.backoffice_used_market_import_reviewed(p_watchlist_id uuid,p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_watch public.used_market_watchlist%rowtype; v_status text;
  v_count int; v_low numeric; v_mid numeric; v_high numeric; v_snapshot jsonb; v_result jsonb;
begin
  v_uid:=public.dk_used_market_require_admin();
  select * into v_watch from public.used_market_watchlist where id=p_watchlist_id and enabled for update;
  if not found then raise exception '監控型號不存在或已停用'; end if;
  select status into v_status from public.used_market_batches where id=p_batch_id for update;
  if v_status is distinct from 'DRAFT' then raise exception '只能匯入草稿批次'; end if;
  if exists(select 1 from public.used_market_candidate_imports where batch_id=p_batch_id and watchlist_id=p_watchlist_id) then
    raise exception '此型號已匯入該草稿，請到行情資料檢查';
  end if;
  if exists(select 1 from public.used_market_prices where market_batch_id=p_batch_id
    and coalesce(category,'')=v_watch.category and coalesce(brand,'')=v_watch.brand
    and coalesce(model,'')=v_watch.model and coalesce(variant,'')=v_watch.variant) then
    raise exception '草稿已有此型號，請勿重複匯入';
  end if;
  select count(*),percentile_cont(0.25) within group(order by confirmed_price),
    percentile_cont(0.5) within group(order by confirmed_price),percentile_cont(0.75) within group(order by confirmed_price),
    jsonb_agg(jsonb_build_object('observation_id',id,'url',item_url,'price',confirmed_price,'note',evidence_note,'reviewed_at',reviewed_at))
  into v_count,v_low,v_mid,v_high,v_snapshot
  from public.used_market_review_candidates
  where watchlist_id=p_watchlist_id and accepted and approved and region='TW';
  if v_count<3 then raise exception '樣本不足：至少需要 3 筆不同連結、人工確認的台灣二手樣本'; end if;
  v_result:=public.backoffice_used_market_create_price(jsonb_build_object(
    'market_batch_id',p_batch_id,'category',v_watch.category,'brand',v_watch.brand,'model',v_watch.model,'variant',v_watch.variant,
    'market_low',round(v_low,2),'market_mid',round(v_mid,2),'market_high',round(v_high,2),
    'sample_count',v_count,'confidence',0,'source_type','台灣二手開價／人工確認',
    'effective_date',current_date,'note','人工核對台灣二手單品含運台幣開價，非成交價。信心分數尚未評定；啟用批次前仍需審核。'));
  insert into public.used_market_candidate_imports(batch_id,watchlist_id,price_id,snapshot,created_by)
    values(p_batch_id,p_watchlist_id,(v_result->>'id')::uuid,v_snapshot,v_uid);
  perform public.dk_used_market_write_audit(v_uid,'MARKET_CANDIDATES_IMPORTED','MARKET_PRICE',(v_result->>'id')::uuid,
    '人工確認樣本轉入草稿','{}'::jsonb,v_snapshot);
  return v_result;
end $$;
revoke all on function public.backoffice_used_market_review(uuid,text,boolean,numeric,text) from public,anon,authenticated;
revoke all on function public.backoffice_used_market_import_reviewed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.backoffice_used_market_review(uuid,text,boolean,numeric,text) to authenticated;
grant execute on function public.backoffice_used_market_import_reviewed(uuid,uuid) to authenticated;
commit;
