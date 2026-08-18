-- Telegram-gated onboarding. Existing profiles are grandfathered; every
-- profile created after this migration must verify Telegram before using the
-- authenticated application APIs or receiving trial credit.

alter table public.profiles
  add column if not exists onboarding_status text;

update public.profiles
set onboarding_status = 'verified'
where onboarding_status is null;

alter table public.profiles
  alter column onboarding_status set default 'telegram_pending',
  alter column onboarding_status set not null;

alter table public.profiles drop constraint if exists profiles_onboarding_status_check;
alter table public.profiles add constraint profiles_onboarding_status_check
  check (onboarding_status in ('telegram_pending', 'verified'));

alter table public.profiles
  add column if not exists telegram_user_id text,
  add column if not exists telegram_username text,
  add column if not exists telegram_first_name text,
  add column if not exists telegram_member_status text,
  add column if not exists telegram_verified_at timestamptz;

create unique index if not exists profiles_telegram_user_id_uidx
  on public.profiles(telegram_user_id)
  where telegram_user_id is not null;

create table if not exists public.telegram_verification_events (
  event_id text primary key,
  profile_id bigint not null references public.profiles(id) on delete restrict,
  telegram_user_id text not null,
  payload_hash text not null,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists telegram_verification_events_profile_idx
  on public.telegram_verification_events(profile_id, created_at desc);

-- New profiles still receive an empty server-owned wallet, but no credit is
-- granted until the signed Telegram callback is committed successfully.
create or replace function public.initialize_profile_credit_wallet()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.credit_wallets(profile_id)
  values (new.id)
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.verify_profile_telegram_trial(
  target_profile_id bigint,
  target_event_id text,
  target_telegram_user_id text,
  target_telegram_username text,
  target_telegram_first_name text,
  target_member_status text,
  target_payload_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  profile_row public.profiles%rowtype;
  existing_event public.telegram_verification_events%rowtype;
  trial_amount numeric := 0;
  next_balance numeric := 0;
  trial_granted boolean := false;
begin
  if target_event_id is null or length(target_event_id) < 8 or length(target_event_id) > 128 then
    raise exception 'Invalid Telegram verification event';
  end if;
  if target_telegram_user_id is null or target_telegram_user_id !~ '^[0-9]{1,32}$' then
    raise exception 'Invalid Telegram user ID';
  end if;
  if target_member_status not in ('member', 'administrator', 'creator') then
    raise exception 'Telegram group membership is not active';
  end if;

  select * into existing_event
  from public.telegram_verification_events
  where event_id = target_event_id;

  if found then
    if existing_event.profile_id <> target_profile_id
      or existing_event.telegram_user_id <> target_telegram_user_id
      or existing_event.payload_hash <> target_payload_hash then
      raise exception 'Telegram verification event has already been used';
    end if;
    select balance into next_balance
    from public.credit_wallets
    where profile_id = target_profile_id;
    return jsonb_build_object(
      'profileId', target_profile_id,
      'onboardingStatus', 'verified',
      'trialGranted', false,
      'balance', coalesce(next_balance, 0),
      'alreadyProcessed', true
    );
  end if;

  select * into profile_row
  from public.profiles
  where id = target_profile_id
  for update;

  if not found then raise exception 'Profile not found'; end if;
  if profile_row.status <> 'active' then raise exception 'Customer account is not active'; end if;
  if profile_row.role <> 'client' then raise exception 'Telegram onboarding is only available to client accounts'; end if;

  if exists (
    select 1 from public.profiles
    where telegram_user_id = target_telegram_user_id
      and id <> target_profile_id
  ) then
    raise exception 'This Telegram account has already been used';
  end if;

  if profile_row.telegram_user_id is not null
    and profile_row.telegram_user_id <> target_telegram_user_id then
    raise exception 'Profile is already linked to another Telegram account';
  end if;

  update public.profiles
  set onboarding_status = 'verified',
      telegram_user_id = target_telegram_user_id,
      telegram_username = nullif(left(coalesce(target_telegram_username, ''), 64), ''),
      telegram_first_name = nullif(left(coalesce(target_telegram_first_name, ''), 255), ''),
      telegram_member_status = target_member_status,
      telegram_verified_at = coalesce(telegram_verified_at, now()),
      updated_at = now()
  where id = target_profile_id;

  insert into public.credit_wallets(profile_id)
  values (target_profile_id)
  on conflict do nothing;

  if profile_row.is_trial
    and not exists (
      select 1 from public.credit_ledger
      where profile_id = target_profile_id
        and reference = 'trial:' || target_profile_id::text
    ) then
    trial_amount := coalesce(
      (select (value #>> '{}')::numeric from public.app_settings where key = 'trial_credit_amount'),
      50
    );
    if trial_amount > 0 then
      next_balance := public.grant_profile_credits(
        target_profile_id,
        trial_amount,
        'trial_grant',
        'Telegram-verified welcome trial credit',
        null,
        'trial:' || target_profile_id::text
      );
      trial_granted := true;
    end if;
  end if;

  if not trial_granted then
    select balance into next_balance
    from public.credit_wallets
    where profile_id = target_profile_id;
  end if;

  insert into public.telegram_verification_events(
    event_id, profile_id, telegram_user_id, payload_hash
  ) values (
    target_event_id, target_profile_id, target_telegram_user_id, target_payload_hash
  );

  insert into public.activity_logs(
    actor_profile_id, event_type, entity_type, entity_id, description, tone, metadata
  ) values (
    target_profile_id,
    'telegram_verified',
    'profile',
    target_profile_id,
    'Telegram account verified for onboarding',
    'success',
    jsonb_build_object('memberStatus', target_member_status, 'trialGranted', trial_granted)
  );

  return jsonb_build_object(
    'profileId', target_profile_id,
    'onboardingStatus', 'verified',
    'trialGranted', trial_granted,
    'balance', coalesce(next_balance, 0),
    'alreadyProcessed', false
  );
end;
$$;

alter table public.telegram_verification_events enable row level security;
revoke all on public.telegram_verification_events from public, anon, authenticated;
revoke all on function public.verify_profile_telegram_trial(bigint,text,text,text,text,text,text)
  from public, anon, authenticated;
grant all on public.telegram_verification_events to service_role;
grant execute on function public.verify_profile_telegram_trial(bigint,text,text,text,text,text,text)
  to service_role;
