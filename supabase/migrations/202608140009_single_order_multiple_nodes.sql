-- One checkout creates one order. The requested node quantity belongs to the
-- order, while proxy_nodes are provisioned only after administrator approval.

alter table public.orders
  add column if not exists node_count integer not null default 1
  check (node_count between 1 and 100);

alter table public.proxy_nodes
  drop constraint if exists proxy_nodes_order_id_key;

create index if not exists proxy_nodes_order_idx on public.proxy_nodes(order_id);

drop function if exists public.create_proxy_orders(bigint, bigint, integer, integer, text);

create or replace function public.create_proxy_order(
  target_profile_id bigint,
  target_product_id bigint,
  requested_nodes integer,
  requested_days integer,
  requested_payment_method text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  selected_product record;
  new_order_id bigint;
  pending_orders integer;
begin
  if requested_nodes < 1 or requested_nodes > 100 then raise exception 'Node quantity must be between 1 and 100'; end if;
  if requested_days < 1 or requested_days > 365 then raise exception 'Rental days must be between 1 and 365'; end if;
  if requested_payment_method not in ('bank_transfer', 'crypto') then raise exception 'Unsupported payment method'; end if;
  if not exists (select 1 from public.profiles where id = target_profile_id and status = 'active') then
    raise exception 'Customer account is not active';
  end if;

  update public.orders set status = 'cancelled'
  where status = 'pending' and pending_expires_at <= now();

  select count(*) into pending_orders
  from public.orders
  where profile_id = target_profile_id and status = 'pending' and pending_expires_at > now();
  if pending_orders >= 3 then raise exception 'Too many pending orders'; end if;

  select id, name, base_price, currency, service_type
  into selected_product
  from public.products
  where id = target_product_id and is_active = true
  for share;

  if not found then raise exception 'Product not found'; end if;
  if selected_product.service_type <> 'proxy' then raise exception 'Node/day pricing is only available for proxy products'; end if;
  if selected_product.base_price <= 0 then raise exception 'Proxy daily price has not been configured'; end if;

  insert into public.orders(
    order_group_id, profile_id, product_id, plan_id, resource_id, status, payment_method,
    amount, currency, unit_price, node_count, rental_days, plan_name_snapshot,
    resource_name_snapshot, pending_expires_at
  ) values (
    gen_random_uuid(), target_profile_id, selected_product.id, null, null, 'pending', requested_payment_method,
    selected_product.base_price * requested_nodes * requested_days,
    selected_product.currency, selected_product.base_price, requested_nodes, requested_days,
    selected_product.name, format('%s nodes', requested_nodes), now() + interval '30 minutes'
  ) returning id into new_order_id;

  return new_order_id;
end;
$$;

revoke all on function public.create_proxy_order(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_order(bigint, bigint, integer, integer, text) to service_role;

create or replace function public.transition_order(
  target_order_id bigint,
  next_status text,
  actor_profile_id bigint
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_order public.orders%rowtype;
  new_node_id bigint;
  node_number integer;
begin
  if next_status not in ('active', 'rejected') then raise exception 'Unsupported order transition'; end if;
  select * into current_order from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if current_order.status <> 'pending' then raise exception 'Only pending orders can be reviewed'; end if;
  if current_order.pending_expires_at is not null and current_order.pending_expires_at <= now() then
    update public.orders set status = 'cancelled' where id = target_order_id;
    insert into public.activity_logs(actor_profile_id, event_type, entity_type, entity_id, description, tone)
    values (actor_profile_id, 'order_expired', 'order', target_order_id, format('Order #%s expired before approval', target_order_id), 'warning');
    return;
  end if;

  if next_status = 'active' then
    update public.orders set status = 'provisioning', activated_at = null, expires_at = null where id = target_order_id;

    for node_number in 1..current_order.node_count loop
      insert into public.proxy_nodes(order_id, profile_id, provider_id, status, public_host, tunnel_port, expires_at, metadata)
      values (
        current_order.id, current_order.profile_id, null, 'queued', null, null, null,
        jsonb_build_object('productId', current_order.product_id, 'nodeNumber', node_number)
      ) returning id into new_node_id;

      insert into public.proxy_provisioning_jobs(node_id, action, status, run_after)
      values (new_node_id, 'provision', 'queued', now());

      insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
      values (new_node_id, current_order.profile_id, 'proxy.node.queued', jsonb_build_object(
        'nodeId', new_node_id, 'orderId', current_order.id, 'nodeNumber', node_number, 'status', 'queued'
      ));
    end loop;
  else
    update public.orders set status = 'rejected' where id = target_order_id;
  end if;

  insert into public.activity_logs(actor_profile_id, event_type, entity_type, entity_id, description, tone)
  values (
    actor_profile_id,
    case when next_status = 'active' then 'order_approved_for_provisioning' else 'order_rejected' end,
    'order', target_order_id,
    case when next_status = 'active'
      then format('Order #%s was approved and %s nodes were queued for provisioning', target_order_id, current_order.node_count)
      else format('Order #%s was rejected', target_order_id)
    end,
    case when next_status = 'active' then 'success' else 'warning' end
  );
end;
$$;

revoke all on function public.transition_order(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.transition_order(bigint, text, bigint) to service_role;

create or replace function public.complete_proxy_provisioning(
  target_job_id bigint,
  worker_id text,
  external_instance_id text,
  reported_egress_ip text,
  reported_public_host text,
  reported_tunnel_port integer,
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
  remaining_nodes integer;
  now_at timestamptz := now();
  order_expires_at timestamptz;
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.status <> 'running' or job_row.locked_by <> worker_id then raise exception 'Provisioning job lease is not owned by worker'; end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;
  select * into order_row from public.orders where id = node_row.order_id for update;

  update public.proxy_nodes set status = 'online', current_instance_id = external_instance_id,
    egress_ip = nullif(reported_egress_ip, '')::inet, public_host = reported_public_host,
    tunnel_port = reported_tunnel_port, last_health_at = now_at, last_status_change_at = now_at,
    next_rotation_at = reported_next_rotation_at, error_code = null, error_message = null,
    health = jsonb_build_object('reachable', true, 'checkedAt', now_at)
  where id = node_row.id;

  update public.proxy_provisioning_jobs set status = 'completed', locked_by = null, locked_until = null
  where id = target_job_id;

  update public.provider_capacity_leases set status = 'active',
    lease_expires_at = now_at + make_interval(days => order_row.rental_days)
  where node_id = node_row.id and released_at is null;

  select count(*) into remaining_nodes
  from public.proxy_nodes nodes
  left join public.proxy_provisioning_jobs jobs
    on jobs.node_id = nodes.id and jobs.action = 'provision'
  where nodes.order_id = order_row.id and jobs.status is distinct from 'completed';

  if remaining_nodes = 0 then
    order_expires_at := now_at + make_interval(days => order_row.rental_days);
    update public.orders set status = 'active', activated_at = now_at, expires_at = order_expires_at
    where id = order_row.id;
    update public.proxy_nodes set expires_at = order_expires_at where order_id = order_row.id;
    update public.provider_capacity_leases set lease_expires_at = order_expires_at
    where node_id in (select id from public.proxy_nodes where order_id = order_row.id) and released_at is null;
  end if;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'online',
    'egressIp', reported_egress_ip, 'nextRotationAt', reported_next_rotation_at
  ));
end;
$$;

revoke all on function public.complete_proxy_provisioning(bigint, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_proxy_provisioning(bigint, text, text, text, text, integer, timestamptz) to service_role;
