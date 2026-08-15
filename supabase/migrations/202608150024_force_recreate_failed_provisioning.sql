-- Let a customer manually retry only the failed nodes of an order that never
-- activated. Successful sibling nodes keep their existing sandbox and lease.
-- Active orders retain the existing force-recreate behaviour.

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
  job_action text;
begin
  for node_row in
    select n.*
    from public.proxy_nodes n
    join public.orders o on o.id = n.order_id
    where n.profile_id = target_profile_id
      and n.status <> 'terminating'
      and (
        (
          o.status = 'active'
          and o.expires_at is not null
          and o.expires_at > now()
        )
        or (
          -- A failed initial provision has no active endpoint. Retrying just
          -- these nodes is safe and does not create a second sandbox for a
          -- sibling node that already completed.
          o.status = 'provisioning_failed'
          and n.current_instance_id is null
          and n.status in ('queued', 'provisioning', 'error', 'offline', 'degraded', 'rotating')
        )
      )
    order by n.id
    for update of n skip locked
  loop
    job_action := case when exists (
      select 1 from public.orders o where o.id = node_row.order_id and o.status = 'provisioning_failed'
    ) then 'provision' else 'replace' end;

    select * into job_row
    from public.proxy_provisioning_jobs
    where node_id = node_row.id
      and action = job_action
      and status in ('queued', 'running', 'retry')
    order by id
    for update
    limit 1;

    if found then
      scheduled_job_id := job_row.id;
      scheduled_node_id := node_row.id;
      return next;
      continue;
    end if;

    insert into public.proxy_provisioning_jobs(
      node_id, action, status, attempts, max_attempts, run_after,
      locked_by, locked_until, last_error
    ) values (
      node_row.id, job_action, 'queued', 0, 5, now(), null, null, null
    )
    on conflict (node_id, action) do update set
      status = 'queued', attempts = 0, max_attempts = 5, run_after = now(),
      locked_by = null, locked_until = null, last_error = null, updated_at = now()
    returning id into queued_job_id;

    update public.proxy_nodes set
      status = case when job_action = 'provision' then 'queued' else 'rotating' end,
      error_code = null, error_message = null, last_status_change_at = now()
    where id = node_row.id;

    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (node_row.id, node_row.profile_id, 'proxy.node.force_recreate_requested', jsonb_build_object(
      'nodeId', node_row.id, 'orderId', node_row.order_id,
      'status', case when job_action = 'provision' then 'queued' else 'rotating' end,
      'jobId', queued_job_id, 'action', job_action
    ));

    scheduled_job_id := queued_job_id;
    scheduled_node_id := node_row.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.request_all_proxy_nodes_recreation(bigint) from public, anon, authenticated;
grant execute on function public.request_all_proxy_nodes_recreation(bigint) to service_role;
