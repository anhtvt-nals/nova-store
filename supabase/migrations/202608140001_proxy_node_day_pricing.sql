-- Proxy orders are priced by an admin-managed product price per node per day.
alter table public.orders
  add column order_group_id uuid,
  add column rental_days integer not null default 1 check (rental_days between 1 and 365),
  add column unit_price numeric(12,2) check (unit_price is null or unit_price >= 0);

create index orders_group_idx on public.orders(order_group_id);

-- Give the existing proxy a usable initial daily price. Admin can change it in Catalog.
update public.products p
set base_price = coalesce((select min(pl.price) from public.plans pl where pl.product_id = p.id), 0)
where p.service_type = 'proxy' and p.base_price = 0;

create or replace function public.create_proxy_orders(
  target_profile_id bigint,
  target_plan_id bigint,
  requested_nodes integer,
  requested_days integer,
  requested_payment_method text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_plan record;
  selected_resource_ids bigint[];
  new_group_id uuid := gen_random_uuid();
begin
  if requested_nodes < 1 or requested_nodes > 100 then raise exception 'Node quantity must be between 1 and 100'; end if;
  if requested_days < 1 or requested_days > 365 then raise exception 'Rental days must be between 1 and 365'; end if;
  if requested_payment_method not in ('bank_transfer', 'crypto') then raise exception 'Unsupported payment method'; end if;

  select pl.id, pl.product_id, pl.name, p.name as product_name, p.base_price, p.currency, p.service_type
  into selected_plan
  from public.plans pl
  join public.products p on p.id = pl.product_id
  where pl.id = target_plan_id and pl.is_active = true and p.is_active = true;

  if not found then raise exception 'Plan not found'; end if;
  if selected_plan.service_type <> 'proxy' then raise exception 'Node/day pricing is only available for proxy products'; end if;
  if selected_plan.base_price <= 0 then raise exception 'Proxy daily price has not been configured'; end if;

  select array_agg(available.id)
  into selected_resource_ids
  from (
    select r.id
    from public.resources r
    where r.product_id = selected_plan.product_id
      and r.status = 'online'
      and not exists (
        select 1 from public.orders existing
        where existing.resource_id = r.id
          and (existing.status = 'pending' or (existing.status = 'active' and (existing.expires_at is null or existing.expires_at > now())))
      )
    order by r.id
    for update skip locked
    limit requested_nodes
  ) available;

  if coalesce(array_length(selected_resource_ids, 1), 0) < requested_nodes then
    raise exception 'Not enough proxy nodes are currently available';
  end if;

  insert into public.orders(
    order_group_id, profile_id, plan_id, resource_id, status, payment_method,
    amount, currency, unit_price, rental_days, plan_name_snapshot, resource_name_snapshot
  )
  select
    new_group_id, target_profile_id, selected_plan.id, r.id, 'pending', requested_payment_method,
    selected_plan.base_price * requested_days, selected_plan.currency, selected_plan.base_price,
    requested_days, selected_plan.name, r.name
  from public.resources r
  where r.id = any(selected_resource_ids);

  return new_group_id;
end;
$$;

create or replace function public.transition_order(
  target_order_id bigint,
  next_status text,
  actor_profile_id bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_order public.orders%rowtype;
begin
  if next_status not in ('active', 'rejected') then raise exception 'Unsupported order transition'; end if;
  select * into current_order from public.orders where id = target_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if current_order.status <> 'pending' then raise exception 'Only pending orders can be reviewed'; end if;

  if next_status = 'active' then
    update public.orders
    set status = 'active', activated_at = now(), expires_at = now() + make_interval(days => current_order.rental_days)
    where id = target_order_id;
  else
    update public.orders set status = 'rejected' where id = target_order_id;
  end if;

  insert into public.activity_logs(actor_profile_id, event_type, entity_type, entity_id, description, tone)
  values (actor_profile_id,
    case when next_status = 'active' then 'order_approved' else 'order_rejected' end,
    'order', target_order_id, format('Order #%s was %s', target_order_id, next_status),
    case when next_status = 'active' then 'success' else 'warning' end);
end;
$$;

revoke all on function public.create_proxy_orders(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_orders(bigint, bigint, integer, integer, text) to service_role;
grant execute on function public.transition_order(bigint, text, bigint) to service_role;
