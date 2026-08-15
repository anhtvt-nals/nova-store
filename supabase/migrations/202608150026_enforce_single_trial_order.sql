-- A trial can be redeemed once only. This guard lives in the database as well
-- as the API so a crafted checkout request cannot claim another trial node.

create or replace function public.prevent_additional_trial_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.profiles p
    where p.id = new.profile_id and p.is_trial
  ) and exists (
    select 1
    from public.orders o
    where o.profile_id = new.profile_id
  ) then
    raise exception 'Your one-day trial has already been used. Upgrade to a regular account to rent more nodes.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_prevent_additional_trial_order on public.orders;
create trigger orders_prevent_additional_trial_order
before insert on public.orders
for each row execute function public.prevent_additional_trial_order();
