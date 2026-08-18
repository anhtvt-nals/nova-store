-- Close remaining Telegram onboarding abuse paths. Membership revocation is
-- server-only and idempotent per Telegram update. Profile names are bounded in
-- PostgreSQL because browser maxlength attributes are not a security boundary.

update public.profiles
set name = left(coalesce(nullif(btrim(name), ''), split_part(email, '@', 1)), 80)
where name <> left(coalesce(nullif(btrim(name), ''), split_part(email, '@', 1)), 80)
   or btrim(name) = '';

alter table public.profiles drop constraint if exists profiles_name_length_check;
alter table public.profiles add constraint profiles_name_length_check
  check (char_length(name) between 1 and 80);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  profile_name text;
begin
  profile_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(new.email, '@', 1)
    ),
    80
  );

  insert into public.profiles(auth_user_id, email, name, role)
  values (new.id, lower(new.email), profile_name, 'client')
  on conflict (email) do update
    set name = excluded.name,
        updated_at = now()
    where public.profiles.auth_user_id = excluded.auth_user_id;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

create table if not exists public.telegram_membership_events (
  event_id text primary key,
  telegram_user_id text not null check (telegram_user_id ~ '^[0-9]{1,32}$'),
  member_status text not null check (member_status in ('left', 'kicked')),
  created_at timestamptz not null default now()
);

create or replace function public.mark_telegram_membership_inactive(
  target_event_id text,
  target_telegram_user_id text,
  target_member_status text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_profile_id bigint;
begin
  if target_event_id is null or length(target_event_id) < 8 or length(target_event_id) > 128 then
    raise exception 'Invalid Telegram membership event';
  end if;
  if target_telegram_user_id is null or target_telegram_user_id !~ '^[0-9]{1,32}$' then
    raise exception 'Invalid Telegram user ID';
  end if;
  if target_member_status not in ('left', 'kicked') then
    raise exception 'Invalid inactive Telegram membership status';
  end if;

  insert into public.telegram_membership_events(event_id, telegram_user_id, member_status)
  values (target_event_id, target_telegram_user_id, target_member_status)
  on conflict (event_id) do nothing;
  if not found then return false; end if;

  update public.profiles
  set onboarding_status = 'telegram_pending',
      telegram_member_status = target_member_status,
      updated_at = now()
  where telegram_user_id = target_telegram_user_id
    and onboarding_status = 'verified'
  returning id into affected_profile_id;

  if affected_profile_id is not null then
    insert into public.activity_logs(
      actor_profile_id, event_type, entity_type, entity_id, description, tone, metadata
    ) values (
      affected_profile_id,
      'telegram_membership_inactive',
      'profile',
      affected_profile_id,
      'Telegram membership is no longer active',
      'warning',
      jsonb_build_object('memberStatus', target_member_status, 'eventId', target_event_id)
    );
    return true;
  end if;
  return false;
end;
$$;

alter table public.telegram_membership_events enable row level security;
revoke all on public.telegram_membership_events from public, anon, authenticated;
revoke all on function public.mark_telegram_membership_inactive(text,text,text)
  from public, anon, authenticated;
grant all on public.telegram_membership_events to service_role;
grant execute on function public.mark_telegram_membership_inactive(text,text,text)
  to service_role;
