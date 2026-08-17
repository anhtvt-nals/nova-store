-- Provider API keys are the source of allocatable sandbox capacity.  The
-- provider-level max_sandboxes is now only an optional aggregate safety cap;
-- when it is NULL, active key limits determine the provider's capacity.

create or replace function public.available_proxy_customer_capacity()
returns integer
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  with live_leases as (
    select provider_id, provider_api_key_id, count(*)::integer as used
    from public.provider_capacity_leases
    where released_at is null and lease_expires_at >= now()
    group by provider_id, provider_api_key_id
  ), key_capacity as (
    select k.provider_id,
      sum(case when k.max_sandboxes is null then 100
          else k.max_sandboxes
      end)::integer as key_limit,
      sum(case when k.max_sandboxes is null then 100
          else greatest(0, k.max_sandboxes - coalesce(l.used, 0))
      end)::integer as key_remaining
    from public.provider_api_keys k
    left join live_leases l on l.provider_api_key_id = k.id
    where k.status = 'active'
    group by k.provider_id
  ), provider_capacity as (
    select p.id,
      greatest(0, least(
        coalesce(p.max_sandboxes, k.key_limit) - p.reserved_replacement_slots - coalesce(sum(l.used), 0)::integer,
        k.key_remaining - p.reserved_replacement_slots
      )) as customer_remaining
    from public.proxy_providers p
    join key_capacity k on k.provider_id = p.id
    left join live_leases l on l.provider_id = p.id
    where p.status = 'active'
    group by p.id, p.max_sandboxes, p.reserved_replacement_slots, k.key_limit, k.key_remaining
  )
  select least(100, coalesce(sum(customer_remaining), 0))::integer
  from provider_capacity;
$$;

create or replace function public.reserve_provider_capacity(
  target_node_id bigint,
  worker_id text,
  lease_seconds integer default 300,
  target_purpose text default 'customer'
) returns table(lease_id uuid, selected_provider_id bigint, selected_api_key_id bigint, provider_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  provider_row public.proxy_providers%rowtype;
  key_row public.provider_api_keys%rowtype;
  provider_used integer;
  provider_limit integer;
  key_limit integer;
begin
  if target_purpose not in ('customer', 'replacement') then
    raise exception 'Unsupported capacity purpose';
  end if;

  update public.provider_capacity_leases
  set status = 'released', released_at = now()
  where released_at is null and lease_expires_at < now();

  return query
  select l.id, l.provider_id, l.provider_api_key_id, p.code
  from public.provider_capacity_leases l
  join public.proxy_providers p on p.id = l.provider_id
  where l.node_id = target_node_id and l.purpose = target_purpose and l.released_at is null
  limit 1;
  if found then return; end if;

  for provider_row in
    select p.*
    from public.proxy_providers p
    where p.status = 'active'
    order by coalesce((p.metadata ->> 'priority')::integer, 100), p.id
    for update
  loop
    -- A NULL key cap keeps legacy semantics (bounded by the checkout limit),
    -- while explicitly configured keys contribute their actual capacity.
    select coalesce(sum(coalesce(k.max_sandboxes, 100)), 0)::integer
    into key_limit
    from public.provider_api_keys k
    where k.provider_id = provider_row.id and k.status = 'active';
    if key_limit = 0 then continue; end if;

    provider_limit := least(coalesce(provider_row.max_sandboxes, key_limit), key_limit);
    if target_purpose = 'customer' then
      provider_limit := greatest(0, provider_limit - provider_row.reserved_replacement_slots);
    end if;

    select count(*) into provider_used
    from public.provider_capacity_leases
    where provider_id = provider_row.id
      and released_at is null
      and lease_expires_at >= now();
    if provider_used >= provider_limit then continue; end if;

    select k.* into key_row
    from public.provider_api_keys k
    where k.provider_id = provider_row.id
      and k.status = 'active'
      and (
        k.max_sandboxes is null or
        (select count(*) from public.provider_capacity_leases l
          where l.provider_api_key_id = k.id
            and l.released_at is null
            and l.lease_expires_at >= now()) < k.max_sandboxes
      )
    order by k.created_at, k.id
    for update
    limit 1;
    if not found then continue; end if;

    insert into public.provider_capacity_leases(
      provider_id, provider_api_key_id, node_id, purpose, leased_by, lease_expires_at
    ) values (
      provider_row.id, key_row.id, target_node_id, target_purpose, worker_id,
      now() + make_interval(secs => greatest(60, lease_seconds))
    ) returning id into lease_id;
    selected_provider_id := provider_row.id;
    selected_api_key_id := key_row.id;
    provider_code := provider_row.code;
    return next;
    return;
  end loop;
end;
$$;

revoke all on function public.available_proxy_customer_capacity() from public, anon, authenticated;
grant execute on function public.available_proxy_customer_capacity() to service_role;
revoke all on function public.reserve_provider_capacity(bigint, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_provider_capacity(bigint, text, integer, text) to service_role;
