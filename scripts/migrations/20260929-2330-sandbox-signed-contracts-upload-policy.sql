-- Sandbox drift fix (S1 end-to-end QA, 2026-09-29): production has the storage
-- policy "Allow public upload signed contracts" (INSERT, role public,
-- WITH CHECK bucket_id = 'signed-contracts'); sandbox and local stacks did not,
-- so a client signing an offer failed at the signed-PDF upload ("new row
-- violates row-level security policy") and the offer never became signed.
-- No-op in production (the policy already exists — checked in pg_policies).
-- Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Allow public upload signed contracts'
  ) THEN
    CREATE POLICY "Allow public upload signed contracts" ON storage.objects
      FOR INSERT TO public
      WITH CHECK (bucket_id = 'signed-contracts');
  END IF;
END $$;
