-- Close the public READ on the operating-agreement tables.
--
-- WHAT WAS OPEN (verified on production 2026-07-21, dev job 023c7d06):
--
--   oa_agreements   policy "Public read by token"   SELECT  role public  USING (true)
--   oa_signatures   policy "Allow all for authenticated"  ALL  role public  USING (true)
--   oa_signatures   policy "Allow anon select"      SELECT  role anon    USING (true)
--   grants: anon holds SELECT on BOTH tables.
--
-- Note the second policy's name is a lie — it is role `public`, not
-- `authenticated`, and `cmd = ALL`, so it granted anonymous SELECT as well.
-- Dropping only the two SELECT-named policies would have left the hole open.
-- Same misnaming pattern as the action_log / email_tracking round of this job.
--
-- WHAT THAT EXPOSED: the public signing pages fetched with `select('*')` using
-- the anon key and compared the access code CLIENT-SIDE, i.e. after the row had
-- already been delivered. Tokens are `${companySlug}-oa-${year}` — no entropy,
-- derivable from a company name that is public in state business registries. So
-- a single unauthenticated PostgREST request, with the key that ships in the
-- page bundle, returned for any of the 187 agreements:
--   access_code, ein_number, member_email, member_address, members[]
-- and from oa_signatures, EVERY co-signer's personal signing code — the
-- credential that authorises signing AS that member.
--
-- THE CODE HALF OF THIS FIX SHIPS FIRST AND IS REQUIRED:
--   app/api/operating-agreement/[token]/fetch/route.ts  (service key, verifies
--   the code server-side, returns a whitelist — lib/oa/public-view.ts)
-- Both public pages now read through it. Running this SQL BEFORE that code is
-- live breaks every open signing link. Order: deploy, verify, then run this.
--
-- SCOPE — deliberately NOT closed here (Stage B, tracked separately):
--   anon retains UPDATE on both tables. The signing page still writes its
--   signature row, the counter and the final status directly from the browser.
--   That is a FORGERY/vandalism exposure (an attacker who guesses a token can
--   still corrupt an agreement), not a DISCLOSURE one. It cannot be revoked
--   until those writes move server-side too, and doing both in one change would
--   mean rewriting the signing flow — which the council explicitly said not to
--   attempt in the same pass. This migration halves the problem; it does not
--   claim to close it.
--
-- SAFE FOR EVERYTHING ELSE: every other reader of these tables (the portal OA
-- page, the CRM dashboard, the MCP tools, /api/oa-signed) uses the service key,
-- which bypasses RLS. Verified by inspection: only the two public pages used the
-- anon client, and both now go through the route.

-- ── oa_agreements ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Public read by token" ON public.oa_agreements;
REVOKE SELECT ON public.oa_agreements FROM anon;

-- ── oa_signatures ─────────────────────────────────────────────────────────
-- The ALL/public policy first: it is the one that actually granted anon SELECT.
DROP POLICY IF EXISTS "Allow all for authenticated" ON public.oa_signatures;
DROP POLICY IF EXISTS "Allow anon select" ON public.oa_signatures;
REVOKE SELECT ON public.oa_signatures FROM anon;

-- "Allow anon update" is INTENTIONALLY LEFT IN PLACE — see the scope note above.
-- Removing it without moving the signing writes server-side breaks signing.

-- ── VERIFY (expect: no SELECT policy on either table, no anon SELECT grant,
--    and the anon UPDATE path still present so signing keeps working) ───────
--
--   SELECT tablename, policyname, cmd, roles::text, qual
--     FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('oa_agreements','oa_signatures')
--    ORDER BY tablename, cmd;
--   -- expect: oa_agreements → "Service role full" (ALL), "Public update by id" (UPDATE)
--   --         oa_signatures → "Allow anon update" (UPDATE)
--   --         and NO SELECT row for either table.
--
--   SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--     FROM information_schema.role_table_grants
--    WHERE table_schema='public' AND table_name IN ('oa_agreements','oa_signatures')
--      AND grantee = 'anon'
--    GROUP BY table_name, grantee;
--   -- expect: UPDATE (and REFERENCES/TRIGGER), but NOT SELECT.
--
-- Then prove the leak is actually closed, from outside, with the public key:
--   curl -s "$SUPABASE_URL/rest/v1/oa_agreements?select=access_code,ein_number&limit=1" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--   -- expect: a permission error. Before this migration it returned the data.
--
-- ROLLBACK (restores the exposure — only if signing is broken and the code fix
-- must be reverted in a hurry):
--   GRANT SELECT ON public.oa_agreements TO anon;
--   GRANT SELECT ON public.oa_signatures TO anon;
--   CREATE POLICY "Public read by token" ON public.oa_agreements FOR SELECT TO public USING (true);
--   CREATE POLICY "Allow anon select" ON public.oa_signatures FOR SELECT TO anon USING (true);
