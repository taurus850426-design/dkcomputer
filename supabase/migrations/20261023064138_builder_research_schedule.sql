-- Activation is deliberately gated by the disabled budget config and a Vault secret.
-- Prerequisites: pg_cron + pg_net; Vault name builder_research_cron_token matches Edge secret.
do $$
begin
 if exists(select 1 from pg_extension where extname='pg_cron') and exists(select 1 from pg_extension where extname='pg_net') and to_regclass('vault.decrypted_secrets') is not null then
  if not exists(select 1 from cron.job where jobname='builder-research-daily') then
   perform cron.schedule('builder-research-daily','10 19 * * *',$job$
    select net.http_post(
     url:=(select decrypted_secret from vault.decrypted_secrets where name='builder_research_function_url' limit 1),
     headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='builder_research_cron_token' limit 1)),
     body:='{"action":"refresh"}'::jsonb,timeout_milliseconds:=120000)
    where exists(select 1 from public.builder_research_config where enabled and billing_confirmed)
      and exists(select 1 from vault.decrypted_secrets where name='builder_research_cron_token')
      and exists(select 1 from vault.decrypted_secrets where name='builder_research_function_url' and decrypted_secret ~ '^https://[a-z0-9]{20}[.]supabase[.]co/functions/v1/builder-research$');
   $job$);
  end if;
 else
  raise notice 'builder-research-daily is not registered: enable pg_cron and pg_net, then rerun this schedule migration before activating research';
 end if;
end $$;
