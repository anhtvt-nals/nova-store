-- Keep live runtime rows indefinitely, but bound historical rows created by
-- rotations and capacity reservations. The function never deletes a node's
-- current instance or a live capacity lease.
create or replace function public.purge_proxy_runtime_history(
  instance_retention_days integer default 14,
  lease_retention_days integer default 7,
  batch_size integer default 500
) returns table(deleted_instances integer, deleted_leases integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  instance_cutoff timestamptz := now() - make_interval(days => greatest(1, least(instance_retention_days, 365)));
  lease_cutoff timestamptz := now() - make_interval(days => greatest(1, least(lease_retention_days, 365)));
  limit_rows integer := greatest(1, least(batch_size, 5000));
begin
  with candidates as (
    select i.id
    from public.proxy_node_instances i
    join public.proxy_nodes n on n.id = i.node_id
    where i.status in ('stopped', 'error')
      and n.current_instance_id is distinct from i.external_instance_id
      and coalesce(i.stopped_at, i.expires_at, i.created_at) < instance_cutoff
    order by coalesce(i.stopped_at, i.expires_at, i.created_at), i.id
    limit limit_rows
  ), removed as (
    delete from public.proxy_node_instances i using candidates c where i.id = c.id returning i.id
  ) select count(*)::integer into deleted_instances from removed;

  with candidates as (
    select id
    from public.provider_capacity_leases
    where released_at is not null and released_at < lease_cutoff
    order by released_at, id
    limit limit_rows
  ), removed as (
    delete from public.provider_capacity_leases l using candidates c where l.id = c.id returning l.id
  ) select count(*)::integer into deleted_leases from removed;

  return next;
end;
$$;

revoke all on function public.purge_proxy_runtime_history(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.purge_proxy_runtime_history(integer, integer, integer) to service_role;
