-- Expire active orders durably and tear down their compute sandboxes. The
-- order row lock makes this safe with multiple API replicas running schedulers.

create index if not exists orders_active_expiry_idx
on public.orders(expires_at, id)
where status = 'active' and expires_at is not null;

create or replace function public.enqueue_expired_proxy_terminations(
  batch_size integer default 100
) returns table(scheduled_job_id bigint, scheduled_node_id bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  expired_order public.orders%rowtype;
  node_row public.proxy_nodes%rowtype;
  termination_job public.proxy_provisioning_jobs%rowtype;
  queued_job_id bigint;
  selected_batch_size integer := least(500, greatest(1, coalesce(batch_size, 100)));
begin
  for expired_order in
    select *
    from public.orders
    where status = 'active'
      and expires_at is not null
      and expires_at <= now()
    order by expires_at, id
    for update skip locked
    limit selected_batch_size
  loop
    -- This prevents any not-yet-claimed provision/replacement work from
    -- creating a sandbox after the customer entitlement has ended.
    update public.orders set status = 'expired' where id = expired_order.id;

    update public.proxy_provisioning_jobs jobs
    set status = 'failed', locked_by = null, locked_until = null,
        last_error = 'Order expired before provisioning completed', updated_at = now()
    where jobs.node_id in (select id from public.proxy_nodes where order_id = expired_order.id)
      and jobs.action in ('provision', 'replace')
      and jobs.status in ('queued', 'retry');

    for node_row in
      select *
      from public.proxy_nodes
      where order_id = expired_order.id and status <> 'terminated'
      order by id
      for update
    loop
      if node_row.current_instance_id is null then
        update public.proxy_nodes set
          status = 'terminated', public_host = null, tunnel_port = null,
          next_rotation_at = null, egress_ip = null,
          error_code = null, error_message = null, last_status_change_at = now()
        where id = node_row.id;

        update public.provider_capacity_leases set status = 'released', released_at = now()
        where node_id = node_row.id and released_at is null;

        insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
        values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
          'nodeId', node_row.id, 'orderId', expired_order.id, 'status', 'terminated'
        ));
        continue;
      end if;

      select * into termination_job
      from public.proxy_provisioning_jobs
      where node_id = node_row.id and action = 'terminate'
      for update;

      if found and termination_job.status in ('queued', 'running', 'retry') then
        update public.proxy_nodes set
          status = 'terminating', next_rotation_at = null,
          last_status_change_at = now()
        where id = node_row.id;
        continue;
      end if;

      insert into public.proxy_provisioning_jobs(
        node_id, action, status, attempts, max_attempts, run_after,
        locked_by, locked_until, last_error
      ) values (
        node_row.id, 'terminate', 'queued', 0, 10, now(),
        null, null, null
      )
      on conflict (node_id, action) do update set
        status = 'queued', attempts = 0, max_attempts = 10, run_after = now(),
        locked_by = null, locked_until = null, last_error = null, updated_at = now()
      returning id into queued_job_id;

      update public.proxy_nodes set
        status = 'terminating', next_rotation_at = null,
        error_code = null, error_message = null, last_status_change_at = now()
      where id = node_row.id;

      insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
      values (node_row.id, node_row.profile_id, 'proxy.node.termination_scheduled', jsonb_build_object(
        'nodeId', node_row.id, 'orderId', expired_order.id, 'status', 'terminating'
      ));

      scheduled_job_id := queued_job_id;
      scheduled_node_id := node_row.id;
      return next;
    end loop;
  end loop;
end;
$$;

create or replace function public.complete_proxy_termination(
  target_job_id bigint,
  worker_id text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  now_at timestamptz := now();
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.action <> 'terminate' or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Termination job lease is not owned by worker';
  end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;

  if node_row.current_instance_id is not null then
    update public.proxy_node_instances set
      status = 'stopped', stopped_at = now_at, last_heartbeat_at = now_at
    where node_id = node_row.id
      and external_instance_id = node_row.current_instance_id
      and status in ('provisioning', 'running', 'stopping', 'error');
  end if;

  update public.proxy_nodes set
    status = 'terminated', current_instance_id = null,
    public_host = null, tunnel_port = null, egress_ip = null,
    next_rotation_at = null, last_health_at = now_at,
    error_code = null, error_message = null,
    health = jsonb_build_object('reachable', false, 'checkedAt', now_at),
    last_status_change_at = now_at
  where id = node_row.id;

  update public.provider_capacity_leases set status = 'released', released_at = now_at
  where node_id = node_row.id and released_at is null;

  update public.proxy_provisioning_jobs set
    status = 'completed', locked_by = null, locked_until = null, last_error = null
  where id = target_job_id;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', node_row.order_id, 'status', 'terminated'
  ));
end;
$$;

create or replace function public.fail_proxy_termination(
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
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.action <> 'terminate' or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Termination job lease is not owned by worker';
  end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;

  next_job_status := case when job_row.attempts >= job_row.max_attempts then 'failed' else 'retry' end;
  update public.proxy_provisioning_jobs set
    status = next_job_status, last_error = left(failure_message, 2000),
    locked_by = null, locked_until = null,
    run_after = case when next_job_status = 'retry'
      then now() + make_interval(secs => greatest(5, retry_delay_seconds)) else run_after end
  where id = target_job_id;

  update public.proxy_nodes set
    status = 'terminating', error_code = case when next_job_status = 'failed' then 'termination_failed' else null end,
    error_message = left(failure_message, 2000), last_status_change_at = now()
  where id = node_row.id;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', node_row.order_id, 'status', 'terminating',
    'errorMessage', left(failure_message, 2000)
  ));
  return next_job_status;
end;
$$;

revoke all on function public.enqueue_expired_proxy_terminations(integer) from public, anon, authenticated;
revoke all on function public.complete_proxy_termination(bigint, text) from public, anon, authenticated;
revoke all on function public.fail_proxy_termination(bigint, text, text, integer) from public, anon, authenticated;
grant execute on function public.enqueue_expired_proxy_terminations(integer) to service_role;
grant execute on function public.complete_proxy_termination(bigint, text) to service_role;
grant execute on function public.fail_proxy_termination(bigint, text, text, integer) to service_role;
