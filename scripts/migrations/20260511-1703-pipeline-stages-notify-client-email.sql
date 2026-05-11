-- Phase 4: Stage Change Notifications
--
-- Adds a per-stage flag controlling whether advancing a service_delivery into
-- this stage triggers a client-facing email (in addition to the always-on push
-- notification handled in lib/service-delivery.ts).
--
-- Only critical, client-facing milestones are flagged true. All other stages
-- remain false — the client still gets a push, but no email, to avoid spam on
-- internal-only transitions.

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS notify_client_email boolean NOT NULL DEFAULT false;

-- Flag the milestone stages listed in the Phase 4 spec. Each stage_name is
-- verified against pipeline_stages in sandbox (2026-05-11):
--   ITIN              → 'Submitted to IRS', 'ITIN Approved'
--   Tax Return        → 'TR Completed', 'TR Filed'
--   Company Formation → 'Post-Formation + Banking', 'Closing'
--   Company Closure   → 'Closing'
UPDATE pipeline_stages
SET notify_client_email = true
WHERE stage_name IN (
  'Submitted to IRS',
  'ITIN Approved',
  'TR Filed',
  'TR Completed',
  'Post-Formation + Banking',
  'Closing'
);
