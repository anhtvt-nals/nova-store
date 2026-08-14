-- Client-requested replacement of one active proxy node. The public tunnel
-- endpoint remains stable while the backing compute sandbox is recreated.

create or replace function public.request_proxy_node_restart(
  target_node_id bigint,
  target_profile_id bigint
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  node_row public.proxy_nodes%rowtype;
  order_row public.orders%rowtype;
  job_row public.proxy_provisioning_jobs%rowtype;
  queued_job_id bigint;
begin
  select * into node_row from public.proxy_nodes where id = target_node_id for update;
  if not found or node_row.profile_id <> target_profile_id then raise exception 'Proxy node not found'; end if;

  select * into order_row from public.orders where id = node_row.order_id for update;
  if not found or order_row.status <> 'active' or order_row.expires_at is null or order_row.expires_at <= now() then
    raise exception 'Only a node from an active order can be restarted';
  end if;
  if node_row.status not in ('online', 'degraded', 'offline', 'error') then
    raise exception 'Proxy node cannot be restarted from status %', node_row.status;
  end if;
  if node_row.public_host is null or node_row.tunnel_port is null then
    raise exception 'Proxy node does not have an allocated endpoint';
  end if;

  select * into job_row
  from public.proxy_provisioning_jobs
  where node_id = target_node_id and action = 'replace'
  for update;

  if found and job_row.status in ('queued', 'running', 'retry') then
    raise exception 'Proxy node restart is already in progress';
  end if;
  if found and job_row.updated_at > now() - interval '2 minutes' then
    raise exception 'Proxy node restart is cooling down';
  end if;

  insert into public.proxy_provisioning_jobs(
    node_id, action, status, attempts, max_attempts, run_after,
    locked_by, locked_until, last_error
  ) values (
    target_node_id, 'replace', 'queued', 0, 5, now(), null, null, null
  )
  on conflict (node_id, action) do update set
    status = 'queued', attempts = 0, max_attempts = 5, run_after = now(),
    locked_by = null, locked_until = null, last_error = null, updated_at = now()
  returning id into queued_job_id;

  update public.proxy_nodes set
    status = 'rotating', error_code = null, error_message = null,
    last_status_change_at = now()
  where id = target_node_id;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (target_node_id, target_profile_id, 'proxy.node.restart_requested', jsonb_build_object(
    'nodeId', target_node_id, 'orderId', node_row.order_id, 'status', 'rotating'
  ));

  return queued_job_id;
end;
$$;

create or replace function public.complete_proxy_replacement(
  target_job_id bigint,
  worker_id text,
  external_instance_id text,
  reported_egress_ip text,
  reported_next_rotation_at timestamptz
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  order_row public.orders%rowtype;
  replacement_lease public.provider_capacity_leases%rowtype;
  now_at timestamptz := now();
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.action <> 'replace' or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Replacement job lease is not owned by worker';
  end if;

  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;
  select * into order_row from public.orders where id = node_row.order_id for update;
  if order_row.status <> 'active' or order_row.expires_at <= now_at then raise exception 'Order is not active'; end if;

  select * into replacement_lease
  from public.provider_capacity_leases
  where node_id = node_row.id and purpose = 'replacement' and leased_by = worker_id
    and released_at is null and lease_expires_at >= now_at
  for update;
  if not found then raise exception 'Replacement capacity lease is not owned by worker'; end if;

  update public.provider_capacity_leases set status = 'released', released_at = now_at
  where node_id = node_row.id and purpose = 'customer' and released_at is null;

  update public.provider_capacity_leases set
    purpose = 'customer', status = 'active', leased_by = worker_id,
    lease_expires_at = order_row.expires_at
  where id = replacement_lease.id;

  update public.proxy_nodes set
    provider_id = replacement_lease.provider_id,
    provider_api_key_id = replacement_lease.provider_api_key_id,
    status = 'online', current_instance_id = external_instance_id,
    egress_ip = nullif(reported_egress_ip, '')::inet,
    last_health_at = now_at, last_status_change_at = now_at,
    next_rotation_at = reported_next_rotation_at,
    error_code = null, error_message = null,
    health = jsonb_build_object('reachable', true, 'checkedAt', now_at)
  where id = node_row.id;

  update public.proxy_provisioning_jobs set
    status = 'completed', locked_by = null, locked_until = null, last_error = null
  where id = target_job_id;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.restarted', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'online',
    'egressIp', reported_egress_ip, 'nextRotationAt', reported_next_rotation_at
  ));
end;
$$;

create or replace function public.fail_proxy_replacement(
  target_job_id bigint,
  worker_id text,
  failure_message text,
  retry_delay_seconds integer default 30
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  next_job_status text;
  next_node_status text;
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.action <> 'replace' or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Replacement job lease is not owned by worker';
  end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;

  next_job_status := case when job_row.attempts >= job_row.max_attempts then 'failed' else 'retry' end;
  next_node_status := case when next_job_status = 'failed' then 'error' else 'rotating' end;

  update public.proxy_provisioning_jobs set
    status = next_job_status, last_error = left(failure_message, 2000),
    locked_by = null, locked_until = null,
    run_after = case when next_job_status = 'retry'
      then now() + make_interval(secs => greatest(5, retry_delay_seconds)) else run_after end
  where id = target_job_id;

  update public.proxy_nodes set
    status = next_node_status, error_code = 'replacement_failed',
    error_message = left(failure_message, 2000), last_status_change_at = now()
  where id = node_row.id;

  update public.provider_capacity_leases set status = 'released', released_at = now()
  where node_id = node_row.id and purpose = 'replacement' and released_at is null;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', node_row.order_id, 'status', next_node_status,
    'errorMessage', left(failure_message, 2000)
  ));
  return next_job_status;
end;
$$;

revoke all on function public.request_proxy_node_restart(bigint, bigint) from public, anon, authenticated;
revoke all on function public.complete_proxy_replacement(bigint, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_proxy_replacement(bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.request_proxy_node_restart(bigint, bigint) to service_role;
grant execute on function public.complete_proxy_replacement(bigint, text, text, text, timestamptz) to service_role;
grant execute on function public.fail_proxy_replacement(bigint, text, text, integer) to service_role;
