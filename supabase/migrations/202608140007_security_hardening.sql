-- Security hardening: prevent email-based profile takeover, expire abandoned
-- reservations, include provisioning orders in inventory locks, and prevent
-- two live nodes from sharing the same public tunnel endpoint.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles(auth_user_id, email, name, role)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    'client'
  )
  on conflict (email) do update
    set name = excluded.name,
        updated_at = now()
    where public.profiles.auth_user_id = excluded.auth_user_id;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

alter table public.orders
  add column if not exists pending_expires_at timestamptz;

alter table public.orders
  alter column pending_expires_at set default (now() + interval '30 minutes');

update public.orders
set pending_expires_at = created_at + interval '30 minutes'
where status = 'pending' and pending_expires_at is null;

create index if not exists orders_pending_expiry_idx
  on public.orders(pending_expires_at)
  where status = 'pending';

-- Fail the migration rather than silently allowing an unsafe duplicate port.
create unique index if not exists proxy_nodes_live_tunnel_endpoint_uidx
  on public.proxy_nodes(lower(public_host), tunnel_port)
  where public_host is not null
    and tunnel_port is not null
    and status in ('queued', 'provisioning', 'online', 'rotating', 'degraded', 'offline', 'error', 'terminating');

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
  selected_resource_ids bigint[];
  new_group_id uuid := gen_random_uuid();
  pending_groups integer;
begin
  if requested_nodes < 1 or requested_nodes > 100 then raise exception 'Node quantity must be between 1 and 100'; end if;
  if requested_days < 1 or requested_days > 365 then raise exception 'Rental days must be between 1 and 365'; end if;
  if requested_payment_method not in ('bank_transfer', 'crypto') then raise exception 'Unsupported payment method'; end if;
  if not exists (select 1 from public.profiles where id = target_profile_id and status = 'active') then
    raise exception 'Customer account is not active';
  end if;

  -- Release abandoned reservations before allocating inventory.
  update public.orders
  set status = 'cancelled'
  where status = 'pending' and pending_expires_at <= now();

  select count(distinct order_group_id) into pending_groups
  from public.orders
  where profile_id = target_profile_id
    and status = 'pending'
    and pending_expires_at > now();
  if pending_groups >= 3 then raise exception 'Too many pending orders'; end if;

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
          and (
            (existing.status = 'pending' and existing.pending_expires_at > now())
            or existing.status = 'provisioning'
            or (existing.status = 'active' and (existing.expires_at is null or existing.expires_at > now()))
          )
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
    amount, currency, unit_price, rental_days, plan_name_snapshot, resource_name_snapshot,
    pending_expires_at
  )
  select
    new_group_id, target_profile_id, selected_product.id, null, r.id, 'pending', requested_payment_method,
    selected_product.base_price * requested_days, selected_product.currency, selected_product.base_price,
    requested_days, selected_product.name, r.name, now() + interval '30 minutes'
  from public.resources r
  where r.id = any(selected_resource_ids);

  return new_group_id;
end;
$$;

revoke all on function public.create_proxy_orders(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_orders(bigint, bigint, integer, integer, text) to service_role;

revoke create on schema public from public;

create or replace function public.renew_proxy_provisioning_lease(
  target_job_id bigint,
  worker_id text,
  lock_seconds integer default 180
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected integer;
begin
  update public.proxy_provisioning_jobs
  set locked_until = now() + make_interval(secs => greatest(30, lock_seconds))
  where id = target_job_id and status = 'running' and locked_by = worker_id;
  get diagnostics affected = row_count;
  if affected = 1 then
    update public.provider_capacity_leases l
    set lease_expires_at = greatest(l.lease_expires_at, now() + make_interval(secs => greatest(60, lock_seconds)))
    from public.proxy_provisioning_jobs j
    where j.id = target_job_id and l.node_id = j.node_id and l.released_at is null;
  end if;
  return affected = 1;
end;
$$;

revoke all on function public.renew_proxy_provisioning_lease(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.renew_proxy_provisioning_lease(bigint, text, integer) to service_role;

-- Capacity is enforced globally in Postgres, so adding Nest replicas cannot
-- multiply a provider's configured concurrent provisioning allowance.
create or replace function public.reserve_provider_capacity(
  target_node_id bigint,
  worker_id text,
  lease_seconds integer default 300,
  target_purpose text default 'customer'
) returns table(lease_id uuid, selected_provider_id bigint, selected_api_key_id bigint, provider_code text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  provider_row public.proxy_providers%rowtype;
  key_row public.provider_api_keys%rowtype;
  provider_used integer;
  provider_provisioning integer;
  provider_limit integer;
begin
  if target_purpose not in ('customer', 'replacement') then raise exception 'Unsupported capacity purpose'; end if;
  update public.provider_capacity_leases set status = 'released', released_at = now()
  where released_at is null and lease_expires_at < now();

  return query
  select l.id, l.provider_id, l.provider_api_key_id, p.code
  from public.provider_capacity_leases l join public.proxy_providers p on p.id = l.provider_id
  where l.node_id = target_node_id and l.purpose = target_purpose and l.released_at is null
  limit 1;
  if found then return; end if;

  for provider_row in
    select p.* from public.proxy_providers p
    where p.status = 'active'
    order by case when (p.metadata ->> 'priority') ~ '^-?[0-9]+$' then (p.metadata ->> 'priority')::integer else 100 end, p.id
    for update skip locked
  loop
    select count(*) into provider_used from public.provider_capacity_leases
    where provider_id = provider_row.id and released_at is null and lease_expires_at >= now();
    select count(*) into provider_provisioning from public.provider_capacity_leases
    where provider_id = provider_row.id and status = 'reserved' and released_at is null and lease_expires_at >= now();
    if provider_provisioning >= provider_row.max_concurrent_provisions then continue; end if;

    provider_limit := provider_row.max_sandboxes;
    if provider_limit is not null and target_purpose = 'customer' then
      provider_limit := greatest(0, provider_limit - provider_row.reserved_replacement_slots);
    end if;
    if provider_limit is not null and provider_used >= provider_limit then continue; end if;

    select k.* into key_row
    from public.provider_api_keys k
    where k.provider_id = provider_row.id and k.status = 'active'
      and (
        k.max_sandboxes is null or
        (select count(*) from public.provider_capacity_leases l where l.provider_api_key_id = k.id and l.released_at is null and l.lease_expires_at >= now()) < k.max_sandboxes
      )
    order by k.created_at, k.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    insert into public.provider_capacity_leases(provider_id, provider_api_key_id, node_id, purpose, leased_by, lease_expires_at)
    values (provider_row.id, key_row.id, target_node_id, target_purpose, worker_id, now() + make_interval(secs => greatest(60, lease_seconds)))
    returning id into lease_id;
    selected_provider_id := provider_row.id;
    selected_api_key_id := key_row.id;
    provider_code := provider_row.code;
    return next;
    return;
  end loop;
end;
$$;

revoke all on function public.reserve_provider_capacity(bigint, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_provider_capacity(bigint, text, integer, text) to service_role;
