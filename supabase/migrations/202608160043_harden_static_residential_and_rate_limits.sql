-- Safe upgrade for installations where 202608160042 has already been applied.
alter table public.static_residential_nodes drop constraint if exists static_residential_nodes_upstream_proxy_id_key;
create unique index if not exists static_residential_nodes_active_upstream_idx
  on public.static_residential_nodes(upstream_proxy_id) where status = 'active';

-- Persistent, atomic rate limiting for costly state-changing endpoints. This
-- avoids reset/bypass on API restart or when the API is horizontally scaled.
create table if not exists public.api_rate_limit_buckets (
  bucket_key text primary key,
  request_count integer not null check (request_count >= 0),
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists api_rate_limit_buckets_reset_idx on public.api_rate_limit_buckets(reset_at);

create or replace function public.consume_api_rate_limit(bucket_key text, max_requests integer, window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare current_count integer;
begin
  if length(bucket_key) > 300 or max_requests < 1 or max_requests > 10000 or window_seconds < 1 or window_seconds > 86400 then
    raise exception 'Invalid rate limit parameters';
  end if;
  insert into public.api_rate_limit_buckets(bucket_key, request_count, reset_at)
  values (bucket_key, 1, now() + make_interval(secs => window_seconds))
  on conflict (bucket_key) do update set
    request_count = case when public.api_rate_limit_buckets.reset_at <= now() then 1 else public.api_rate_limit_buckets.request_count + 1 end,
    reset_at = case when public.api_rate_limit_buckets.reset_at <= now() then now() + make_interval(secs => window_seconds) else public.api_rate_limit_buckets.reset_at end,
    updated_at = now()
  returning request_count into current_count;
  if random() < 0.002 then delete from public.api_rate_limit_buckets where reset_at < now() - interval '1 day'; end if;
  return current_count <= max_requests;
end;
$$;

alter table public.api_rate_limit_buckets enable row level security;
revoke all on public.api_rate_limit_buckets from public, anon, authenticated;
revoke all on function public.consume_api_rate_limit(text, integer, integer) from public, anon, authenticated;
grant all on public.api_rate_limit_buckets to service_role;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;
