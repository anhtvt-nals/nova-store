create table public.github_runner_tasks (
  id uuid primary key default gen_random_uuid(),
  node_id bigint not null references public.proxy_nodes(id) on delete cascade,
  provider_api_key_id bigint not null references public.provider_api_keys(id) on delete cascade,
  github_owner text not null check (github_owner ~ '^[A-Za-z0-9-]+$'),
  repository text not null default 'nodenesia-gost-sandbox',
  workflow_run_id bigint,
  state text not null default 'pending' check (state in ('pending', 'claimed', 'cancelled', 'completed', 'failed')),
  config_ciphertext text not null,
  config_iv text not null,
  config_tag text not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  cancelled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index github_runner_tasks_key_state_idx on public.github_runner_tasks(provider_api_key_id, state);
create index github_runner_tasks_node_created_idx on public.github_runner_tasks(node_id, created_at desc);
create trigger github_runner_tasks_updated_at before update on public.github_runner_tasks
for each row execute function public.set_updated_at();

alter table public.github_runner_tasks enable row level security;
revoke all on public.github_runner_tasks from anon, authenticated;
grant all on public.github_runner_tasks to service_role;
