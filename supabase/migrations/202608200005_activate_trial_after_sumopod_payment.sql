-- A paid, verified Sumopod top-up upgrades a trial account in the same
-- transaction as the wallet credit. This is deliberately inside the RPC so
-- browser state and untrusted checkout data can never activate an account.

-- Bring previously completed, verified Sumopod invoices in line with the same
-- rule. No pending, failed, or expired invoice can activate a trial profile.
update public.profiles profile
set is_trial = false
where profile.is_trial is true
  and exists (
    select 1
    from public.payment_invoices invoice
    where invoice.profile_id = profile.id
      and invoice.status = 'completed'
  );

create or replace function public.complete_sumopod_credit_payment(
  target_merchant_order_id text,
  target_payment_id text,
  target_event_id text,
  target_amount_idr numeric,
  target_fee_idr numeric,
  target_net_amount_idr numeric,
  target_currency text,
  target_completed_at timestamptz
) returns numeric
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  invoice public.payment_invoices%rowtype;
  next_balance numeric;
begin
  if target_merchant_order_id is null or target_merchant_order_id !~ '^NODENESIA-SUMO-[0-9a-f-]{36}$' then
    raise exception 'Invalid Sumopod order ID';
  end if;
  if target_payment_id is null or length(target_payment_id) > 200 then
    raise exception 'Invalid Sumopod payment ID';
  end if;
  if target_event_id is null or length(target_event_id) > 200 then
    raise exception 'Invalid Sumopod event ID';
  end if;
  if target_currency <> 'IDR' or target_amount_idr <= 0 then
    raise exception 'Invalid Sumopod payment amount';
  end if;
  if target_fee_idr is not null and (target_fee_idr < 0 or trunc(target_fee_idr) <> target_fee_idr) then
    raise exception 'Invalid Sumopod payment fee';
  end if;
  if target_net_amount_idr is not null and (target_net_amount_idr <= 0 or trunc(target_net_amount_idr) <> target_net_amount_idr) then
    raise exception 'Invalid Sumopod net payment amount';
  end if;

  select * into invoice
  from public.payment_invoices
  where merchant_order_id = target_merchant_order_id
  for update;
  if not found then raise exception 'Sumopod invoice not found'; end if;

  if invoice.status = 'completed' then
    if invoice.provider_payment_id <> target_payment_id then
      raise exception 'Sumopod payment ID conflicts with completed invoice';
    end if;
    select balance into next_balance from public.credit_wallets where profile_id = invoice.profile_id;
    return next_balance;
  end if;
  if invoice.status <> 'pending' or invoice.expires_at <= now() then
    raise exception 'Sumopod invoice is no longer payable';
  end if;
  if invoice.provider_payment_id is not null and invoice.provider_payment_id <> target_payment_id then
    raise exception 'Sumopod payment ID conflicts with invoice';
  end if;
  if invoice.amount_idr <> target_amount_idr then
    raise exception 'Sumopod payment amount does not match invoice';
  end if;
  if invoice.net_amount_idr is null then
    raise exception 'Sumopod invoice settlement is not ready';
  end if;
  if target_fee_idr is not null and invoice.provider_fee_idr <> target_fee_idr then
    raise exception 'Sumopod payment fee does not match invoice';
  end if;
  if target_net_amount_idr is not null and invoice.net_amount_idr <> target_net_amount_idr then
    raise exception 'Sumopod net payment amount does not match invoice';
  end if;

  insert into public.credit_wallets(profile_id) values (invoice.profile_id) on conflict do nothing;
  select balance + invoice.credit_amount into next_balance
  from public.credit_wallets
  where profile_id = invoice.profile_id
  for update;
  update public.credit_wallets
  set balance = next_balance, updated_at = now()
  where profile_id = invoice.profile_id;

  update public.profiles
  set is_trial = false
  where id = invoice.profile_id and is_trial is true;

  update public.payment_invoices
  set status = 'completed', provider_payment_id = target_payment_id,
      provider_event_id = target_event_id, completed_at = coalesce(target_completed_at, now()), updated_at = now()
  where id = invoice.id;

  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values (
    invoice.profile_id, invoice.credit_amount, next_balance, 'payment_topup',
    'sumopod:' || invoice.id::text,
    format(
      'Sumopod payment %s (paid %s IDR, fee %s IDR, credited from %s IDR)',
      target_payment_id, invoice.amount_idr, coalesce(invoice.provider_fee_idr, 0), invoice.net_amount_idr
    )
  );
  return next_balance;
end;
$$;

revoke all on function public.complete_sumopod_credit_payment(text, text, text, numeric, numeric, numeric, text, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_sumopod_credit_payment(text, text, text, numeric, numeric, numeric, text, timestamptz) to service_role;
