-- Cancel a running proxy order without freeing provider capacity until its
-- sandbox is actually terminated. This avoids overbooking an API key while a
-- provider-side VM is still alive.

create function public.cancel_proxy_order_by_admin(
  target_order_id bigint,
  actor_profile_id bigint
) returns table(terminated_node_count integer, queued_termination_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_row public.orders%rowtype;
  node_row public.proxy_nodes%rowtype;
  termination_job public.proxy_provisioning_jobs%rowtype;
  now_at timestamptz := now();
  terminated_count integer := 0;
  queued_count integer := 0;
begin
  select * into order_row from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if order_row.status not in ('active', 'provisioning', 'provisioning_failed') then
    raise exception 'Only running proxy orders can be cancelled';
  end if;

  -- Entitlement ends first, so client endpoints and rotation URLs immediately
  -- stop being returned even while the worker removes provider resources.
  update public.orders set status = 'cancelled', updated_at = now_at where id = order_row.id;

  -- Prevent queued/retrying work from creating a new VM after cancellation.
  -- A worker that was already running will fail its completion transition and
  -- clean up the freshly created instance in its error path.
  update public.proxy_provisioning_jobs jobs
  set status = 'failed', locked_by = null, locked_until = null,
      last_error = 'Order cancelled by administrator', updated_at = now_at
  where jobs.node_id in (select id from public.proxy_nodes where order_id = order_row.id)
    and jobs.action in ('provision', 'replace')
    and jobs.status in ('queued', 'retry', 'running');

  for node_row in
    select * from public.proxy_nodes
    where order_id = order_row.id and status <> 'terminated'
    order by id for update
  loop
    if node_row.current_instance_id is null then
      update public.proxy_nodes set
        status = 'terminated', public_host = null, tunnel_port = null,
        next_rotation_at = null, egress_ip = null, egress_country_code = null,
        error_code = null, error_message = null,
        last_status_change_at = now_at
      where id = node_row.id;
      update public.provider_capacity_leases set status = 'released', released_at = now_at
      where node_id = node_row.id and released_at is null;
      terminated_count := terminated_count + 1;
      insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
      values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
        'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'terminated', 'reason', 'admin_cancelled'
      ));
      continue;
    end if;

    select * into termination_job from public.proxy_provisioning_jobs
    where node_id = node_row.id and action = 'terminate' for update;

    if not found or termination_job.status not in ('queued', 'running', 'retry') then
      insert into public.proxy_provisioning_jobs(
        node_id, action, status, attempts, max_attempts, run_after,
        locked_by, locked_until, last_error
      ) values (node_row.id, 'terminate', 'queued', 0, 10, now_at, null, null, null)
      on conflict (node_id, action) do update set
        status = 'queued', attempts = 0, max_attempts = 10, run_after = now_at,
        locked_by = null, locked_until = null, last_error = null, updated_at = now_at;
      queued_count := queued_count + 1;
    end if;

    update public.proxy_nodes set
      status = 'terminating', next_rotation_at = null,
      error_code = null, error_message = null, last_status_change_at = now_at
    where id = node_row.id;
    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (node_row.id, node_row.profile_id, 'proxy.node.termination_scheduled', jsonb_build_object(
      'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'terminating', 'reason', 'admin_cancelled'
    ));
  end loop;

  insert into public.activity_logs(actor_profile_id, event_type, entity_type, entity_id, description, tone, metadata)
  values (actor_profile_id, 'order_cancelled_by_admin', 'order', order_row.id,
    format('Order #%s was cancelled by an administrator', order_row.id), 'warning',
    jsonb_build_object('terminatedNodes', terminated_count, 'queuedTerminations', queued_count));

  terminated_node_count := terminated_count;
  queued_termination_count := queued_count;
  return next;
end;
$$;

revoke all on function public.cancel_proxy_order_by_admin(bigint, bigint) from public, anon, authenticated;
grant execute on function public.cancel_proxy_order_by_admin(bigint, bigint) to service_role;
