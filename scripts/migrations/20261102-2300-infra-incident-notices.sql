-- Supabase-incident notifications: remember which incidents the team was already told about (opened / resolved) so each is announced exactly once.
-- Written only by the cron /api/cron/supabase-status with the service role (no policies: RLS on, nobody else reads or writes). docs/systems/supabase-status.md
create table if not exists public.infra_incident_notices (
  incident_id text primary key,
  title text not null,
  opened_notified_at timestamptz,
  resolved_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.infra_incident_notices enable row level security;
-- every migration that creates a table ends with the marketing lock (20261018-0110): a marketing login can never read or write this table
select public.marketing_lock_all_tables();
