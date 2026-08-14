-- Proxy orders describe demand only. Compute capacity and tunnel endpoints are
-- allocated after an administrator approves each order.

alter table public.orders alter column resource_id drop not null;

create or replace function public.create_proxy_orders(
  target_profile_id bigint,
  target_product_id bigint,
  requested_nodes integer,
  requested_days integer,
  requested_payment_method text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  selected_product record;
  new_group_id uuid := gen_random_uuid();
  pending_groups integer;
begin
  if requested_nodes < 1 or requested_nodes > 100 then raise exception 'Node quantity must be between 1 and 100'; end if;
  if requested_days < 1 or requested_days > 365 then raise exception 'Rental days must be between 1 and 365'; end if;
  if requested_payment_method not in ('bank_transfer', 'crypto') then raise exception 'Unsupported payment method'; end if;
  if not exists (select 1 from public.profiles where id = target_profile_id and status = 'active') then
    raise exception 'Customer account is not active';
  end if;

  update public.orders set status = 'cancelled'
  where status = 'pending' and pending_expires_at <= now();

  select count(distinct order_group_id) into pending_groups
  from public.orders
  where profile_id = target_profile_id and status = 'pending' and pending_expires_at > now();
  if pending_groups >= 3 then raise exception 'Too many pending orders'; end if;

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
    amount, currency, unit_price, rental_days, plan_name_snapshot, resource_name_snapshot,
    pending_expires_at
  )
  select
    new_group_id, target_profile_id, selected_product.id, null, null, 'pending', requested_payment_method,
    selected_product.base_price * requested_days, selected_product.currency, selected_product.base_price,
    requested_days, selected_product.name,
    format('%s node %s', selected_product.name, node_number),
    now() + interval '30 minutes'
  from generate_series(1, requested_nodes) as node_number;

  return new_group_id;
end;
$$;

revoke all on function public.create_proxy_orders(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_orders(bigint, bigint, integer, integer, text) to service_role;

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

    insert into public.proxy_nodes(order_id, profile_id, provider_id, status, public_host, tunnel_port, expires_at, metadata)
    values (
      current_order.id, current_order.profile_id, null, 'queued', null, null, null,
      jsonb_build_object('productId', current_order.product_id)
    )
    on conflict (order_id) do update
      set status = 'queued', error_code = null, error_message = null, updated_at = now()
    returning id into new_node_id;

    insert into public.proxy_provisioning_jobs(node_id, action, status, run_after)
    values (new_node_id, 'provision', 'queued', now())
    on conflict (node_id, action) do update
      set status = 'queued', run_after = now(), last_error = null, updated_at = now();

    insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
    values (new_node_id, current_order.profile_id, 'proxy.node.queued', jsonb_build_object('nodeId', new_node_id, 'status', 'queued'));
  else
    update public.orders set status = 'rejected' where id = target_order_id;
  end if;

  insert into public.activity_logs(actor_profile_id, event_type, entity_type, entity_id, description, tone)
  values (
    actor_profile_id,
    case when next_status = 'active' then 'order_approved_for_provisioning' else 'order_rejected' end,
    'order', target_order_id,
    case when next_status = 'active' then format('Order #%s was approved and queued for provisioning', target_order_id) else format('Order #%s was rejected', target_order_id) end,
    case when next_status = 'active' then 'success' else 'warning' end
  );
end;
$$;

revoke all on function public.transition_order(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.transition_order(bigint, text, bigint) to service_role;

create or replace function public.allocate_proxy_tunnel_endpoint(
  target_node_id bigint,
  worker_id text,
  target_public_host text,
  first_port integer,
  last_port integer
) returns table(assigned_host text, assigned_port integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  node_row public.proxy_nodes%rowtype;
  selected_port integer;
begin
  if nullif(trim(target_public_host), '') is null then raise exception 'Public proxy host is required'; end if;
  if first_port < 1024 or last_port > 65535 or first_port > last_port or last_port - first_port > 10000 then
    raise exception 'Invalid proxy tunnel port range';
  end if;

  perform pg_advisory_xact_lock(hashtext(lower(target_public_host)));
  select * into node_row from public.proxy_nodes where id = target_node_id for update;
  if not found then raise exception 'Proxy node not found'; end if;

  if node_row.public_host is not null and node_row.tunnel_port is not null then
    return query select node_row.public_host, node_row.tunnel_port;
    return;
  end if;

  if not exists (
    select 1 from public.provider_capacity_leases
    where node_id = target_node_id and leased_by = worker_id and released_at is null and lease_expires_at >= now()
  ) then raise exception 'Worker does not own provider capacity for this node'; end if;

  select candidate into selected_port
  from generate_series(first_port, last_port) candidate
  where not exists (
    select 1 from public.proxy_nodes n
    where lower(n.public_host) = lower(target_public_host)
      and n.tunnel_port = candidate
      and n.status in ('queued', 'provisioning', 'online', 'rotating', 'degraded', 'offline', 'error', 'terminating')
  )
  order by candidate
  limit 1;

  if selected_port is null then raise exception 'No proxy tunnel ports are available'; end if;
  update public.proxy_nodes
  set public_host = target_public_host, tunnel_port = selected_port
  where id = target_node_id;
  return query select target_public_host, selected_port;
end;
$$;

revoke all on function public.allocate_proxy_tunnel_endpoint(bigint, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.allocate_proxy_tunnel_endpoint(bigint, text, text, integer, integer) to service_role;
