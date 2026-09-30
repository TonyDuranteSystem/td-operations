-- N0 (dev job f907220c, Antonio approved plan v3 2026-09-30): LOCK offers, contracts and
-- annual_agreements, and the two signing upload buckets, against the public key and against
-- logged-in clients/partners.
--
-- ⛔ RUN ONLY AFTER the N0 code is live and verified (ship 1). Before that code, the offer,
--    contract and signing pages read/write these tables from the browser with the public key,
--    and this lock would break signing for every client. The repo's anon-usage AST contract
--    (tests/unit/anon-grant-contract.test.ts) confirms the code no longer needs any anon
--    privilege on these three tables.
--
-- What it closes (production, verified 2026-09-30):
--   offers     "Allow public read by token"  SELECT to public USING (true)   -> anyone reads every offer
--              "Allow service update"         UPDATE to public USING (true)   -> anyone rewrites any offer
--              "auth_read"                    SELECT to authenticated (true)  -> every portal client reads every offer
--   contracts  "Allow public insert/read/update contracts" to public (true) -> anyone reads/forges signed contracts
--   storage    "Allow public upload signed contracts" INSERT to public, "Allow public upload to wire-receipts"
--              INSERT to anon -> anyone plants files in the signing buckets
--
-- What still works afterwards:
--   • every server route (service role bypasses RLS);
--   • the three CRM pages that read offers/contracts with the STAFF session (leads, contacts,
--     client health) — via the staff-only read policies below (admin/team; never client, partner
--     or a login without a role — production has none of the latter, checked 2026-09-30);
--   • annual_agreements keeps its existing client_read_own + service_role_all policies.
--
-- UNDO: scripts/migrations/20260930-2300-n0-lock-offers-contracts-renewals.UNDO.sql
-- Idempotent: safe to run twice.

BEGIN;

-- ── offers ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public read by token" ON public.offers;
DROP POLICY IF EXISTS "Allow service update" ON public.offers;
DROP POLICY IF EXISTS "auth_read" ON public.offers;
REVOKE ALL ON public.offers FROM anon;
REVOKE ALL ON public.offers FROM PUBLIC;
DROP POLICY IF EXISTS "offers_staff_read" ON public.offers;
CREATE POLICY "offers_staff_read" ON public.offers
  FOR SELECT TO authenticated
  USING (lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) IN ('admin', 'team'));

-- ── contracts ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public insert contracts" ON public.contracts;
DROP POLICY IF EXISTS "Allow public read contracts by offer_token" ON public.contracts;
DROP POLICY IF EXISTS "Allow public update contracts" ON public.contracts;
REVOKE ALL ON public.contracts FROM anon;
REVOKE ALL ON public.contracts FROM PUBLIC;
DROP POLICY IF EXISTS "contracts_staff_read" ON public.contracts;
CREATE POLICY "contracts_staff_read" ON public.contracts
  FOR SELECT TO authenticated
  USING (lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) IN ('admin', 'team'));

-- ── annual_agreements (policies already correct; the anon GRANTS go) ──────
REVOKE ALL ON public.annual_agreements FROM anon;
REVOKE ALL ON public.annual_agreements FROM PUBLIC;

-- ── signing upload buckets (uploads now only via server-issued one-time links) ──
DROP POLICY IF EXISTS "Allow public upload signed contracts" ON storage.objects;
DROP POLICY IF EXISTS "Allow public upload to wire-receipts" ON storage.objects;

COMMIT;

-- Check (expected: offers → offers_staff_read only; contracts → contracts_staff_read only;
-- annual_agreements → client_read_own + service_role_all; no storage rows; anon holds nothing).
SELECT 'policy' AS kind, tablename AS object, policyname AS name, cmd, roles::text AS roles
FROM pg_policies
WHERE (schemaname = 'public' AND tablename IN ('offers', 'contracts', 'annual_agreements'))
   OR (schemaname = 'storage' AND tablename = 'objects'
       AND policyname IN ('Allow public upload signed contracts', 'Allow public upload to wire-receipts'))
UNION ALL
SELECT 'anon grant', table_name, privilege_type, NULL, grantee
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('offers', 'contracts', 'annual_agreements') AND grantee = 'anon'
ORDER BY 1, 2, 3;
