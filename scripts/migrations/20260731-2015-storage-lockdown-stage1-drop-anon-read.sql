-- ============================================================================
-- STORAGE LOCKDOWN — STAGE 1: revoke anonymous/public READ on intake buckets
-- ============================================================================
-- Bug card 97177e49. Full-council reviewed (FIX-FIRST, strategy sound).
--
-- PROVEN exposure (external read-only test 2026-07-31, no login): the prod anon
-- key ships in the public /portal/login JS; with it alone, `object/list/<bucket>`
-- returned real client folder names and `object/<bucket>/<path>` downloaded a real
-- 12-page signed client contract. Root cause: SELECT policies on storage.objects
-- granted to anon/PUBLIC that OVERRIDE each bucket's private flag.
--
-- STAGE 1 = the buckets whose anon SELECT has NO client-facing reader (every reader
-- is server-side service-role, which bypasses RLS; every writer is an anon INSERT
-- that needs only the INSERT policy, which we KEEP). Verified by SE + Bug-Hunter.
--
-- We DROP SELECT ONLY. We KEEP every INSERT policy so the intake form uploads
-- (onboarding-form, banking-form, wire-receipt) keep working unchanged.
--
-- DELIBERATELY NOT the June-13 file (20260613-fix-storage-security.sql): that one
-- ALSO dropped INSERT and re-keyed reads to auth.jwt email, which would 403 the
-- anonymous intake uploads. This migration supersedes its onboarding section.
--
-- Policy names below are the EXACT live PROD names (verified against pg_policy
-- 2026-07-31). Per-environment name drift is real (sandbox differs), so DROP ...
-- IF EXISTS is used and each drop is re-verified against live pg_policy at apply
-- time. No client-facing reader depends on any of these SELECT policies.
-- ============================================================================

-- onboarding-uploads (555 objects) — readers all service-role; writer is the anon
-- onboarding-form INSERT ("Allow public upload onboarding", KEPT).
drop policy if exists "Allow public read onboarding" on storage.objects;

-- banking-uploads (14 objects) — no reader at all; writer is anon banking-form
-- INSERT ("anon_upload_banking_files", KEPT).
drop policy if exists "anon_read_banking_files" on storage.objects;

-- itin-uploads (0 objects) — no reader, effectively legacy; INSERT kept.
drop policy if exists "Allow anon read itin-uploads" on storage.objects;

-- wire-receipts (15 objects) — NO reader (the two code sites are POST uploads, not
-- reads); pure exposure. INSERT ("Allow public upload to wire-receipts", KEPT).
drop policy if exists "Allow public read from wire-receipts" on storage.objects;

-- formation-uploads (0 objects) — has NO storage.objects policy; exposed purely via
-- the bucket's public=true flag (passports are coded to route here). Flip private.
-- No client-facing reader depends on the public flag (readers are service-role).
update storage.buckets set public = false where id = 'formation-uploads';

-- ============================================================================
-- KEPT (do NOT drop) — the intake WRITE path, still needed:
--   "Allow public upload onboarding"      (INSERT) onboarding-uploads
--   "anon_upload_banking_files"           (INSERT) banking-uploads
--   "Allow anon upload itin-uploads"      (INSERT) itin-uploads
--   "Allow public upload to wire-receipts"(INSERT) wire-receipts
--
-- OUT OF SCOPE for Stage 1 (later stages, tracked on card 97177e49):
--   signed-contracts / signed-leases  -> Stage 2 (client downloads them; build a
--       checked server route that signs the DB-RECORDED path, then revoke SELECT).
--   assets (833 objects, public bucket, zero-key) -> Stage 3, committed date.
--   tax-form-uploads (authenticated SELECT = client-to-client read) -> Stage 3.
--   The anon INSERT ("plant a file") exposure -> deferred; harmless for Stage-1
--       buckets because nothing serves list-newest from them to a client.
-- ============================================================================

-- ROLLBACK (re-opens the hole — for reference only, do not apply casually):
--   create policy "Allow public read onboarding" on storage.objects for select using (bucket_id = 'onboarding-uploads');
--   create policy "anon_read_banking_files" on storage.objects for select using (bucket_id = 'banking-uploads');
--   create policy "Allow anon read itin-uploads" on storage.objects for select to anon using (bucket_id = 'itin-uploads');
--   create policy "Allow public read from wire-receipts" on storage.objects for select to anon using (bucket_id = 'wire-receipts');
--   update storage.buckets set public = true where id = 'formation-uploads';
