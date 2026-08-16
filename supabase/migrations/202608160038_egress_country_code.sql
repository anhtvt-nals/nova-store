-- Resolve and store the egress country for a proxy node's active sandbox,
-- alongside the existing egress IP, so the client node info can show which
-- country the traffic is currently egressing from (in addition to the IP).
alter table public.proxy_nodes
  add column egress_country_code char(2) check (egress_country_code ~ '^[A-Z]{2}$');

drop function if exists public.complete_proxy_provisioning(bigint, text, text, text, text, integer, timestamptz);
create or replace function public.complete_proxy_provisioning(
  target_job_id bigint,
  worker_id text,
  external_instance_id text,
  reported_egress_ip text,
  reported_egress_country_code text,
  reported_public_host text,
  reported_tunnel_port integer,
  reported_next_rotation_at timestamptz
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  order_row public.orders%rowtype;
  remaining_nodes integer;
  now_at timestamptz := now();
  order_expires_at timestamptz;
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.status <> 'running' or job_row.locked_by <> worker_id then raise exception 'Provisioning job lease is not owned by worker'; end if;
  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;
  select * into order_row from public.orders where id = node_row.order_id for update;

  update public.proxy_nodes set status = 'online', current_instance_id = external_instance_id,
    egress_ip = nullif(reported_egress_ip, '')::inet,
    egress_country_code = nullif(upper(reported_egress_country_code), ''),
    public_host = reported_public_host,
    tunnel_port = reported_tunnel_port, last_health_at = now_at, last_status_change_at = now_at,
    next_rotation_at = reported_next_rotation_at, error_code = null, error_message = null,
    health = jsonb_build_object('reachable', true, 'checkedAt', now_at)
  where id = node_row.id;

  update public.proxy_provisioning_jobs set status = 'completed', locked_by = null, locked_until = null
  where id = target_job_id;

  update public.provider_capacity_leases set status = 'active',
    lease_expires_at = now_at + make_interval(days => order_row.rental_days)
  where node_id = node_row.id and released_at is null;

  select count(*) into remaining_nodes
  from public.proxy_nodes nodes
  left join public.proxy_provisioning_jobs jobs
    on jobs.node_id = nodes.id and jobs.action = 'provision'
  where nodes.order_id = order_row.id and jobs.status is distinct from 'completed';

  if remaining_nodes = 0 then
    order_expires_at := now_at + make_interval(days => order_row.rental_days);
    update public.orders set status = 'active', activated_at = now_at, expires_at = order_expires_at
    where id = order_row.id;
    update public.proxy_nodes set expires_at = order_expires_at where order_id = order_row.id;
    update public.provider_capacity_leases set lease_expires_at = order_expires_at
    where node_id in (select id from public.proxy_nodes where order_id = order_row.id) and released_at is null;
  end if;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.status', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'online',
    'egressIp', reported_egress_ip, 'egressCountryCode', reported_egress_country_code,
    'nextRotationAt', reported_next_rotation_at
  ));
end;
$$;

revoke all on function public.complete_proxy_provisioning(bigint, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_proxy_provisioning(bigint, text, text, text, text, text, integer, timestamptz) to service_role;

drop function if exists public.complete_proxy_replacement(bigint, text, text, text, timestamptz);
create or replace function public.complete_proxy_replacement(
  target_job_id bigint,
  worker_id text,
  external_instance_id text,
  reported_egress_ip text,
  reported_egress_country_code text,
  reported_next_rotation_at timestamptz
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.proxy_provisioning_jobs%rowtype;
  node_row public.proxy_nodes%rowtype;
  order_row public.orders%rowtype;
  replacement_lease public.provider_capacity_leases%rowtype;
  now_at timestamptz := now();
begin
  select * into job_row from public.proxy_provisioning_jobs where id = target_job_id for update;
  if not found or job_row.action <> 'replace' or job_row.status <> 'running' or job_row.locked_by <> worker_id then
    raise exception 'Replacement job lease is not owned by worker';
  end if;

  select * into node_row from public.proxy_nodes where id = job_row.node_id for update;
  select * into order_row from public.orders where id = node_row.order_id for update;
  if order_row.status <> 'active' or order_row.expires_at <= now_at then raise exception 'Order is not active'; end if;

  select * into replacement_lease
  from public.provider_capacity_leases
  where node_id = node_row.id and purpose = 'replacement' and leased_by = worker_id
    and released_at is null and lease_expires_at >= now_at
  for update;
  if not found then raise exception 'Replacement capacity lease is not owned by worker'; end if;

  update public.provider_capacity_leases set status = 'released', released_at = now_at
  where node_id = node_row.id and purpose = 'customer' and released_at is null;

  update public.provider_capacity_leases set
    purpose = 'customer', status = 'active', leased_by = worker_id,
    lease_expires_at = order_row.expires_at
  where id = replacement_lease.id;

  update public.proxy_nodes set
    provider_id = replacement_lease.provider_id,
    provider_api_key_id = replacement_lease.provider_api_key_id,
    status = 'online', current_instance_id = external_instance_id,
    egress_ip = nullif(reported_egress_ip, '')::inet,
    egress_country_code = nullif(upper(reported_egress_country_code), ''),
    last_health_at = now_at, last_status_change_at = now_at,
    next_rotation_at = reported_next_rotation_at,
    error_code = null, error_message = null,
    health = jsonb_build_object('reachable', true, 'checkedAt', now_at)
  where id = node_row.id;

  update public.proxy_provisioning_jobs set
    status = 'completed', locked_by = null, locked_until = null, last_error = null
  where id = target_job_id;

  insert into public.proxy_node_events(node_id, profile_id, event_type, payload)
  values (node_row.id, node_row.profile_id, 'proxy.node.restarted', jsonb_build_object(
    'nodeId', node_row.id, 'orderId', order_row.id, 'status', 'online',
    'egressIp', reported_egress_ip, 'egressCountryCode', reported_egress_country_code,
    'nextRotationAt', reported_next_rotation_at
  ));
end;
$$;

revoke all on function public.complete_proxy_replacement(bigint, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_proxy_replacement(bigint, text, text, text, text, timestamptz) to service_role;
