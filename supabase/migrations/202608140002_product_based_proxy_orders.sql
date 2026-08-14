-- Proxy purchases belong directly to products; plans are not part of quote or ordering.
alter table public.orders add column product_id bigint references public.products(id) on delete restrict;

update public.orders o
set product_id = p.product_id
from public.plans p
where p.id = o.plan_id and o.product_id is null;

alter table public.orders alter column product_id set not null;
alter table public.orders alter column plan_id drop not null;
create index orders_product_status_idx on public.orders(product_id, status);

drop function if exists public.create_proxy_orders(bigint, bigint, integer, integer, text);

create or replace function public.create_proxy_orders(
  target_profile_id bigint,
  target_product_id bigint,
  requested_nodes integer,
  requested_days integer,
  requested_payment_method text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_product record;
  selected_resource_ids bigint[];
  new_group_id uuid := gen_random_uuid();
begin
  if requested_nodes < 1 or requested_nodes > 100 then raise exception 'Node quantity must be between 1 and 100'; end if;
  if requested_days < 1 or requested_days > 365 then raise exception 'Rental days must be between 1 and 365'; end if;
  if requested_payment_method not in ('bank_transfer', 'crypto') then raise exception 'Unsupported payment method'; end if;

  select id, name, base_price, currency, service_type
  into selected_product
  from public.products
  where id = target_product_id and is_active = true
  for share;

  if not found then raise exception 'Product not found'; end if;
  if selected_product.service_type <> 'proxy' then raise exception 'Node/day pricing is only available for proxy products'; end if;
  if selected_product.base_price <= 0 then raise exception 'Proxy daily price has not been configured'; end if;

  select array_agg(available.id)
  into selected_resource_ids
  from (
    select r.id
    from public.resources r
    where r.product_id = selected_product.id
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
    order_group_id, profile_id, product_id, plan_id, resource_id, status, payment_method,
    amount, currency, unit_price, rental_days, plan_name_snapshot, resource_name_snapshot
  )
  select
    new_group_id, target_profile_id, selected_product.id, null, r.id, 'pending', requested_payment_method,
    selected_product.base_price * requested_days, selected_product.currency, selected_product.base_price,
    requested_days, selected_product.name, r.name
  from public.resources r
  where r.id = any(selected_resource_ids);

  return new_group_id;
end;
$$;

revoke all on function public.create_proxy_orders(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_orders(bigint, bigint, integer, integer, text) to service_role;
