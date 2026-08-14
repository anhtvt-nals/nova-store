-- Automatically queue replacement jobs shortly before provider sandboxes expire.
-- Node row locks make this safe when more than one API instance runs the scheduler.

create index if not exists proxy_nodes_rotation_due_idx
on public.proxy_nodes(next_rotation_at, id)
where next_rotation_at is not null
  and status in ('online', 'degraded', 'offline', 'error');

create or replace function public.enqueue_due_proxy_rotations(
  batch_size integer default 100
) returns table(scheduled_job_id bigint, scheduled_node_id bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  due_node record;
  queued_job_id bigint;
  selected_batch_size integer := least(500, greatest(1, coalesce(batch_size, 100)));
begin
  for due_node in
    select n.id, n.order_id, n.profile_id
    from public.proxy_nodes n
    join public.orders o on o.id = n.order_id
    left join public.proxy_provisioning_jobs j
      on j.node_id = n.id and j.action = 'replace'
    where o.status = 'active'
      and o.expires_at is not null
      and o.expires_at > now()
      and n.next_rotation_at is not null
      and n.next_rotation_at <= now()
      and n.current_instance_id is not null
      and n.public_host is not null
      and n.tunnel_port is not null
      and n.status in ('online', 'degraded', 'offline', 'error')
      and (
        j.id is null
        or (
          j.status in ('completed', 'failed')
          and j.updated_at < n.next_rotation_at
        )
      )
    order by n.next_rotation_at, n.id
    for update of n skip locked
    limit selected_batch_size
  loop
    insert into public.proxy_provisioning_jobs(
      node_id, action, status, attempts, max_attempts, run_after,
      locked_by, locked_until, last_error
    ) values (
      due_node.id, 'replace', 'queued', 0, 5, now(),
      null, null, null
    )
    on conflict (node_id, action) do update set
      status = 'queued', attempts = 0, max_attempts = 5, run_after = now(),
      locked_by = null, locked_until = null, last_error = null, updated_at = now()
    returning id into queued_job_id;

    update public.proxy_nodes set
      status = 'rotating', error_code = null, error_message = null,
      last_status_change_at = now()
    where id = due_node.id;

    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (due_node.id, due_node.profile_id, 'proxy.node.rotation_scheduled', jsonb_build_object(
      'nodeId', due_node.id,
      'orderId', due_node.order_id,
      'status', 'rotating'
    ));

    scheduled_job_id := queued_job_id;
    scheduled_node_id := due_node.id;
    return next;
  end loop;
end;
$$;

revoke all on function public.enqueue_due_proxy_rotations(integer) from public, anon, authenticated;
grant execute on function public.enqueue_due_proxy_rotations(integer) to service_role;
