-- GOST 3.2.x exposes per-service Prometheus counters but has no persistent
-- lifetime quota API. Store the last observed counter value per public port so
-- Nest can persist cumulative order usage across GOST/API restarts.
alter table public.static_residential_nodes
  add column if not exists metric_bytes_observed bigint not null default 0 check (metric_bytes_observed >= 0);
