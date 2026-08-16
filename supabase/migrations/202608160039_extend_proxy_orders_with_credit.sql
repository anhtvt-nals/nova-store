-- Extension is server-owned: price, wallet debit and every expiry update are
-- performed under one transaction so browser requests cannot alter balances.

alter table public.credit_ledger
  drop constraint if exists credit_ledger_type_check;
alter table public.credit_ledger
  add constraint credit_ledger_type_check check (type in (
    'trial_grant', 'admin_grant', 'admin_adjustment', 'order_debit',
    'order_extension_debit', 'refund'
  ));

create or replace function public.extend_proxy_order(
  target_profile_id bigint,
  target_order_id bigint,
  requested_days integer
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  order_row public.orders%rowtype;
  profile_row public.profiles%rowtype;
  product_row public.products%rowtype;
  credit_rate numeric;
  credit_cost numeric;
  wallet_balance numeric;
  next_expiry timestamptz;
begin
  if requested_days <> all(array[1, 3, 7, 15, 30]) then
    raise exception 'Extension days must be one of: 1, 3, 7, 15, or 30';
  end if;

  select * into profile_row from public.profiles
  where id = target_profile_id and status = 'active'
  for update;
  if not found then raise exception 'Customer account is not active'; end if;
  if profile_row.is_trial then raise exception 'Upgrade to a regular account before extending a trial order'; end if;

  select * into order_row from public.orders
  where id = target_order_id and profile_id = target_profile_id and status = 'active'
  for update;
  if not found or order_row.expires_at is null or order_row.expires_at <= now() then
    raise exception 'Only an active, unexpired proxy order can be extended';
  end if;

  select * into product_row from public.products
  where id = order_row.product_id and is_active = true
  for share;
  if not found or product_row.service_type <> 'proxy' or product_row.currency <> 'USD' or product_row.base_price <= 0 then
    raise exception 'Proxy product is unavailable for credit extension';
  end if;

  credit_rate := coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'credits_per_usd'), 100);
  if credit_rate <= 0 then raise exception 'Credit conversion rate is not configured'; end if;
  credit_cost := ceil(product_row.base_price * order_row.node_count * requested_days * credit_rate * 100) / 100;

  insert into public.credit_wallets(profile_id) values (target_profile_id) on conflict do nothing;
  select balance into wallet_balance from public.credit_wallets where profile_id = target_profile_id for update;
  if wallet_balance < credit_cost then raise exception 'Insufficient credit balance'; end if;

  next_expiry := order_row.expires_at + make_interval(days => requested_days);
  update public.credit_wallets set balance = balance - credit_cost, updated_at = now()
  where profile_id = target_profile_id returning balance into wallet_balance;
  update public.orders set
    rental_days = rental_days + requested_days,
    amount = amount + (product_row.base_price * order_row.node_count * requested_days),
    credits_charged = credits_charged + credit_cost,
    expires_at = next_expiry
  where id = target_order_id;
  update public.proxy_nodes set expires_at = next_expiry
  where order_id = target_order_id and status not in ('terminated', 'terminating');
  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values (target_profile_id, -credit_cost, wallet_balance, 'order_extension_debit',
    format('order-extension:%s:%s', target_order_id, gen_random_uuid()),
    format('Extended proxy order #%s by %s day(s)', target_order_id, requested_days));
  return target_order_id;
end;
$$;

revoke all on function public.extend_proxy_order(bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.extend_proxy_order(bigint, bigint, integer) to service_role;
