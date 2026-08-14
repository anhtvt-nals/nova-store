-- A proxy product represents an orderable country/market offering.
alter table public.products
  add column country_code char(2) check (country_code is null or country_code ~ '^[A-Z]{2}$');

update public.products
set country_code = 'US'
where service_type = 'proxy' and country_code is null and (code like '%-us' or code like '%us-%' or code = 'socks5-us');

create index products_service_country_idx on public.products(service_type, country_code, is_active);
