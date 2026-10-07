-- E-Sign direct upload (dev job 55bdf0dd): the PDF now goes browser -> storage via a signed
-- link, so the app's own 25 MB rule must also be enforced by storage itself. Without a bucket
-- limit the only cap is the project-wide one (500 GB on production, measured 2026-10-07), and
-- the size is otherwise only checked AFTER the server has downloaded the whole object.
--
-- Scope: bucket `signature-requests` (private; holds e-sign source PDFs under esign/<token>/,
-- the esign-staging/ prefix, and the legacy Form 8879 files — the largest object in it today is
-- 3.2 MB). Idempotent. Production: apply via the Supabase dashboard (R105) only on Antonio's
-- explicit word; sandbox: node scripts/apply-migration.js <file> or Storage "edit bucket".
UPDATE storage.buckets
SET file_size_limit = 26214400  -- 25 MiB
WHERE id = 'signature-requests'
  AND (file_size_limit IS DISTINCT FROM 26214400);
