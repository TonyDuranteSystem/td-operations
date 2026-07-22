-- Close the public READ on the operating-agreement tables.
--
-- ⛔ REVISION 3 — read this before touching the grants or the policies.
--
-- R1 revoked table-level SELECT from anon and nothing else. Three reviewers
-- independently caught, and a live write then PROVED, that this breaks every
-- browser signing write: Postgres requires SELECT on any column read in an
-- UPDATE's condition, and every remaining write is `UPDATE ... WHERE id = $1`.
-- The signing pages never check the result of those writes, so the client would
-- have seen "Signed Successfully" with nothing saved — the exact silent-write
-- failure this job exists to eliminate. R1 was "verified" with reads only; a
-- read test cannot verify a grant change that affects writes.
--
-- R2 added `GRANT SELECT (id)` to fix the privilege half. It was ALSO wrong, and
-- only an end-to-end signing test caught it: the write then returned HTTP 204
-- while changing NOTHING. Dropping the SELECT *policy* makes the row invisible
-- to the UPDATE's WHERE clause, so it matches zero rows — and PostgREST reports
-- a zero-row update as success. A 204 is not proof; re-read the row.
--
-- R3 (this file) separates the two mechanisms, which is what actually works:
--   * PRIVILEGE decides WHICH COLUMNS are readable → column-level GRANT, so
--     access_code / ein_number / member_email are unreadable. This is the fix.
--   * POLICY decides WHICH ROWS are visible → a permissive SELECT policy stays,
--     so the UPDATE's WHERE clause still resolves and signing keeps working.
-- Net effect: `select=*` and `select=access_code` are permission errors, while
-- `select=id` returns opaque UUIDs the signing page is already given by the
-- fetch route. No credential, no PII, and writes are untouched.
--
-- Why not just drop the SELECT policy and be done: RLS cannot scope these tables
-- for an anonymous caller — there is no session or claim to match the token
-- against — so any SELECT policy that keeps signing working is `USING (true)`.
-- Column privileges are the only lever that distinguishes "id" from "access
-- code". The row-level lock has to come from moving the writes server-side.
--
-- WHAT WAS OPEN (verified on production 2026-07-21, dev job 023c7d06) — full
-- inventory, not just the SELECT-named policies:
--   oa_agreements  "Service role full"           ALL     public  auth.role()='service_role'
--   oa_agreements  "Public read by token"        SELECT  public  USING (true)   ← dropped
--   oa_agreements  "Public update by id"         UPDATE  public  USING (true)   ← KEPT
--   oa_signatures  "Allow all for authenticated" ALL     public  USING (true)   ← dropped
--   oa_signatures  "Allow anon select"           SELECT  anon    USING (true)   ← dropped
--   oa_signatures  "Allow anon update"           UPDATE  anon    USING (true)   ← KEPT
--   grants: anon AND authenticated both held SELECT on both tables.
--   RLS: verified ENABLED on both (relrowsecurity = true) — so dropping the
--   permissive policies is a real control here, not a no-op.
--
-- Note "Allow all for authenticated" is misnamed: it is role `public`, cmd ALL,
-- so it granted ANONYMOUS select too. Dropping only the two SELECT-named
-- policies would have left the hole open. Same lying-name pattern as the
-- action_log / email_tracking round of this job.
--
-- WHAT THAT EXPOSED: the public signing pages fetched with `select('*')` using
-- the anon key and compared the access code CLIENT-SIDE, i.e. after the row had
-- already been delivered. Tokens are `${companySlug}-oa-${year}` — no entropy,
-- derivable from a company name that is public in state business registries. One
-- unauthenticated request with the key that ships in the page bundle returned
-- every agreement's access_code, ein_number, member_email and member_address —
-- and every co-signer's personal signing code, the credential that authorises
-- signing AS that member.
--
-- THE CODE HALF SHIPS FIRST AND IS REQUIRED:
--   app/api/operating-agreement/[token]/fetch/route.ts + lib/oa/public-view.ts
-- Running this SQL before that code is live breaks every open signing link.
--
-- WHAT REMAINS READABLE, AND WHY IT IS ACCEPTABLE: `GRANT SELECT (id)` plus the
-- retained SELECT policy means anon can list agreement and signature row IDs —
-- opaque UUIDs, no credential, no PII. They were already obtainable before this
-- change (`select=*` returned them along with everything else), so this is not a
-- widening. Every other column — access_code, ein_number, member_email,
-- member_address, members, signature access codes — is a permission error.
--
-- SCOPE — deliberately NOT closed here (tracked separately):
--   * anon retains UPDATE on both tables. The signing writes are still
--     browser-side, so an attacker who guesses a token can still corrupt an
--     agreement. That is forgery/vandalism, not disclosure. Closing it means
--     moving the writes server-side first.
--   * The `signed-oa` storage bucket is untouched and is anon-readable/listable
--     by token. A SIGNED agreement's PDF — which contains the EIN, member names
--     and addresses — is therefore still retrievable with no access code. This
--     migration closes the CREDENTIALS (access codes, signing codes) and the
--     pre-signature data; it does NOT close the post-signature document. Do not
--     record dev job 023c7d06 as "disclosure fixed" on the strength of this file.
--
-- SAFE FOR EVERYTHING ELSE: every other reader of these tables (portal OA page,
-- CRM dashboard, MCP tools, /api/oa-signed) uses the service key, which bypasses
-- RLS — checked file by file, the only user-session calls in those files are
-- auth checks, not data reads. `increment_oa_signed_count` is SECURITY DEFINER
-- owned by postgres (verified on production), so the revoke does not affect it.

