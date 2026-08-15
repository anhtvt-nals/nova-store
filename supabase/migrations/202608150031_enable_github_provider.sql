-- The OIDC control plane is now available, so GitHub Actions can participate
-- in normal provider-capacity selection. Capacity remains one runner per key
-- by default; increase it only after testing account/workflow limits.
update public.proxy_providers
set status = 'active'
where code = 'github' and status = 'disabled';
