-- Allow a customer to request replacement of every eligible active node in one
-- atomic operation. Nodes already being replaced are deliberately left alone.

create or replace function public.request_all_proxy_nodes_recreation(
  target_profile_id bigint
) returns table(scheduled_job_id bigint, scheduled_node_id bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  node_row public.proxy_nodes%rowtype;
  job_row public.proxy_provisioning_jobs%rowtype;
  queued_job_id bigint;
begin
  for node_row in
    select n.*
    from public.proxy_nodes n
    join public.orders o on o.id = n.order_id
    where n.profile_id = target_profile_id
      and o.status = 'active'
      and o.expires_at is not null
      and o.expires_at > now()
      and n.status in ('online', 'degraded', 'offline', 'error')
      and n.public_host is not null
      and n.tunnel_port is not null
    order by n.id
    for update of n skip locked
  loop
    select * into job_row
    from public.proxy_provisioning_jobs
    where node_id = node_row.id and action = 'replace'
    for update;

    if found and job_row.status in ('queued', 'running', 'retry') then
      continue;
    end if;

    insert into public.proxy_provisioning_jobs(
      node_id, action, status, attempts, max_attempts, run_after,
      locked_by, locked_until, last_error
    ) values (
      node_row.id, 'replace', 'queued', 0, 5, now(), null, null, null
    )
    on conflict (node_id, action) do update set
      status = 'queued', attempts = 0, max_attempts = 5, run_after = now(),
      locked_by = null, locked_until = null, last_error = null, updated_at = now()
    returning id into queued_job_id;

    update public.proxy_nodes set
      status = 'rotating', error_code = null, error_message = null,
      last_status_change_at = now()
    where id = node_row.id;

    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (node_row.id, node_row.profile_id, 'proxy.node.force_recreate_requested', jsonb_build_object(
      'nodeId', node_row.id, 'orderId', node_row.order_id,
      'status', 'rotating', 'jobId', queued_job_id
    ));

    scheduled_job_id := queued_job_id;
    scheduled_node_id := node_row.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.request_all_proxy_nodes_recreation(bigint) from public, anon, authenticated;
grant execute on function public.request_all_proxy_nodes_recreation(bigint) to service_role;
