-- Keep the current proxy online while a replacement job is waiting for a
-- temporary capacity slot. ROTATING now means the worker has begun cutover.

create or replace function public.enqueue_due_proxy_rotations(
  batch_size integer default 1
) returns table(scheduled_job_id bigint, scheduled_node_id bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  due_node record;
  queued_job_id bigint;
  selected_batch_size integer := least(500, greatest(1, coalesce(batch_size, 1)));
begin
  for due_node in
    select n.id, n.order_id, n.profile_id, n.status
    from public.proxy_nodes n
    join public.orders o on o.id = n.order_id
    left join public.proxy_provisioning_jobs j on j.node_id = n.id and j.action = 'replace'
    where o.status = 'active'
      and o.expires_at > now()
      and n.next_rotation_at <= now()
      and (n.current_instance_id is not null or n.status = 'error')
      and n.public_host is not null and n.tunnel_port is not null
      and n.status in ('online', 'degraded', 'offline', 'error')
      and (j.id is null or (j.status = 'completed' and j.updated_at < n.next_rotation_at) or (j.status = 'failed' and j.run_after <= now()))
    order by n.next_rotation_at, n.id
    for update of n skip locked
    limit selected_batch_size
  loop
    insert into public.proxy_provisioning_jobs(node_id, action, status, attempts, max_attempts, run_after, locked_by, locked_until, last_error)
    values (due_node.id, 'replace', 'queued', 0, 5, now(), null, null, null)
    on conflict (node_id, action) do update set
      status = 'queued', attempts = 0, max_attempts = 5, run_after = now(), locked_by = null, locked_until = null, last_error = null, updated_at = now()
    returning id into queued_job_id;

    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (due_node.id, due_node.profile_id, 'proxy.node.rotation_scheduled', jsonb_build_object(
      'nodeId', due_node.id, 'orderId', due_node.order_id, 'status', due_node.status, 'jobId', queued_job_id
    ));
    scheduled_job_id := queued_job_id;
    scheduled_node_id := due_node.id;
    return next;
  end loop;
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
  -- If the old sandbox is still assigned, cutover never started: preserve
  -- service instead of presenting a healthy endpoint as ROTATING.
  next_node_status := case
    when next_job_status = 'failed' and node_row.current_instance_id is null then 'error'
    when node_row.current_instance_id is null then 'rotating'
    else 'online'
  end;

  update public.proxy_provisioning_jobs set
    status = next_job_status, last_error = left(failure_message, 2000), locked_by = null, locked_until = null,
    run_after = case when next_job_status = 'retry' then now() + make_interval(secs => greatest(5, retry_delay_seconds)) else now() + interval '5 minutes' end
  where id = target_job_id;

  update public.proxy_nodes set
    status = next_node_status,
    error_code = case when next_node_status = 'online' then null else 'replacement_failed' end,
    error_message = case when next_node_status = 'online' then null else left(failure_message, 2000) end,
    last_status_change_at = now()
  where id = node_row.id;

  update public.provider_capacity_leases set status = 'released', released_at = now()
  where node_id = node_row.id and purpose = 'replacement' and released_at is null;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', node_row.order_id, 'status', next_node_status,
    'errorMessage', case when next_node_status = 'online' then null else left(failure_message, 2000) end
  ));
  return next_job_status;
end;
$$;

revoke all on function public.enqueue_due_proxy_rotations(integer) from public, anon, authenticated;
revoke all on function public.fail_proxy_replacement(bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.enqueue_due_proxy_rotations(integer) to service_role;
grant execute on function public.fail_proxy_replacement(bigint, text, text, integer) to service_role;
