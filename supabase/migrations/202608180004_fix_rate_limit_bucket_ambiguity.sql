-- PostgreSQL can treat the `bucket_key` function parameter and the table
-- column used by ON CONFLICT as an ambiguous PL/pgSQL reference. Keep the RPC
-- signature stable for deployed API clients, but use positional parameters and
-- the named primary-key constraint internally.

create or replace function public.consume_api_rate_limit(
  bucket_key text,
  max_requests integer,
  window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_count integer;
begin
  if $1 is null
    or length($1) > 300
    or $2 < 1 or $2 > 10000
    or $3 < 1 or $3 > 86400 then
    raise exception 'Invalid rate limit parameters';
  end if;

  insert into public.api_rate_limit_buckets(bucket_key, request_count, reset_at)
  values ($1, 1, now() + make_interval(secs => $3))
  on conflict on constraint api_rate_limit_buckets_pkey do update set
    request_count = case
      when public.api_rate_limit_buckets.reset_at <= now() then 1
      else public.api_rate_limit_buckets.request_count + 1
    end,
    reset_at = case
      when public.api_rate_limit_buckets.reset_at <= now() then now() + make_interval(secs => $3)
      else public.api_rate_limit_buckets.reset_at
    end,
    updated_at = now()
  returning public.api_rate_limit_buckets.request_count into current_count;

  if random() < 0.002 then
    delete from public.api_rate_limit_buckets
    where reset_at < now() - interval '1 day';
  end if;
  return current_count <= $2;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer)
  to service_role;
