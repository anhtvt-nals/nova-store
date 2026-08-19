-- Residential SOCKS5 is a built-in checkout type, not an admin-created
-- catalog workflow. Keep the product inactive until an administrator assigns
-- a non-zero price in Admin > Proxy > Pricing.
insert into public.products(
  category_id, code, sku, name, description, service_type, proxy_type,
  product_kind, fulfillment_type, base_price, currency, is_active, is_featured
)
select
  category.id,
  'socks5-residential-unlimited',
  'SOCKS5-RES-UNLIMITED',
  'SOCKS5 Residential - Unlimited Bandwidth',
  'Unlimited-bandwidth residential SOCKS5 nodes with automatic hourly IP rotation.',
  'proxy',
  'residential',
  'service',
  'service',
  0,
  'USD',
  false,
  false
from public.categories category
where category.slug = 'socks5-residential'
on conflict (code) do nothing;
