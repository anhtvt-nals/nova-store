-- Namespace replacement is destructive-first: the old instance is stopped
-- before the new one is requested. Reserve the replacement on the same
-- Namespace API key so a rotation cannot silently migrate an account's node
-- to a different tenant token.
create or replace function public.reserve_namespace_replacement_capacity(
  target_node_id bigint,
  preferred_provider_id bigint,
  preferred_api_key_id bigint,
  worker_id text,
  lease_seconds integer default 600
) returns table(lease_id uuid, selected_provider_id bigint, selected_api_key_id bigint, provider_code text)
language plpgsql security definer set search_path = public as $$
declare
  provider_row public.proxy_providers%rowtype;
  key_row public.provider_api_keys%rowtype;
  requested_proxy_type text;
  provider_used integer;
  provider_limit integer;
  key_limit integer;
begin
  select coalesce(product.proxy_type, 'datacenter') into requested_proxy_type
  from public.proxy_nodes node
  join public.orders order_row on order_row.id = node.order_id
  join public.products product on product.id = order_row.product_id
  where node.id = target_node_id;
  if not found then raise exception 'Proxy node not found'; end if;

  perform pg_advisory_xact_lock(hashtext('nodenesia.reserve_provider_capacity.v2'));
  update public.provider_capacity_leases set status = 'released', released_at = now()
  where released_at is null and lease_expires_at < now();

  return query
  select lease.id, lease.provider_id, lease.provider_api_key_id, provider.code
  from public.provider_capacity_leases lease
  join public.proxy_providers provider on provider.id = lease.provider_id
  where lease.node_id = target_node_id and lease.purpose = 'replacement'
    and lease.released_at is null
  limit 1;
  if found then return; end if;

  select * into provider_row from public.proxy_providers
  where id = preferred_provider_id and status = 'active';
  if not found or coalesce(provider_row.metadata->>'driver', provider_row.code) <> 'namespace'
    or coalesce(provider_row.metadata->>'proxyType', 'datacenter') <> requested_proxy_type then
    raise exception 'Namespace provider is not active for this proxy type';
  end if;

  select * into key_row from public.provider_api_keys
  where id = preferred_api_key_id and provider_id = provider_row.id and status = 'active';
  if not found then raise exception 'Original Namespace API key is not active'; end if;

  select coalesce(sum(coalesce(max_sandboxes, 100)), 0)::int into key_limit
  from public.provider_api_keys where provider_id = provider_row.id and status = 'active';
  provider_limit := least(coalesce(provider_row.max_sandboxes, key_limit), key_limit);
  provider_limit := greatest(0, provider_limit - provider_row.reserved_replacement_slots);
  select count(*) into provider_used from public.provider_capacity_leases
  where provider_id = provider_row.id and released_at is null and lease_expires_at >= now();
  if key_limit = 0 or provider_used >= provider_limit then raise exception 'Original Namespace provider has no replacement capacity'; end if;

  if key_row.max_sandboxes is not null and (
    select count(*) from public.provider_capacity_leases
    where provider_api_key_id = key_row.id and released_at is null and lease_expires_at >= now()
  ) >= key_row.max_sandboxes then
    raise exception 'Original Namespace API key has no replacement capacity';
  end if;

  insert into public.provider_capacity_leases(provider_id, provider_api_key_id, node_id, purpose, leased_by, lease_expires_at)
  values (provider_row.id, key_row.id, target_node_id, 'replacement', worker_id, now() + make_interval(secs => greatest(60, lease_seconds)))
  returning id into lease_id;
  selected_provider_id := provider_row.id;
  selected_api_key_id := key_row.id;
  provider_code := provider_row.code;
  return next;
end $$;

revoke all on function public.reserve_namespace_replacement_capacity(bigint, bigint, bigint, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_namespace_replacement_capacity(bigint, bigint, bigint, text, integer) to service_role;
