-- Avoid PL/pgSQL variable/column ambiguity in the static residential credit
-- checkout path. Both functions run as SECURITY DEFINER, so the debit remains
-- atomic while locking the customer's wallet row.

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
  if requested_days not in (1, 3, 7, 15, 30) then raise exception 'Rental days must be one of: 1, 3, 7, 15, or 30'; end if;
  if requested_quota_gb not in (1, 3, 5) then raise exception 'Quota must be 1GB, 3GB, or 5GB'; end if;
  if exists(select 1 from public.profiles p where p.id = target_profile_id and p.is_trial) then raise exception 'Static residential proxy is not available for trial accounts'; end if;
  if exists(select 1 from public.static_residential_orders o where o.profile_id = target_profile_id and o.status = 'active' and o.expires_at > now()) then raise exception 'An active static residential order already exists'; end if;

  select array_agg(candidate.id) into ids
  from (select p.id from public.static_residential_proxies p where p.status <> 'disabled' order by random() limit 5) candidate;
  if coalesce(array_length(ids, 1), 0) <> 5 then raise exception 'No capacity: five static residential proxies are required'; end if;

  select coalesce((s.value #>> '{}')::numeric, 0) into price from public.app_settings s where s.key = 'static_residential_price_per_gb_day';
  select coalesce((s.value #>> '{}')::numeric, 100) into rate from public.app_settings s where s.key = 'credits_per_usd';
  if price <= 0 or rate <= 0 then raise exception 'Static residential pricing is not configured'; end if;
  cost := ceil(price * requested_quota_gb * requested_days * rate * 100) / 100;

  insert into public.credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select cw.balance into wallet_balance from public.credit_wallets cw where cw.profile_id = target_profile_id for update;
  if wallet_balance < cost then raise exception 'Insufficient credit balance'; end if;

  expiry := now() + make_interval(days => requested_days);
  insert into public.static_residential_orders(profile_id, node_count, quota_bytes, price_per_gb_day, amount, credit_cost, expires_at)
  values(target_profile_id, 5, requested_quota_gb::bigint * 1073741824, price, round(price * requested_quota_gb * requested_days, 4), cost, expiry)
  returning id into oid;

  update public.credit_wallets cw set balance = cw.balance - cost, updated_at = now()
  where cw.profile_id = target_profile_id returning cw.balance into wallet_balance;
  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values(target_profile_id, -cost, wallet_balance, 'order_debit', 'static-residential:' || oid, 'Static residential order #' || oid || ' (' || requested_quota_gb || 'GB, ' || requested_days || ' days)');

  for i in 1..5 loop
    select g into port_value from generate_series(10000, 20000) g
    where not exists(select 1 from public.static_residential_nodes n where n.public_port = g)
    order by g limit 1;
    if port_value is null then raise exception 'No public static proxy port is available'; end if;
    insert into public.static_residential_nodes(order_id, upstream_proxy_id, public_port, service_name)
    values(oid, ids[i], port_value, 'static-residential-node-' || oid || '-' || i);
  end loop;
  return oid;
end $$;

create or replace function public.extend_static_residential_order_v2(
  target_profile_id bigint,
  target_order_id bigint,
  requested_days integer
)
returns void language plpgsql security definer set search_path = public as $$
declare
  order_row public.static_residential_orders%rowtype;
  rate numeric;
  cost numeric;
  wallet_balance numeric;
  quota_gb numeric;
begin
  if requested_days not in (1, 3, 7, 15, 30) then raise exception 'Rental days must be one of: 1, 3, 7, 15, or 30'; end if;
  select * into order_row from public.static_residential_orders o where o.id = target_order_id and o.profile_id = target_profile_id for update;
  if not found then raise exception 'Static residential order not found'; end if;
  if order_row.status in ('cancelled', 'suspended') then raise exception 'Static residential order cannot be extended'; end if;
  quota_gb := order_row.quota_bytes::numeric / 1073741824;
  select coalesce((s.value #>> '{}')::numeric, 100) into rate from public.app_settings s where s.key = 'credits_per_usd';
  cost := ceil(order_row.price_per_gb_day * quota_gb * requested_days * rate * 100) / 100;

  insert into public.credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select cw.balance into wallet_balance from public.credit_wallets cw where cw.profile_id = target_profile_id for update;
  if wallet_balance < cost then raise exception 'Insufficient credit balance'; end if;
  update public.credit_wallets cw set balance = cw.balance - cost, updated_at = now()
  where cw.profile_id = target_profile_id returning cw.balance into wallet_balance;

  update public.static_residential_orders set expires_at = greatest(expires_at, now()) + make_interval(days => requested_days), status = 'active', updated_at = now() where id = target_order_id;
  update public.static_residential_nodes set status = 'active', updated_at = now() where order_id = target_order_id;
  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values(target_profile_id, -cost, wallet_balance, 'order_extension_debit', 'static-residential:' || target_order_id, 'Static residential order #' || target_order_id || ' extended ' || requested_days || ' days (' || quota_gb || 'GB)');
end $$;

revoke all on function public.create_static_residential_order_v2(bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.create_static_residential_order_v2(bigint, integer, integer) to service_role;
revoke all on function public.extend_static_residential_order_v2(bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.extend_static_residential_order_v2(bigint, bigint, integer) to service_role;
