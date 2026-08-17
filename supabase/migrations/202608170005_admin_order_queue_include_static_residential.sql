-- A single, read-only admin queue for standard SOCKS5 and static residential
-- orders. Keeping the UNION in the database preserves server-side pagination.
create or replace view public.admin_order_queue
with (security_invoker = true) as
select
  'proxy'::text as source,
  o.id as source_id,
  p.email as customer_email,
  o.plan_name_snapshot as plan_name,
  o.node_count,
  o.rental_days,
  null::integer as quota_gb,
  o.status,
  o.payment_method,
  o.amount,
  o.created_at,
  o.activated_at,
  o.expires_at
from public.orders o
left join public.profiles p on p.id = o.profile_id
union all
select
  'static_residential'::text as source,
  o.id as source_id,
  p.email as customer_email,
  'US Static Residential Proxy'::text as plan_name,
  o.node_count,
  greatest(1, ceil(extract(epoch from (o.expires_at - coalesce(o.activated_at, o.created_at))) / 86400))::integer as rental_days,
  (o.quota_bytes / 1073741824)::integer as quota_gb,
  o.status,
  'credit'::text as payment_method,
  o.amount,
  o.created_at,
  o.activated_at,
  o.expires_at
from public.static_residential_orders o
left join public.profiles p on p.id = o.profile_id;

revoke all on public.admin_order_queue from public, anon, authenticated;
grant select on public.admin_order_queue to service_role;
