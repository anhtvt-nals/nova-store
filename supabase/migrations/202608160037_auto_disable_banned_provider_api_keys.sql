-- Record why a provider API key was revoked so an automatic ban/suspension
-- disablement (triggered by the provisioning rotation worker) is distinguishable
-- from a manual admin revoke.
alter table public.provider_api_keys
  add column revoked_reason text;
