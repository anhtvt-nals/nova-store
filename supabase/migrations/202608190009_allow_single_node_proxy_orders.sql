-- The client offers one-node rentals for normal accounts as well as the
-- existing trial one-node package. Keep the database validation authoritative
-- while making that advertised quantity valid.

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
  profile_row public.profiles%rowtype;
  new_order_id bigint;
  total_usd numeric;
  credit_cost numeric;
  credit_rate numeric;
  wallet_balance numeric;
begin
  if requested_payment_method <> 'credit' then
    raise exception 'Credit is the only supported payment method';
  end if;

  select * into profile_row
  from public.profiles
  where id = target_profile_id and status = 'active'
  for update;
  if not found then
    raise exception 'Customer account is not active';
  end if;

  select id, name, base_price, currency, service_type, proxy_type
  into selected_product
  from public.products
  where id = target_product_id and is_active = true
  for share;
  if not found
    or selected_product.service_type <> 'proxy'
    or selected_product.base_price <= 0
    or selected_product.currency <> 'USD' then
    raise exception 'Proxy product is unavailable';
  end if;

  if selected_product.proxy_type = 'residential' and profile_row.is_trial then
    raise exception 'Residential proxy is not available for trial accounts';
  end if;

  if profile_row.is_trial then
    if requested_nodes <> 1 or requested_days <> 1 then
      raise exception 'Trial accounts can rent exactly one datacenter node for one day';
    end if;
  elsif requested_nodes <> all(array[1, 5, 10, 20, 30])
    or requested_days <> all(array[1, 3, 7, 15, 30]) then
    raise exception 'Unsupported node quantity or rental days';
  end if;

  total_usd := selected_product.base_price * requested_nodes * requested_days;
  credit_rate := coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'credits_per_usd'), 100);
  if credit_rate <= 0 then
    raise exception 'Credit conversion rate is not configured';
  end if;
  credit_cost := ceil(total_usd * credit_rate * 100) / 100;

  insert into public.credit_wallets(profile_id)
  values (target_profile_id)
  on conflict do nothing;
  select balance into wallet_balance
  from public.credit_wallets
  where profile_id = target_profile_id
  for update;
  if wallet_balance < credit_cost then
    raise exception 'Insufficient credit balance';
  end if;

  insert into public.orders(
    order_group_id, profile_id, product_id, plan_id, resource_id, status,
    payment_method, amount, currency, unit_price, node_count, rental_days,
    plan_name_snapshot, resource_name_snapshot, pending_expires_at, credits_charged
  ) values (
    gen_random_uuid(), target_profile_id, selected_product.id, null, null, 'pending',
    'credit', total_usd, 'USD', selected_product.base_price, requested_nodes, requested_days,
    selected_product.name, format('%s %s nodes', requested_nodes, selected_product.proxy_type),
    now() + interval '30 minutes', credit_cost
  ) returning id into new_order_id;

  update public.credit_wallets
  set balance = balance - credit_cost, updated_at = now()
  where profile_id = target_profile_id
  returning balance into wallet_balance;

  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values (
    target_profile_id, -credit_cost, wallet_balance, 'order_debit',
    'order:' || new_order_id::text,
    format('%s proxy order #%s', selected_product.proxy_type, new_order_id)
  );

  perform public.transition_order(new_order_id, 'active', target_profile_id);
  return new_order_id;
end;
$$;

revoke all on function public.create_proxy_order(bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.create_proxy_order(bigint, bigint, integer, integer, text) to service_role;
