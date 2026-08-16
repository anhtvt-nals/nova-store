-- A dedicated Blaxel egress gateway is a scarce IP resource.  This table
-- prevents two live Nodenesia nodes from attaching the same gateway.
create table if not exists public.blaxel_egress_gateway_leases (
  node_id bigint primary key references public.proxy_nodes(id) on delete cascade,
  gateway text not null unique,
  region text not null,
  status text not null default 'reserved' check (status in ('reserved', 'active')),
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blaxel_egress_gateway_leases_reserved_idx
  on public.blaxel_egress_gateway_leases(lease_expires_at)
  where status = 'reserved';

create or replace function public.reserve_blaxel_egress_gateway(
  target_node_id bigint,
  gateway_candidates jsonb,
  lease_seconds integer default 900
) returns table(selected_region text, selected_gateway text)
language plpgsql security definer set search_path = public as $$
declare
  candidate jsonb;
begin
  if target_node_id is null or jsonb_typeof(gateway_candidates) <> 'array' or jsonb_array_length(gateway_candidates) = 0 then
    raise exception 'Invalid Blaxel egress gateway reservation request';
  end if;

  -- Serialize allocation across API workers; unique(gateway) remains a second
  -- line of defence if this function is ever called outside the normal worker.
  perform pg_advisory_xact_lock(hashtext('nodenesia:blaxel-egress-gateway-pool'));
  delete from public.blaxel_egress_gateway_leases
    where status = 'reserved' and lease_expires_at < now();

  -- A replacement reaches this point only after its old sandbox was deleted.
  delete from public.blaxel_egress_gateway_leases where node_id = target_node_id;

  select value into candidate
  from jsonb_array_elements(gateway_candidates)
  where coalesce(value->>'region', '') <> '' and coalesce(value->>'gateway', '') <> ''
    and not exists (
      select 1 from public.blaxel_egress_gateway_leases l
      where l.gateway = value->>'gateway'
    )
  order by random()
  limit 1;

  if candidate is null then return; end if;
  insert into public.blaxel_egress_gateway_leases(node_id, gateway, region, status, lease_expires_at)
  values (
    target_node_id,
    candidate->>'gateway',
    candidate->>'region',
    'reserved',
    now() + make_interval(secs => greatest(60, least(3600, lease_seconds)))
  );
  return query select candidate->>'region', candidate->>'gateway';
end;
$$;

create or replace function public.activate_blaxel_egress_gateway_lease(target_node_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.blaxel_egress_gateway_leases
  set status = 'active', lease_expires_at = null, updated_at = now()
  where node_id = target_node_id and status = 'reserved' and lease_expires_at >= now();
  if not found then raise exception 'Blaxel egress gateway lease is not reserved by this node'; end if;
end;
$$;

create or replace function public.release_blaxel_egress_gateway_lease(target_node_id bigint)
returns void language sql security definer set search_path = public as $$
  delete from public.blaxel_egress_gateway_leases where node_id = target_node_id;
$$;

alter table public.blaxel_egress_gateway_leases enable row level security;
revoke all on public.blaxel_egress_gateway_leases from public, anon, authenticated;
revoke all on function public.reserve_blaxel_egress_gateway(bigint, jsonb, integer) from public, anon, authenticated;
revoke all on function public.activate_blaxel_egress_gateway_lease(bigint) from public, anon, authenticated;
revoke all on function public.release_blaxel_egress_gateway_lease(bigint) from public, anon, authenticated;
grant all on public.blaxel_egress_gateway_leases to service_role;
grant execute on function public.reserve_blaxel_egress_gateway(bigint, jsonb, integer) to service_role;
grant execute on function public.activate_blaxel_egress_gateway_lease(bigint) to service_role;
grant execute on function public.release_blaxel_egress_gateway_lease(bigint) to service_role;
