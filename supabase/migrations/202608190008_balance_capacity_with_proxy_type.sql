-- Keep Namespace residential inventory isolated while restoring fair capacity
-- allocation for providers in the same proxy type and priority tier. The
-- Namespace migration replaced the former utilization ordering with p.id,
-- which made the oldest provider (normally E2B) receive every datacenter node.

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
  requested_proxy_type text;
begin
  if target_purpose not in ('customer', 'replacement') then
    raise exception 'Unsupported capacity purpose';
  end if;

  select coalesce(product.proxy_type, 'datacenter')
  into requested_proxy_type
  from public.proxy_nodes node
  join public.orders orders on orders.id = node.order_id
  join public.products product on product.id = orders.product_id
  where node.id = target_node_id;
  if not found then
    raise exception 'Proxy node not found';
  end if;

  -- One short transaction-wide lock makes the utilization decision safe when
  -- multiple provisioning workers reserve capacity concurrently.
  perform pg_advisory_xact_lock(hashtext('nodenesia.reserve_provider_capacity.v2'));

  update public.provider_capacity_leases
  set status = 'released', released_at = now()
  where released_at is null and lease_expires_at < now();

  -- Keep an owned lease stable across retries instead of creating another one.
  return query
  select lease.id, lease.provider_id, lease.provider_api_key_id, provider.code
  from public.provider_capacity_leases lease
  join public.proxy_providers provider on provider.id = lease.provider_id
  where lease.node_id = target_node_id
    and lease.purpose = target_purpose
    and lease.released_at is null
  limit 1;
  if found then
    return;
  end if;

  -- An explicit priority is an operator override. Within one priority tier,
  -- select the provider with the lowest live-lease/capacity utilization.
  for provider_row in
    select provider.*
    from public.proxy_providers provider
    where provider.status = 'active'
      and coalesce(provider.metadata ->> 'proxyType', 'datacenter') = requested_proxy_type
      and exists (
        select 1
        from public.provider_api_keys key
        where key.provider_id = provider.id and key.status = 'active'
      )
    order by
      case when (provider.metadata ->> 'priority') ~ '^-?[0-9]+$'
        then (provider.metadata ->> 'priority')::integer else 100 end,
      coalesce((
        select count(*)::numeric /
          nullif(least(
            coalesce(provider.max_sandboxes, (
              select sum(coalesce(key.max_sandboxes, 100))::integer
              from public.provider_api_keys key
              where key.provider_id = provider.id and key.status = 'active'
            )),
            coalesce((
              select sum(coalesce(key.max_sandboxes, 100))::integer
              from public.provider_api_keys key
              where key.provider_id = provider.id and key.status = 'active'
            ), 0)
          ), 0)::numeric
        from public.provider_capacity_leases lease
        where lease.provider_id = provider.id
          and lease.released_at is null
          and lease.lease_expires_at >= now()
      ), 0),
      provider.id
  loop
    select coalesce(sum(coalesce(key.max_sandboxes, 100)), 0)::integer
    into key_limit
    from public.provider_api_keys key
    where key.provider_id = provider_row.id and key.status = 'active';
    if key_limit = 0 then
      continue;
    end if;

    provider_limit := least(coalesce(provider_row.max_sandboxes, key_limit), key_limit);
    if target_purpose = 'customer' then
      provider_limit := greatest(0, provider_limit - provider_row.reserved_replacement_slots);
    end if;

    select count(*) into provider_used
    from public.provider_capacity_leases lease
    where lease.provider_id = provider_row.id
      and lease.released_at is null
      and lease.lease_expires_at >= now();
    if provider_used >= provider_limit then
      continue;
    end if;

    -- Do the same within the selected provider, so one API key is not filled
    -- before other active keys have been used.
    select key.* into key_row
    from public.provider_api_keys key
    where key.provider_id = provider_row.id
      and key.status = 'active'
      and (
        key.max_sandboxes is null or
        (select count(*) from public.provider_capacity_leases lease
          where lease.provider_api_key_id = key.id
            and lease.released_at is null
            and lease.lease_expires_at >= now()) < key.max_sandboxes
      )
    order by
      coalesce((
        select count(*)::numeric / nullif(coalesce(key.max_sandboxes, 100), 0)::numeric
        from public.provider_capacity_leases lease
        where lease.provider_api_key_id = key.id
          and lease.released_at is null
          and lease.lease_expires_at >= now()
      ), 0),
      key.created_at,
      key.id
    limit 1;
    if not found then
      continue;
    end if;

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
