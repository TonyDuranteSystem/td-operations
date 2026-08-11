-- SANDBOX-ONLY storage-policy alignment (dev job ca788354 QA, 2026-08-11).
--
-- Production has this policy on storage.objects; sandbox never got it, so the
-- PUBLIC contract-signing page's anon upload to `signed-contracts` 403s with
-- "new row violates row-level security policy" and the client sees the honest
-- "your signature was not saved" failure. Found during Antonio's sandbox
-- fresh-eyes pass when signing the QA fixture offer.
--
-- Copied VERBATIM from production pg_policy:
--   polname:  "Allow public upload signed contracts"
--   polcmd:   a (INSERT)
--   with check: (bucket_id = 'signed-contracts'::text)
--
-- Do NOT promote to production — production already has it.

CREATE POLICY "Allow public upload signed contracts"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'signed-contracts'::text);
