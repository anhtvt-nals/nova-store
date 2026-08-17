-- Health checks must survive transient provider outages without removing a
-- usable upstream after one timeout. The fields are admin-only metadata.
alter table public.static_residential_proxies
  add column if not exists health_failure_count integer not null default 0,
  add column if not exists last_health_checked_at timestamptz,
  add column if not exists last_health_error text;

alter table public.static_residential_proxies
  drop constraint if exists static_residential_proxies_health_failure_count_check;
alter table public.static_residential_proxies
  add constraint static_residential_proxies_health_failure_count_check
  check (health_failure_count >= 0);

-- Serialize replacements inside one customer order, and exclude every
-- upstream already assigned to its other active ports. This preserves the
-- five-distinct-upstream guarantee during hourly and health-triggered rotation.
create or replace function public.rotate_static_residential_node_v2(target_node_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  node_row public.static_residential_nodes%rowtype;
  replacement bigint;
begin
  select * into node_row
  from public.static_residential_nodes
  where id = target_node_id
  for update;
  if not found then raise exception 'Static residential node not found'; end if;

  -- Lock the parent order so parallel rotations cannot select the same
  -- replacement before either transaction commits.
  perform 1 from public.static_residential_orders where id = node_row.order_id for update;

  select p.id into replacement
  from public.static_residential_proxies p
  where p.status <> 'disabled'
    and p.id <> node_row.upstream_proxy_id
    and not exists (
      select 1
      from public.static_residential_nodes peer
      where peer.order_id = node_row.order_id
        and peer.id <> node_row.id
        and peer.status = 'active'
        and peer.upstream_proxy_id = p.id
    )
  order by random()
  limit 1;
  if replacement is null then
    raise exception 'No distinct replacement static residential proxy is available';
  end if;

  update public.static_residential_nodes
  set upstream_proxy_id = replacement,
      last_upstream_rotation_at = now(),
      next_upstream_rotation_at = now() + interval '1 hour',
      updated_at = now()
  where id = node_row.id;
end $$;

revoke all on function public.rotate_static_residential_node_v2(bigint) from public, anon, authenticated;
grant execute on function public.rotate_static_residential_node_v2(bigint) to service_role;