-- ── oa_agreements ─────────────────────────────────────────────────────────
-- Revoke the table-wide privilege, then hand back ONLY the id column. The role
-- keeps row visibility (policy below) so the UPDATE's WHERE clause resolves.
REVOKE SELECT ON public.oa_agreements FROM anon, authenticated;
GRANT SELECT (id) ON public.oa_agreements TO anon;

-- Replace the "read the whole row" policy with one that only grants VISIBILITY.
-- The name is deliberate: it must not read as permission to expose data — the
-- column grant above is what decides that.
DROP POLICY IF EXISTS "Public read by token" ON public.oa_agreements;
CREATE POLICY "Row visible to anon for signing writes"
  ON public.oa_agreements FOR SELECT TO anon USING (true);

-- ── oa_signatures ─────────────────────────────────────────────────────────
-- The ALL/public policy first: it is the one that actually granted anon SELECT.
DROP POLICY IF EXISTS "Allow all for authenticated" ON public.oa_signatures;
DROP POLICY IF EXISTS "Allow anon select" ON public.oa_signatures;
REVOKE SELECT ON public.oa_signatures FROM anon, authenticated;
GRANT SELECT (id) ON public.oa_signatures TO anon;
CREATE POLICY "Row visible to anon for signing writes"
  ON public.oa_signatures FOR SELECT TO anon USING (true);

-- "Public update by id" / "Allow anon update" are INTENTIONALLY LEFT IN PLACE —
-- removing either without moving the signing writes server-side breaks signing.

-- ── VERIFY — run ALL FOUR. The write test is not optional. ─────────────────
--
-- 1. RLS must be ON, or the policy drops did nothing and grants are the only control:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relnamespace='public'::regnamespace AND relname IN ('oa_agreements','oa_signatures');
--    -- expect relrowsecurity = true for both.
--
-- 2. Policies: the visibility policy and the UPDATE policies, nothing else:
--    SELECT tablename, policyname, cmd, roles::text FROM pg_policies
--     WHERE schemaname='public' AND tablename IN ('oa_agreements','oa_signatures')
--     ORDER BY tablename, cmd;
--    -- expect: oa_agreements → "Service role full" (ALL),
--    --                         "Row visible to anon for signing writes" (SELECT),
--    --                         "Public update by id" (UPDATE)
--    --         oa_signatures → "Row visible to anon for signing writes" (SELECT),
--    --                         "Allow anon update" (UPDATE)
--    -- The SELECT policy grants VISIBILITY ONLY — the column grant in step 3 is
--    -- what stops the data being readable. Do not "tidy" one without the other.
--
-- 3. Table-level SELECT gone for BOTH web roles; only the id column remains for anon:
--    SELECT table_name, grantee, privilege_type, column_name
--      FROM information_schema.column_privileges
--     WHERE table_schema='public' AND table_name IN ('oa_agreements','oa_signatures')
--       AND grantee IN ('anon','authenticated') AND privilege_type='SELECT';
--    -- expect: anon/SELECT on column `id` only, and NOTHING for authenticated.
--
-- 4. THE WRITE TEST — the one revision 1 skipped. With the ANON key:
--    curl -s "$URL/rest/v1/oa_agreements?select=access_code,ein_number&limit=1" \
--         -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--    -- expect: permission denied.
--    curl -s -X PATCH "$URL/rest/v1/oa_agreements?id=eq.<a real id>" \
--         -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--         -H "Content-Type: application/json" -d '{"status":"viewed"}' -w "%{http_code}"
--    -- expect: 204 — AND THEN RE-READ THE ROW WITH THE SERVICE KEY TO CONFIRM IT
--    -- ACTUALLY CHANGED. A 204 alone is NOT proof: revision 2 of this file
--    -- returned 204 on an update that silently matched zero rows.
--    Then sign a real test agreement end to end in a browser and confirm the row
--    changed. The pages do not check their own writes, so a screen that says
--    "signed" is not evidence either.
--
-- ROLLBACK (restores the exposure — only if signing is broken):
--   GRANT SELECT ON public.oa_agreements TO anon, authenticated;
--   GRANT SELECT ON public.oa_signatures TO anon, authenticated;
--   CREATE POLICY "Public read by token" ON public.oa_agreements FOR SELECT TO public USING (true);
--   CREATE POLICY "Allow anon select" ON public.oa_signatures FOR SELECT TO anon USING (true);
--   CREATE POLICY "Allow all for authenticated" ON public.oa_signatures FOR ALL TO public USING (true);
