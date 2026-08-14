-- Defensive recovery for legacy/race-created jobs that are marked retry even
-- though they have already exhausted their attempts. Such rows cannot be
-- claimed by the worker and otherwise leave their nodes rotating forever.

create or replace function public.claim_proxy_provisioning_job(
  worker_id text,
  lock_seconds integer default 120
) returns setof public.proxy_provisioning_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claimed public.proxy_provisioning_jobs%rowtype;
begin
  update public.proxy_provisioning_jobs
  set status = 'retry', locked_by = null, locked_until = null, run_after = now(),
      last_error = coalesce(last_error, 'Worker lease expired')
  where status = 'running' and locked_until < now();

  -- A retry row with no attempts remaining is terminal for that attempt
  -- series. Rotation recovery will then enqueue a fresh series after its
  -- normal cooldown rather than leaving this unclaimable row forever.
  update public.proxy_provisioning_jobs
  set status = 'failed', locked_by = null, locked_until = null,
      last_error = coalesce(last_error, 'Retry attempts exhausted'), updated_at = now()
  where status = 'retry' and attempts >= max_attempts;

  select * into claimed
  from public.proxy_provisioning_jobs
  where status in ('queued', 'retry') and run_after <= now() and attempts < max_attempts
  order by run_after, id
  for update skip locked
  limit 1;

  if not found then return; end if;
  update public.proxy_provisioning_jobs
  set status = 'running', attempts = attempts + 1, locked_by = worker_id,
      locked_until = now() + make_interval(secs => greatest(30, lock_seconds))
  where id = claimed.id
  returning * into claimed;
  return next claimed;
end;
$$;

revoke all on function public.claim_proxy_provisioning_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_proxy_provisioning_job(text, integer) to service_role;
