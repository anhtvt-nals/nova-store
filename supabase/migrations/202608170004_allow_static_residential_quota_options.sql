-- Checkout supports fixed 1GB, 3GB, and 5GB shared traffic packages. The
-- original table constraint only allowed the initial 5GB package.
alter table public.static_residential_orders
  drop constraint if exists static_residential_orders_quota_bytes_check;

alter table public.static_residential_orders
  add constraint static_residential_orders_quota_bytes_check
  check (quota_bytes in (1073741824, 3221225472, 5368709120));
