-- Bank application intake (dev job 11d484a4): every SUBMITTED application is archived in CRM Storage,
-- under the Business area, folder BofA / <partner> / <applicant>. These columns record where it went
-- (and why not, if the archive failed, so staff can press "Save to Storage" again).
--
-- Additive and idempotent. Production: apply via the Supabase dashboard (R105) only on Antonio's
-- explicit word; sandbox / local: node scripts/apply-migration.js <file>.

ALTER TABLE public.bofa_intake_requests
  ADD COLUMN IF NOT EXISTS store_owner_id    uuid,
  ADD COLUMN IF NOT EXISTS store_folder_id   uuid,
  ADD COLUMN IF NOT EXISTS store_archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS store_error       text;
