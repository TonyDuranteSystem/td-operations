-- Council review hardening for the CRM Storage system (2026-09-23), before
-- its first-ever production launch.
--
-- 1. RLS on the three new tables + the crm-files bucket policy excluded only
--    role='client', not the established NON_STAFF_AUTH_ROLES denylist
--    (['client','partner'], lib/team/workspace.ts) that a real 2026-07-22
--    production incident forced this codebase to adopt for internal-only
--    tables. Every app-level route already using supabaseAdmin (service
--    role) bypasses RLS, so this policy is the ONLY thing stopping a
--    partner's own JWT from reading/listing this bucket directly via
--    PostgREST/Storage REST, outside the Next.js app entirely. Three
--    independent council reviewers (System Counselor, Bug-Hunter, Security)
--    converged on this same gap.
--
-- 2. A short-lived, DB-enforced claim per (file, destination) for the two
--    client/team-facing send routes. The existing "check the real message
--    log for a recent duplicate" guard (share-team-chat / share-portal-chat)
--    closes the sequential double-click case but not a genuinely concurrent
--    one: two requests can both pass that SELECT before either has written
--    a message row, since the copy-then-send round trip is multi-second.
--    This table gives each route a real atomic INSERT ... ON CONFLICT claim
--    to hold for the duration of that round trip, released whether the send
--    succeeds or fails, so a legitimate later resend is never blocked.
--    (AI Architect: blocker; Bug-Hunter: same finding, independently.)

alter policy "crm_storage_folders_staff_only" on crm_storage_folders
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));

alter policy "crm_storage_files_staff_only" on crm_storage_files
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));

alter policy "crm_storage_favorites_own_rows" on crm_storage_favorites
  using (user_id = auth.uid() and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  with check (user_id = auth.uid() and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));

alter policy "crm_files_bucket_staff_only" on storage.objects
  using (bucket_id = 'crm-files' and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  with check (bucket_id = 'crm-files' and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));

create table if not exists crm_storage_send_locks (
  file_id uuid not null,
  target text not null,
  claimed_at timestamptz not null default now(),
  primary key (file_id, target)
);

revoke all on crm_storage_send_locks from anon, public;
alter table crm_storage_send_locks enable row level security;
create policy "crm_storage_send_locks_staff_only" on crm_storage_send_locks
  for all
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') not in ('client', 'partner'));
