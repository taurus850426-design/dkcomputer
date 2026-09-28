-- Stage 34: exclude unverified legacy samples; count each URL only once.
-- Apply after Stage 33. History is retained; no observations are deleted.
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
left join (
  select distinct on (watchlist_id, provider, item_url) *
  from public.used_market_observations
  where raw_data->>'rules_version' = '2'
  order by watchlist_id, provider, item_url, collected_at desc, id desc
) o
  on o.watchlist_id=w.id and o.collected_at >= now() - interval '30 days'
where w.enabled
group by w.id;

revoke all on public.used_market_candidate_summary from anon;
grant select on public.used_market_candidate_summary to authenticated;

