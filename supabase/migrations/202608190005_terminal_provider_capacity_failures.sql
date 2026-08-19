-- Capacity/key exhaustion is deterministic until an administrator changes
-- provider configuration. Do not burn all retry attempts for the same error.
create or replace function public.fail_proxy_job_terminal(
  target_job_id bigint,
  worker_id text,
  failure_message text
) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  next_node_status text;
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Provisioning job lease is not owned by worker';
  end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;

  next_node_status := case
    when job_row.action = 'replace' and node_row.current_instance_id is not null then 'online'
    else 'error'
  end;

  update public.proxy_provisioning_jobs set
    status = 'failed', attempts = greatest(attempts, max_attempts),
    last_error = left(failure_message, 2000), locked_by = null, locked_until = null,
    run_after = now()
  where id = job_row.id;

  update public.proxy_nodes set
    status = next_node_status,
    error_code = case when next_node_status = 'online' then null else 'provider_capacity_unavailable' end,
    error_message = case when next_node_status = 'online' then null else left(failure_message, 2000) end,
    last_status_change_at = now()
  where id = node_row.id;

  if job_row.action = 'provision' then
    update public.orders set status = 'provisioning_failed' where id = node_row.order_id;
  end if;

  update public.provider_capacity_leases set status = 'released', released_at = now()
  where node_id = node_row.id and released_at is null;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', node_row.order_id, 'status', next_node_status,
    'errorMessage', case when next_node_status = 'online' then null else left(failure_message, 2000) end
  ));
  return 'failed';
end $$;

revoke all on function public.fail_proxy_job_terminal(bigint, text, text) from public, anon, authenticated;
grant execute on function public.fail_proxy_job_terminal(bigint, text, text) to service_role;
