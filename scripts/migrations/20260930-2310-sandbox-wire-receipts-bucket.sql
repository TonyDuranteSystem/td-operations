-- Sandbox drift fix (N0 E2E QA, dev job f907220c, 2026-09-30): production has the private
-- storage bucket `wire-receipts` (public=false, no size/type limits — checked in
-- storage.buckets); the local/sandbox stacks did not, so a client's wire-transfer receipt
-- upload failed there ("The related resource does not exist") and could not be tested.
-- No-op in production (the bucket already exists). Idempotent.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wire-receipts', 'wire-receipts', false)
ON CONFLICT (id) DO NOTHING;

SELECT id, public FROM storage.buckets WHERE id IN ('signed-contracts', 'wire-receipts');
