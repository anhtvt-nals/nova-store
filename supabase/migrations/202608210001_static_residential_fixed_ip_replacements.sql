-- Static residential endpoints are now sticky. An order keeps each assigned
-- upstream until the customer explicitly consumes one of its five IP
-- replacements. Automatic hourly rotation is intentionally retired.
alter table public.static_residential_nodes
  alter column next_upstream_rotation_at drop not null,
  alter column next_upstream_rotation_at drop default;

update public.static_residential_nodes
set next_upstream_rotation_at = null
where next_upstream_rotation_at is not null;

drop index if exists public.static_residential_nodes_rotation_idx;

alter table public.static_residential_orders
  add column if not exists replacement_count integer not null default 0;

alter table public.static_residential_orders
  drop constraint if exists static_residential_orders_replacement_count_check;
alter table public.static_residential_orders
  add constraint static_residential_orders_replacement_count_check
  check (replacement_count between 0 and 5);

-- Keep allocation and replacement serialized per profile. An upstream can be
-- shared by different customers, but never by two live ports belonging to the
-- same customer. This is enforced in the database rather than trusted to the
-- API/UI.
create or replace function public.create_static_residential_order_v2(
  target_profile_id bigint,
  requested_days integer,
  requested_quota_gb integer
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  ids bigint[];
  oid bigint;
  price numeric;
  rate numeric;
  cost numeric;
  wallet_balance numeric;
  expiry timestamptz;
  port_value integer;
  i integer;
begin
  if requested_days not in (1, 3, 7, 15, 30) then
    raise exception 'Rental days must be one of: 1, 3, 7, 15, or 30';
  end if;
  if requested_quota_gb not in (1, 3, 5) then
    raise exception 'Quota must be 1GB, 3GB, or 5GB';
  end if;

  perform 1 from public.profiles where id = target_profile_id for update;
  if not found then raise exception 'Profile not found'; end if;
  if exists(select 1 from public.profiles where id = target_profile_id and is_trial) then
    raise exception 'Static residential proxy is not available for trial accounts';
  end if;
  if exists(
    select 1 from public.static_residential_orders
    where profile_id = target_profile_id and status = 'active' and expires_at > now()
  ) then
    raise exception 'An active static residential order already exists';
  end if;

  select array_agg(candidate.id order by candidate.id) into ids
  from (
    select p.id
    from public.static_residential_proxies p
    where p.status = 'available'
      and not exists (
        select 1
        from public.static_residential_nodes n
        join public.static_residential_orders o on o.id = n.order_id
        where o.profile_id = target_profile_id
          and o.status = 'active'
          and o.expires_at > now()
          and n.status in ('active', 'suspended')
          and n.upstream_proxy_id = p.id
      )
    order by random()
    for update skip locked
    limit 5
  ) candidate;
  if coalesce(array_length(ids, 1), 0) <> 5 then
    raise exception 'No capacity: five distinct static residential proxies are required';
  end if;

  select coalesce((value #>> '{}')::numeric, 0) into price
  from public.app_settings where key = 'static_residential_price_per_gb_day';
  select coalesce((value #>> '{}')::numeric, 100) into rate
  from public.app_settings where key = 'credits_per_usd';
  if price <= 0 or rate <= 0 then raise exception 'Static residential pricing is not configured'; end if;

  cost := ceil(price * requested_quota_gb * requested_days * rate * 100) / 100;
  insert into public.credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select balance into wallet_balance from public.credit_wallets where profile_id = target_profile_id for update;
  if wallet_balance < cost then raise exception 'Insufficient credit balance'; end if;

  expiry := now() + make_interval(days => requested_days);
  insert into public.static_residential_orders(profile_id, node_count, quota_bytes, price_per_gb_day, amount, credit_cost, expires_at)
  values(target_profile_id, 5, requested_quota_gb::bigint * 1073741824, price, round(price * requested_quota_gb * requested_days, 4), cost, expiry)
  returning id into oid;

  update public.credit_wallets set balance = balance - cost, updated_at = now()
  where profile_id = target_profile_id returning balance into wallet_balance;
  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values(target_profile_id, -cost, wallet_balance, 'order_debit', 'static-residential:' || oid,
    'Static residential order #' || oid || ' (' || requested_quota_gb || 'GB, ' || requested_days || ' days)');

  for i in 1..5 loop
    select g into port_value
    from generate_series(10000, 20000) g
    where not exists (select 1 from public.static_residential_nodes where public_port = g)
    order by g limit 1;
    if port_value is null then raise exception 'No public static proxy port is available'; end if;
    insert into public.static_residential_nodes(order_id, upstream_proxy_id, public_port, service_name, next_upstream_rotation_at)
    values(oid, ids[i], port_value, 'static-residential-node-' || oid || '-' || i, null);
  end loop;
  return oid;
end $$;

create or replace function public.replace_static_residential_node_v3(
  target_profile_id bigint,
  target_order_id bigint,
  target_node_id bigint
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  order_row public.static_residential_orders%rowtype;
  node_row public.static_residential_nodes%rowtype;
  replacement_id bigint;
begin
  perform 1 from public.profiles where id = target_profile_id for update;
  if not found then raise exception 'Profile not found'; end if;

  select * into order_row
  from public.static_residential_orders
  where id = target_order_id and profile_id = target_profile_id
  for update;
  if not found then raise exception 'Static residential order not found'; end if;
  if order_row.status <> 'active' or order_row.expires_at <= now() then
    raise exception 'Only an active static residential order can replace an IP';
  end if;
  if order_row.replacement_count >= 5 then
    raise exception 'This static residential order has used all 5 IP replacements';
  end if;

  select * into node_row
  from public.static_residential_nodes
  where id = target_node_id and order_id = target_order_id
  for update;
  if not found then raise exception 'Static residential node not found'; end if;

  select candidate.id into replacement_id
  from (
    select p.id
    from public.static_residential_proxies p
    where p.status = 'available'
      and p.id <> node_row.upstream_proxy_id
      and not exists (
        select 1
        from public.static_residential_nodes n
        join public.static_residential_orders o on o.id = n.order_id
        where o.profile_id = target_profile_id
          and o.status = 'active'
          and o.expires_at > now()
          and n.id <> node_row.id
          and n.status in ('active', 'suspended')
          and n.upstream_proxy_id = p.id
      )
    order by random()
    for update skip locked
    limit 1
  ) candidate;
  if replacement_id is null then
    raise exception 'No distinct static residential replacement IP is available';
  end if;

  update public.static_residential_nodes
  set upstream_proxy_id = replacement_id,
      status = 'active',
      last_upstream_rotation_at = now(),
      next_upstream_rotation_at = null,
      metric_bytes_observed = 0,
      updated_at = now()
  where id = node_row.id;

  update public.static_residential_orders
  set replacement_count = replacement_count + 1, updated_at = now()
  where id = order_row.id
  returning replacement_count into order_row.replacement_count;

  return order_row.replacement_count;
end $$;

revoke all on function public.create_static_residential_order_v2(bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.create_static_residential_order_v2(bigint, integer, integer) to service_role;
revoke all on function public.replace_static_residential_node_v3(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.replace_static_residential_node_v3(bigint, bigint, bigint) to service_role;
