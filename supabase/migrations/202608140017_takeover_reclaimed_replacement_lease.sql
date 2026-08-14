-- A job can be reclaimed by a new API worker after an ungraceful restart. Its
-- temporary replacement lease must follow the new owner, otherwise completion
-- correctly rejects it as belonging to the old worker.

create or replace function public.reserve_provider_capacity(
  target_node_id bigint,
  worker_id text,
  lease_seconds integer default 300,
  target_purpose text default 'customer'
) returns table(lease_id uuid, selected_provider_id bigint, selected_api_key_id bigint, provider_code text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  provider_row public.proxy_providers%rowtype;
  key_row public.provider_api_keys%rowtype;
  existing_lease public.provider_capacity_leases%rowtype;
  provider_used integer;
  provider_provisioning integer;
  provider_limit integer;
begin
  if target_purpose not in ('customer', 'replacement') then raise exception 'Unsupported capacity purpose'; end if;
  update public.provider_capacity_leases set status = 'released', released_at = now()
  where released_at is null and lease_expires_at < now();

  select * into existing_lease
  from public.provider_capacity_leases
  where node_id = target_node_id and purpose = target_purpose and released_at is null
  for update
  limit 1;
  if found then
    if target_purpose = 'replacement' then
      update public.provider_capacity_leases set
        leased_by = worker_id, status = 'reserved',
        lease_expires_at = greatest(lease_expires_at, now() + make_interval(secs => greatest(60, lease_seconds)))
      where id = existing_lease.id
      returning * into existing_lease;
    end if;
    lease_id := existing_lease.id;
    selected_provider_id := existing_lease.provider_id;
    selected_api_key_id := existing_lease.provider_api_key_id;
    select code into provider_code from public.proxy_providers where id = existing_lease.provider_id;
    return next;
    return;
  end if;

  for provider_row in
    select p.* from public.proxy_providers p
    where p.status = 'active'
    order by case when (p.metadata ->> 'priority') ~ '^-?[0-9]+$' then (p.metadata ->> 'priority')::integer else 100 end, p.id
    for update skip locked
  loop
    select count(*) into provider_used from public.provider_capacity_leases
    where provider_id = provider_row.id and released_at is null and lease_expires_at >= now();
    select count(*) into provider_provisioning from public.provider_capacity_leases
    where provider_id = provider_row.id and status = 'reserved' and released_at is null and lease_expires_at >= now();
    if provider_provisioning >= provider_row.max_concurrent_provisions then continue; end if;

    provider_limit := provider_row.max_sandboxes;
    if provider_limit is not null and target_purpose = 'customer' then
      provider_limit := greatest(0, provider_limit - provider_row.reserved_replacement_slots);
    end if;
    if provider_limit is not null and provider_used >= provider_limit then continue; end if;

    select k.* into key_row
    from public.provider_api_keys k
    where k.provider_id = provider_row.id and k.status = 'active'
      and (
        k.max_sandboxes is null or
        (select count(*) from public.provider_capacity_leases l where l.provider_api_key_id = k.id and l.released_at is null and l.lease_expires_at >= now()) < k.max_sandboxes
      )
    order by k.created_at, k.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    insert into public.provider_capacity_leases(provider_id, provider_api_key_id, node_id, purpose, leased_by, lease_expires_at)
    values (provider_row.id, key_row.id, target_node_id, target_purpose, worker_id, now() + make_interval(secs => greatest(60, lease_seconds)))
    returning id into lease_id;
    selected_provider_id := provider_row.id;
    selected_api_key_id := key_row.id;
    provider_code := provider_row.code;
    return next;
    return;
  end loop;
end;
$$;

revoke all on function public.reserve_provider_capacity(bigint, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_provider_capacity(bigint, text, integer, text) to service_role;
