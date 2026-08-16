-- Blaxel credentials use BLAXEL_WORKSPACE|BLAXEL_API_KEY and are encrypted in
-- provider_api_keys by the API, exactly like E2B, Runloop, and GitHub keys.
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
  'blaxel',
  'Blaxel Sandboxes',
  'https://api.blaxel.ai/v0',
  'active',
  '{"driver":"blaxel","template":"blaxel/base-image:latest"}'::jsonb,
  10,
  1,
  2
)
on conflict (code) do nothing;
