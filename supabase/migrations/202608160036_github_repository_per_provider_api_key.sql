alter table public.provider_api_keys add column if not exists github_repository text;

-- Existing GitHub keys retain the legacy repository so current runners remain
-- manageable. New keys receive their own repository at key-creation time.
update public.provider_api_keys k
set github_repository = 'nodenesia-gost-sandbox'
from public.proxy_providers p
where p.id = k.provider_id and p.code = 'github' and k.github_repository is null;

create unique index if not exists provider_api_keys_github_repository_unique
  on public.provider_api_keys(provider_id, github_repository)
  where github_repository is not null;
