-- GitHub Actions credentials are stored in the existing encrypted provider-key vault.
insert into public.proxy_providers(
  code,
  name,
  api_base_url,
  status,
  metadata,
  max_sandboxes,
  reserved_replacement_slots,
  max_concurrent_provisions
)
values (
  'github',
  'GitHub Actions',
  'https://api.github.com',
  'active',
  '{"driver":"github","repository":"nodenesia-gost-sandbox","visibility":"public"}'::jsonb,
  1,
  0,
  1
)
on conflict (code) do nothing;
