-- Distribute new capacity reservations across equally-prioritized providers
-- and their keys. Previously the stable provider/key IDs made the oldest
-- provider (normally E2B) absorb every request until it was exhausted.
--
-- The advisory lock makes this short decision transactional across concurrent
-- workers, so utilization cannot be oversubscribed by simultaneous jobs.

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

  perform pg_advisory_xact_lock(hashtext('nodenesia.reserve_provider_capacity.v1'));

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

  -- Priority remains an explicit operator override. Within a priority tier,
  -- choose the provider with the lowest live-lease/capacity ratio.
  for provider_row in
    select p.*
    from public.proxy_providers p
    where p.status = 'active'
      and exists (
        select 1 from public.provider_api_keys k
        where k.provider_id = p.id and k.status = 'active'
      )
    order by
      case when (p.metadata ->> 'priority') ~ '^-?[0-9]+$'
        then (p.metadata ->> 'priority')::integer else 100 end,
      coalesce((
        select count(*)::numeric /
          nullif(least(
            coalesce(p.max_sandboxes, (
              select sum(coalesce(k.max_sandboxes, 100))::integer
              from public.provider_api_keys k
              where k.provider_id = p.id and k.status = 'active'
            )),
            coalesce((
              select sum(coalesce(k.max_sandboxes, 100))::integer
              from public.provider_api_keys k
              where k.provider_id = p.id and k.status = 'active'
            ), 0)
          ), 0)::numeric
        from public.provider_capacity_leases l
        where l.provider_id = p.id and l.released_at is null and l.lease_expires_at >= now()
      ), 0),
      p.id
  loop
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
    where provider_id = provider_row.id and released_at is null and lease_expires_at >= now();
    if provider_used >= provider_limit then continue; end if;

    -- Spread work over keys in the selected provider as well. Null caps retain
    -- legacy semantics and are treated as 100 for this balancing calculation.
    select k.* into key_row
    from public.provider_api_keys k
    where k.provider_id = provider_row.id
      and k.status = 'active'
      and (
        k.max_sandboxes is null or
        (select count(*) from public.provider_capacity_leases l
          where l.provider_api_key_id = k.id
            and l.released_at is null and l.lease_expires_at >= now()) < k.max_sandboxes
      )
    order by
      coalesce((select count(*)::numeric / nullif(coalesce(k.max_sandboxes, 100), 0)::numeric
        from public.provider_capacity_leases l
        where l.provider_api_key_id = k.id and l.released_at is null and l.lease_expires_at >= now()), 0),
      k.created_at,
      k.id
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

revoke all on function public.reserve_provider_capacity(bigint, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_provider_capacity(bigint, text, integer, text) to service_role;
