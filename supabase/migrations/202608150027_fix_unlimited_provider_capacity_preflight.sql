-- Keep checkout capacity consistent with reserve_provider_capacity: a NULL
-- provider/key max means unlimited, not zero. Checkout itself is capped at
-- 100 nodes by the order DTO, so use that finite cap for the estimate.

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
  ), provider_capacity as (
    select p.id,
      case when p.max_sandboxes is null then 100
        else greatest(0, p.max_sandboxes - p.reserved_replacement_slots - coalesce(sum(l.used), 0)::integer)
      end as provider_remaining
    from public.proxy_providers p
    left join live_leases l on l.provider_id = p.id
    where p.status = 'active'
    group by p.id, p.max_sandboxes, p.reserved_replacement_slots
  ), key_capacity as (
    select k.provider_id,
      sum(case when k.max_sandboxes is null then 100
        else greatest(0, k.max_sandboxes - coalesce(l.used, 0))
      end)::integer as key_remaining
    from public.provider_api_keys k
    left join live_leases l on l.provider_api_key_id = k.id
    where k.status = 'active'
    group by k.provider_id
  )
  select least(100, coalesce(sum(least(p.provider_remaining, coalesce(k.key_remaining, 0))), 0))::integer
  from provider_capacity p
  left join key_capacity k on k.provider_id = p.id;
$$;

revoke all on function public.available_proxy_customer_capacity() from public, anon, authenticated;
grant execute on function public.available_proxy_customer_capacity() to service_role;
