-- Sumopod payments are recorded server-side before a payment link is returned.
-- A completed webhook can credit a wallet exactly once, even when Sumopod retries.

create table if not exists public.payment_invoices (
  id uuid primary key default gen_random_uuid(),
  profile_id bigint not null references public.profiles(id) on delete restrict,
  provider text not null check (provider in ('sumopod')),
  merchant_order_id text not null unique check (merchant_order_id ~ '^NODENESIA-SUMO-[0-9a-f-]{36}$'),
  provider_payment_id text unique,
  amount_idr numeric(18,0) not null check (amount_idr >= 10000 and amount_idr <= 10000000),
  credit_amount numeric(18,2) not null check (credit_amount > 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'expired')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  provider_event_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_invoices_profile_created_idx
  on public.payment_invoices(profile_id, created_at desc);

alter table public.credit_ledger drop constraint if exists credit_ledger_type_check;
alter table public.credit_ledger add constraint credit_ledger_type_check
  check (type in ('trial_grant', 'admin_grant', 'admin_adjustment', 'order_debit', 'refund', 'payment_topup'));

create or replace function public.complete_sumopod_credit_payment(
  target_merchant_order_id text,
  target_payment_id text,
  target_event_id text,
  target_amount_idr numeric,
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

  insert into public.credit_wallets(profile_id) values (invoice.profile_id) on conflict do nothing;
  select balance + invoice.credit_amount into next_balance
  from public.credit_wallets
  where profile_id = invoice.profile_id
  for update;
  update public.credit_wallets
  set balance = next_balance, updated_at = now()
  where profile_id = invoice.profile_id;

  update public.payment_invoices
  set status = 'completed', provider_payment_id = target_payment_id,
      provider_event_id = target_event_id, completed_at = coalesce(target_completed_at, now()), updated_at = now()
  where id = invoice.id;

  insert into public.credit_ledger(profile_id, amount, balance_after, type, reference, note)
  values (
    invoice.profile_id, invoice.credit_amount, next_balance, 'payment_topup',
    'sumopod:' || invoice.id::text,
    format('Sumopod payment %s (%s IDR)', target_payment_id, invoice.amount_idr)
  );
  return next_balance;
end;
$$;

alter table public.payment_invoices enable row level security;
revoke all on public.payment_invoices from anon, authenticated;
revoke all on function public.complete_sumopod_credit_payment(text, text, text, numeric, text, timestamptz) from public, anon, authenticated;
grant all on public.payment_invoices to service_role;
grant execute on function public.complete_sumopod_credit_payment(text, text, text, numeric, text, timestamptz) to service_role;
