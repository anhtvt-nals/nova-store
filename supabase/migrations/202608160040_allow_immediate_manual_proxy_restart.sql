-- A completed/failed replacement must not prevent the owner from explicitly
-- requesting another replacement. The unique (node_id, action) job still
-- prevents concurrent provisioners from touching the same node.
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

  -- Do not permit two replacement workers at once. Unlike the former
  -- two-minute cooldown, completed/failed jobs are safe to force-restart.
  if found and job_row.status in ('queued', 'running', 'retry') then
    raise exception 'Proxy node restart is already in progress';
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

revoke all on function public.request_proxy_node_restart(bigint, bigint) from public, anon, authenticated;
grant execute on function public.request_proxy_node_restart(bigint, bigint) to service_role;
