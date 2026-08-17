-- Keep extension pricing aligned with the quota originally purchased (1/3/5GB).
create or replace function public.extend_static_residential_order_v2(target_profile_id bigint, target_order_id bigint, requested_days integer)
returns void language plpgsql security definer set search_path=public as $$
declare o static_residential_orders%rowtype; rate numeric; cost numeric; balance numeric; quota_gb numeric;
begin
  if requested_days not in (1,3,7,15,30) then raise exception 'Rental days must be one of: 1, 3, 7, 15, or 30'; end if;
  select * into o from static_residential_orders where id=target_order_id and profile_id=target_profile_id for update;
  if not found then raise exception 'Static residential order not found'; end if;
  if o.status in ('cancelled','suspended') then raise exception 'Static residential order cannot be extended'; end if;
  quota_gb := o.quota_bytes::numeric/1073741824;
  select coalesce((value #>> '{}')::numeric,100) into rate from app_settings where key='credits_per_usd';
  cost := ceil(o.price_per_gb_day*quota_gb*requested_days*rate*100)/100;
  insert into credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select balance into balance from credit_wallets where profile_id=target_profile_id for update;
  if balance < cost then raise exception 'Insufficient credit balance'; end if;
  update credit_wallets set balance=balance-cost,updated_at=now() where profile_id=target_profile_id returning balance into balance;
  update static_residential_orders set expires_at=greatest(expires_at,now())+make_interval(days=>requested_days),status='active',updated_at=now() where id=target_order_id;
  update static_residential_nodes set status='active',updated_at=now() where order_id=target_order_id;
  insert into credit_ledger(profile_id,amount,balance_after,type,reference,note) values(target_profile_id,-cost,balance,'order_extension_debit','static-residential:'||target_order_id,'Static residential order #'||target_order_id||' extended '||requested_days||' days ('||quota_gb||'GB)');
end $$;
revoke all on function public.extend_static_residential_order_v2(bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.extend_static_residential_order_v2(bigint,bigint,integer) to service_role;
