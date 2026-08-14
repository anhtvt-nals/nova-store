-- Recover UI/runtime state after a worker is killed during rotation. Active
-- jobs are never touched here: only rows without a job or with terminal jobs
-- are repaired under row locks.

create or replace function public.recover_stalled_proxy_rotations(
  batch_size integer default 100
) returns table(recovered_node_id bigint, recovery_action text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  node_row public.proxy_nodes%rowtype;
  job_row public.proxy_provisioning_jobs%rowtype;
  queued_job_id bigint;
  selected_batch_size integer := least(500, greatest(1, coalesce(batch_size, 100)));
begin
  -- Match normal claim behaviour so abandoned jobs can be claimed after an
  -- ungraceful API shutdown.
  update public.proxy_provisioning_jobs
  set status = 'retry', locked_by = null, locked_until = null, run_after = now(),
      last_error = coalesce(last_error, 'Worker lease expired')
  where status = 'running' and locked_until < now();

  for node_row in
    select n.*
    from public.proxy_nodes n
    join public.orders o on o.id = n.order_id
    left join public.proxy_provisioning_jobs j
      on j.node_id = n.id and j.action = 'replace'
    where n.status = 'rotating'
      and o.status = 'active'
      and o.expires_at > now()
      and n.public_host is not null
      and n.tunnel_port is not null
      and (j.id is null or j.status in ('completed', 'failed'))
    order by n.last_status_change_at, n.id
    for update of n skip locked
    limit selected_batch_size
  loop
    select * into job_row
    from public.proxy_provisioning_jobs
    where node_id = node_row.id and action = 'replace'
    for update;

    if found and job_row.status = 'completed' then
      update public.proxy_nodes set
        status = case when current_instance_id is null then 'error' else 'online' end,
        error_code = case when current_instance_id is null then 'rotation_state_inconsistent' else null end,
        error_message = case when current_instance_id is null then 'Rotation completed without an active sandbox' else null end,
        last_status_change_at = now()
      where id = node_row.id;
      recovered_node_id := node_row.id;
      recovery_action := 'repaired_terminal_state';
      return next;
      continue;
    end if;

    if found and job_row.status = 'failed' and job_row.run_after > now() then
      update public.proxy_nodes set
        status = 'error', error_code = 'replacement_failed',
        error_message = coalesce(job_row.last_error, 'Replacement failed'), last_status_change_at = now()
      where id = node_row.id;
      recovered_node_id := node_row.id;
      recovery_action := 'marked_error';
      return next;
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
    values (node_row.id, node_row.profile_id, 'proxy.node.rotation_recovered', jsonb_build_object(
      'nodeId', node_row.id, 'orderId', node_row.order_id,
      'status', 'rotating', 'jobId', queued_job_id
    ));

    recovered_node_id := node_row.id;
    recovery_action := 'requeued';
    return next;
  end loop;
end;
$$;

revoke all on function public.recover_stalled_proxy_rotations(integer) from public, anon, authenticated;
grant execute on function public.recover_stalled_proxy_rotations(integer) to service_role;
