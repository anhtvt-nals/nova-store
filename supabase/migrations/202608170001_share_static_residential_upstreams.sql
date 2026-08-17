-- Upstreams are a shared pool. Only the five endpoints inside one order must
-- be distinct; the same endpoint may serve a different customer/order.
drop index if exists public.static_residential_nodes_active_upstream_idx;
update public.static_residential_proxies set status = 'available', assigned_order_id = null where status = 'assigned';

create or replace function public.create_static_residential_order_v2(target_profile_id bigint, requested_days integer, requested_quota_gb integer)
returns bigint language plpgsql security definer set search_path = public as $$
declare ids bigint[]; oid bigint; price numeric; rate numeric; cost numeric; balance numeric; expiry timestamptz; port_value integer; i integer;
begin
  if requested_days not in (1,3,7,15,30) then raise exception 'Rental days must be one of: 1, 3, 7, 15, or 30'; end if;
  if requested_quota_gb not in (1,3,5) then raise exception 'Quota must be 1GB, 3GB, or 5GB'; end if;
  if exists(select 1 from profiles where id=target_profile_id and is_trial) then raise exception 'Static residential proxy is not available for trial accounts'; end if;
  if exists(select 1 from static_residential_orders where profile_id=target_profile_id and status='active' and expires_at>now()) then raise exception 'An active static residential order already exists'; end if;
  select array_agg(id) into ids from (select id from static_residential_proxies where status <> 'disabled' order by random() limit 5) p;
  if coalesce(array_length(ids,1),0) <> 5 then raise exception 'No capacity: five static residential proxies are required'; end if;
  select coalesce((value #>> '{}')::numeric,0) into price from app_settings where key='static_residential_price_per_gb_day';
  select coalesce((value #>> '{}')::numeric,100) into rate from app_settings where key='credits_per_usd';
  if price<=0 or rate<=0 then raise exception 'Static residential pricing is not configured'; end if;
  cost := ceil(price * requested_quota_gb * requested_days * rate * 100)/100;
  insert into credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select balance into balance from credit_wallets where profile_id=target_profile_id for update;
  if balance < cost then raise exception 'Insufficient credit balance'; end if;
  expiry := now()+make_interval(days=>requested_days);
  insert into static_residential_orders(profile_id,node_count,quota_bytes,price_per_gb_day,amount,credit_cost,expires_at)
  values(target_profile_id,5,requested_quota_gb::bigint*1073741824,price,round(price*requested_quota_gb*requested_days,4),cost,expiry) returning id into oid;
  update credit_wallets set balance=balance-cost,updated_at=now() where profile_id=target_profile_id returning balance into balance;
  insert into credit_ledger(profile_id,amount,balance_after,type,reference,note) values(target_profile_id,-cost,balance,'order_debit','static-residential:'||oid,'Static residential order #'||oid||' ('||requested_quota_gb||'GB, '||requested_days||' days)');
  for i in 1..5 loop
    select g into port_value from generate_series(10000,20000) g where not exists(select 1 from static_residential_nodes where public_port=g) order by g limit 1;
    if port_value is null then raise exception 'No public static proxy port is available'; end if;
    insert into static_residential_nodes(order_id,upstream_proxy_id,public_port,service_name) values(oid,ids[i],port_value,'static-residential-node-'||oid||'-'||i);
  end loop;
  return oid;
end $$;
revoke all on function public.create_static_residential_order_v2(bigint,integer,integer) from public,anon,authenticated;
grant execute on function public.create_static_residential_order_v2(bigint,integer,integer) to service_role;

create or replace function public.rotate_static_residential_node_v2(target_node_id bigint)
returns void language plpgsql security definer set search_path=public as $$
declare n static_residential_nodes%rowtype; replacement bigint;
begin
  select * into n from static_residential_nodes where id=target_node_id for update;
  if not found then raise exception 'Static residential node not found'; end if;
  select id into replacement from static_residential_proxies where status <> 'disabled' and id <> n.upstream_proxy_id order by random() limit 1;
  if replacement is null then raise exception 'No replacement static residential proxy is available'; end if;
  update static_residential_nodes set upstream_proxy_id=replacement,last_upstream_rotation_at=now(),next_upstream_rotation_at=now()+interval '1 hour',updated_at=now() where id=target_node_id;
end $$;
revoke all on function public.rotate_static_residential_node_v2(bigint) from public,anon,authenticated;
grant execute on function public.rotate_static_residential_node_v2(bigint) to service_role;

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
