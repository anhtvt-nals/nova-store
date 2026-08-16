-- Last cumulative counters received from each sandbox GOST observer. Keeping
-- the last value makes observer retries idempotent and handles restarts.
create table public.proxy_node_usage_counters (
  node_id bigint primary key references public.proxy_nodes(id) on delete cascade,
  total_connections bigint not null default 0 check (total_connections >= 0),
  input_bytes bigint not null default 0 check (input_bytes >= 0),
  output_bytes bigint not null default 0 check (output_bytes >= 0),
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.record_proxy_node_usage_observation(
  target_node_id bigint,
  observed_connections bigint,
  observed_input_bytes bigint,
  observed_output_bytes bigint
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  node_row public.proxy_nodes%rowtype;
  order_row public.orders%rowtype;
  counter_row public.proxy_node_usage_counters%rowtype;
  request_delta bigint := 0;
  byte_delta bigint := 0;
begin
  if observed_connections < 0 or observed_input_bytes < 0 or observed_output_bytes < 0 then
    raise exception 'Usage counters must be non-negative';
  end if;
  select * into node_row from public.proxy_nodes where id = target_node_id for update;
  if not found then raise exception 'Proxy node not found'; end if;
  select * into order_row from public.orders where id = node_row.order_id;
  if not found then raise exception 'Order not found'; end if;
  select * into counter_row from public.proxy_node_usage_counters where node_id = target_node_id for update;

  if found then
    request_delta := case when observed_connections >= counter_row.total_connections then observed_connections - counter_row.total_connections else observed_connections end;
    byte_delta := (case when observed_input_bytes >= counter_row.input_bytes then observed_input_bytes - counter_row.input_bytes else observed_input_bytes end)
      + (case when observed_output_bytes >= counter_row.output_bytes then observed_output_bytes - counter_row.output_bytes else observed_output_bytes end);
    update public.proxy_node_usage_counters set total_connections = observed_connections, input_bytes = observed_input_bytes,
      output_bytes = observed_output_bytes, observed_at = now(), updated_at = now() where node_id = target_node_id;
  else
    request_delta := observed_connections;
    byte_delta := observed_input_bytes + observed_output_bytes;
    insert into public.proxy_node_usage_counters(node_id, total_connections, input_bytes, output_bytes)
    values (target_node_id, observed_connections, observed_input_bytes, observed_output_bytes);
  end if;

  if request_delta > 0 or byte_delta > 0 then
    insert into public.usage_daily(profile_id, resource_id, usage_date, requests, successful_requests, bytes_transferred)
    values (node_row.profile_id, order_row.resource_id, current_date, request_delta, request_delta, byte_delta)
    on conflict (profile_id, resource_id, usage_date) do update set
      requests = public.usage_daily.requests + excluded.requests,
      successful_requests = public.usage_daily.successful_requests + excluded.successful_requests,
      bytes_transferred = public.usage_daily.bytes_transferred + excluded.bytes_transferred;
  end if;
end;
$$;

revoke all on public.proxy_node_usage_counters from public, anon, authenticated;
revoke all on function public.record_proxy_node_usage_observation(bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant all on public.proxy_node_usage_counters to service_role;
grant execute on function public.record_proxy_node_usage_observation(bigint, bigint, bigint, bigint) to service_role;
