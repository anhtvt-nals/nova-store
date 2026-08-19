-- Separate catalog category for unlimited-bandwidth residential SOCKS5.
-- Idempotent so it is safe for environments where the category was added
-- manually during development.
insert into public.categories(slug, name, description, is_active, sort_order)
values (
  'socks5-residential',
  'SOCKS5 Residential',
  'Unlimited-bandwidth residential SOCKS5 proxy services.',
  true,
  20
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  is_active = true,
  sort_order = excluded.sort_order;
