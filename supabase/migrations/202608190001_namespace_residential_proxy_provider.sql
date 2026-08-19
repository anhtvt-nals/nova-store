-- Namespace instances are residential inventory. Keep them isolated from the
-- existing datacenter pool at both checkout and capacity-reservation time.
alter table public.products
  add column if not exists proxy_type text not null default 'datacenter'
  check (proxy_type in ('datacenter', 'residential'));

update public.products set proxy_type = 'datacenter' where proxy_type is null;

insert into public.proxy_providers(code, name, api_base_url, status, metadata)
values (
  'namespace', 'Namespace Labs Residential', 'https://namespace.so', 'active',
  '{"driver":"namespace","proxyType":"residential","priority":100}'::jsonb
)
on conflict (code) do update set
  name = excluded.name,
  api_base_url = excluded.api_base_url,
  metadata = public.proxy_providers.metadata || excluded.metadata;

-- Security boundary: a node inherits its requested type from the order product;
-- allocation can only use provider records explicitly tagged for that type.
create or replace function public.reserve_provider_capacity(
  target_node_id bigint,
  worker_id text,
  lease_seconds integer default 300,
  target_purpose text default 'customer'
) returns table(lease_id uuid, selected_provider_id bigint, selected_api_key_id bigint, provider_code text)
language plpgsql security definer set search_path = public as $$
declare provider_row public.proxy_providers%rowtype; key_row public.provider_api_keys%rowtype;
  provider_used integer; provider_limit integer; key_limit integer; requested_proxy_type text;
begin
  if target_purpose not in ('customer', 'replacement') then raise exception 'Unsupported capacity purpose'; end if;
  select coalesce(p.proxy_type, 'datacenter') into requested_proxy_type
  from public.proxy_nodes n join public.orders o on o.id=n.order_id join public.products p on p.id=o.product_id
  where n.id=target_node_id;
  if not found then raise exception 'Proxy node not found'; end if;
  perform pg_advisory_xact_lock(hashtext('nodenesia.reserve_provider_capacity.v2'));
  update public.provider_capacity_leases set status='released', released_at=now() where released_at is null and lease_expires_at < now();
  return query select l.id,l.provider_id,l.provider_api_key_id,p.code from public.provider_capacity_leases l join public.proxy_providers p on p.id=l.provider_id where l.node_id=target_node_id and l.purpose=target_purpose and l.released_at is null limit 1;
  if found then return; end if;
  for provider_row in select p.* from public.proxy_providers p where p.status='active'
    and coalesce(p.metadata->>'proxyType','datacenter')=requested_proxy_type
    and exists(select 1 from public.provider_api_keys k where k.provider_id=p.id and k.status='active')
    order by case when (p.metadata->>'priority')~'^-?[0-9]+$' then (p.metadata->>'priority')::int else 100 end, p.id
  loop
    select coalesce(sum(coalesce(k.max_sandboxes,100)),0)::int into key_limit from public.provider_api_keys k where k.provider_id=provider_row.id and k.status='active';
    provider_limit:=least(coalesce(provider_row.max_sandboxes,key_limit),key_limit);
    if target_purpose='customer' then provider_limit:=greatest(0,provider_limit-provider_row.reserved_replacement_slots); end if;
    select count(*) into provider_used from public.provider_capacity_leases where provider_id=provider_row.id and released_at is null and lease_expires_at>=now();
    if key_limit=0 or provider_used>=provider_limit then continue; end if;
    select k.* into key_row from public.provider_api_keys k where k.provider_id=provider_row.id and k.status='active' and (k.max_sandboxes is null or (select count(*) from public.provider_capacity_leases l where l.provider_api_key_id=k.id and l.released_at is null and l.lease_expires_at>=now())<k.max_sandboxes) order by k.created_at,k.id limit 1;
    if not found then continue; end if;
    insert into public.provider_capacity_leases(provider_id,provider_api_key_id,node_id,purpose,leased_by,lease_expires_at) values(provider_row.id,key_row.id,target_node_id,target_purpose,worker_id,now()+make_interval(secs=>greatest(60,lease_seconds))) returning id into lease_id;
    selected_provider_id:=provider_row.id; selected_api_key_id:=key_row.id; provider_code:=provider_row.code; return next; return;
  end loop;
end $$;

-- The database, never the browser, owns product price/type and the credit debit.
-- Residential is not eligible for trial accounts.
create or replace function public.create_proxy_order(target_profile_id bigint,target_product_id bigint,requested_nodes integer,requested_days integer,requested_payment_method text)
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare selected_product record; profile_row public.profiles%rowtype; new_order_id bigint; total_usd numeric; credit_cost numeric; credit_rate numeric; wallet_balance numeric;
begin
  if requested_payment_method<>'credit' then raise exception 'Credit is the only supported payment method'; end if;
  select * into profile_row from public.profiles where id=target_profile_id and status='active' for update; if not found then raise exception 'Customer account is not active'; end if;
  select id,name,base_price,currency,service_type,proxy_type into selected_product from public.products where id=target_product_id and is_active=true for share;
  if not found or selected_product.service_type<>'proxy' or selected_product.base_price<=0 or selected_product.currency<>'USD' then raise exception 'Proxy product is unavailable'; end if;
  if selected_product.proxy_type='residential' and profile_row.is_trial then raise exception 'Residential proxy is not available for trial accounts'; end if;
  if profile_row.is_trial then
    if requested_nodes<>1 or requested_days<>1 then raise exception 'Trial accounts can rent exactly one datacenter node for one day'; end if;
  elsif requested_nodes<>all(array[5,10,20,30]) or requested_days<>all(array[1,3,7,15,30]) then raise exception 'Unsupported node quantity or rental days'; end if;
  total_usd:=selected_product.base_price*requested_nodes*requested_days;
  credit_rate:=coalesce((select (value#>>'{}')::numeric from public.app_settings where key='credits_per_usd'),100); if credit_rate<=0 then raise exception 'Credit conversion rate is not configured'; end if;
  credit_cost:=ceil(total_usd*credit_rate*100)/100; insert into public.credit_wallets(profile_id) values(target_profile_id) on conflict do nothing;
  select balance into wallet_balance from public.credit_wallets where profile_id=target_profile_id for update; if wallet_balance<credit_cost then raise exception 'Insufficient credit balance'; end if;
  insert into public.orders(order_group_id,profile_id,product_id,plan_id,resource_id,status,payment_method,amount,currency,unit_price,node_count,rental_days,plan_name_snapshot,resource_name_snapshot,pending_expires_at,credits_charged)
  values(gen_random_uuid(),target_profile_id,selected_product.id,null,null,'pending','credit',total_usd,'USD',selected_product.base_price,requested_nodes,requested_days,selected_product.name,format('%s %s nodes',requested_nodes,selected_product.proxy_type),now()+interval '30 minutes',credit_cost) returning id into new_order_id;
  update public.credit_wallets set balance=balance-credit_cost,updated_at=now() where profile_id=target_profile_id returning balance into wallet_balance;
  insert into public.credit_ledger(profile_id,amount,balance_after,type,reference,note) values(target_profile_id,-credit_cost,wallet_balance,'order_debit','order:'||new_order_id::text,format('%s proxy order #%s',selected_product.proxy_type,new_order_id));
  perform public.transition_order(new_order_id,'active',target_profile_id); return new_order_id;
end $$;
revoke all on function public.create_proxy_order(bigint,bigint,integer,integer,text) from public,anon,authenticated;
grant execute on function public.create_proxy_order(bigint,bigint,integer,integer,text) to service_role;
