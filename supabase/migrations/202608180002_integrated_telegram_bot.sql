-- One-time account-link tokens for the Telegram bot hosted by the Nodenesia
-- NestJS API. Only SHA-256 hashes are persisted; plaintext tokens exist only
-- long enough to build the Telegram deep link returned to the customer.

create table if not exists public.telegram_link_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  profile_id bigint not null references public.profiles(id) on delete cascade,
  telegram_user_id text,
  telegram_username text,
  telegram_first_name text,
  expires_at timestamptz not null,
  connected_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_link_tokens_profile_idx
  on public.telegram_link_tokens(profile_id, created_at desc);

create index if not exists telegram_link_tokens_pending_user_idx
  on public.telegram_link_tokens(telegram_user_id, expires_at desc)
  where used_at is null and telegram_user_id is not null;

create unique index if not exists telegram_link_tokens_active_profile_uidx
  on public.telegram_link_tokens(profile_id)
  where used_at is null;

create unique index if not exists telegram_link_tokens_active_telegram_uidx
  on public.telegram_link_tokens(telegram_user_id)
  where used_at is null and telegram_user_id is not null;

create or replace function public.create_telegram_link_token(
  target_profile_id bigint,
  target_token_hash text,
  target_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare profile_row public.profiles%rowtype;
begin
  if target_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid Telegram link token hash'; end if;
  if target_expires_at <= now() or target_expires_at > now() + interval '30 minutes' then
    raise exception 'Invalid Telegram link token expiry';
  end if;

  select * into profile_row from public.profiles where id = target_profile_id for update;
  if not found then raise exception 'Profile not found'; end if;
  if profile_row.status <> 'active' or profile_row.role <> 'client' then
    raise exception 'Customer account is not active';
  end if;
  if profile_row.onboarding_status = 'verified' then raise exception 'Profile is already verified'; end if;

  delete from public.telegram_link_tokens
  where expires_at < now() - interval '7 days';

  update public.telegram_link_tokens
  set used_at = now()
  where profile_id = target_profile_id and used_at is null;

  insert into public.telegram_link_tokens(token_hash, profile_id, expires_at)
  values (target_token_hash, target_profile_id, target_expires_at);
end;
$$;

create or replace function public.bind_telegram_link_token(
  target_token_hash text,
  target_telegram_user_id text,
  target_telegram_username text,
  target_telegram_first_name text
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare token_row public.telegram_link_tokens%rowtype;
begin
  if target_telegram_user_id !~ '^[0-9]{1,32}$' then raise exception 'Invalid Telegram user ID'; end if;

  select * into token_row
  from public.telegram_link_tokens
  where token_hash = target_token_hash
  for update;

  if not found or token_row.used_at is not null or token_row.expires_at <= now() then
    raise exception 'Telegram verification link is invalid or expired';
  end if;
  if token_row.telegram_user_id is not null and token_row.telegram_user_id <> target_telegram_user_id then
    raise exception 'Telegram verification link is already connected to another account';
  end if;
  if exists (
    select 1 from public.profiles
    where telegram_user_id = target_telegram_user_id and id <> token_row.profile_id
  ) then
    raise exception 'This Telegram account has already been used';
  end if;
  if exists (
    select 1 from public.telegram_link_tokens
    where telegram_user_id = target_telegram_user_id
      and profile_id <> token_row.profile_id
      and used_at is null
  ) then
    raise exception 'This Telegram account has another pending verification';
  end if;

  update public.telegram_link_tokens
  set telegram_user_id = target_telegram_user_id,
      telegram_username = nullif(left(coalesce(target_telegram_username, ''), 64), ''),
      telegram_first_name = nullif(left(coalesce(target_telegram_first_name, ''), 255), ''),
      connected_at = coalesce(connected_at, now())
  where token_hash = target_token_hash;

  return token_row.profile_id;
end;
$$;

create or replace function public.complete_telegram_link_token(
  target_token_hash text,
  target_event_id text,
  target_telegram_user_id text,
  target_member_status text,
  target_payload_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  token_row public.telegram_link_tokens%rowtype;
  verified_profile_id bigint;
  verification_result jsonb;
begin
  select * into token_row
  from public.telegram_link_tokens
  where token_hash = target_token_hash
  for update;

  if not found then
    raise exception 'Telegram verification link is invalid or expired';
  end if;
  if token_row.used_at is not null then
    select id into verified_profile_id
    from public.profiles
    where id = token_row.profile_id
      and onboarding_status = 'verified'
      and telegram_user_id = target_telegram_user_id;
    if found then
      return jsonb_build_object(
        'profileId', token_row.profile_id,
        'onboardingStatus', 'verified',
        'trialGranted', false,
        'alreadyProcessed', true
      );
    end if;
    raise exception 'Telegram verification link is invalid or expired';
  end if;
  if token_row.expires_at <= now() then raise exception 'Telegram verification link is invalid or expired'; end if;
  if token_row.telegram_user_id is null or token_row.telegram_user_id <> target_telegram_user_id then
    raise exception 'Telegram account does not own this verification link';
  end if;

  verification_result := public.verify_profile_telegram_trial(
    token_row.profile_id,
    target_event_id,
    target_telegram_user_id,
    token_row.telegram_username,
    token_row.telegram_first_name,
    target_member_status,
    target_payload_hash
  );

  update public.telegram_link_tokens set used_at = now() where token_hash = target_token_hash;
  return verification_result;
end;
$$;

alter table public.telegram_link_tokens enable row level security;
revoke all on public.telegram_link_tokens from public, anon, authenticated;
revoke all on function public.create_telegram_link_token(bigint,text,timestamptz) from public, anon, authenticated;
revoke all on function public.bind_telegram_link_token(text,text,text,text) from public, anon, authenticated;
revoke all on function public.complete_telegram_link_token(text,text,text,text,text) from public, anon, authenticated;
grant all on public.telegram_link_tokens to service_role;
grant execute on function public.create_telegram_link_token(bigint,text,timestamptz) to service_role;
grant execute on function public.bind_telegram_link_token(text,text,text,text) to service_role;
grant execute on function public.complete_telegram_link_token(text,text,text,text,text) to service_role;
