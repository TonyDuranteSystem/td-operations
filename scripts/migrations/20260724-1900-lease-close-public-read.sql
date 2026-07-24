-- Close the lease anon-READ disclosure (the OA fix, applied to the lease).
--
-- BEFORE: anon held table-level SELECT on lease_agreements and the policy
-- anon_select_lease was USING(true) — so anyone with the anon key (shipped in the
-- JS bundle) could read EVERY lease's access_code, tenant_ein, tenant_email and
-- terms by guessing the token (companySlug-year). The signing pages read the whole
-- row anon and checked the access code in the BROWSER, after delivery.
--
-- AFTER: anon can SELECT only the `id` column (a UUID — not sensitive), which is
-- all the browser needs so the anon UPDATE that records a signature can still match
-- the row by id. All lease DATA now comes from GET /api/lease/[token]/fetch, which
-- runs with the service key, verifies the access code server-side, evaluates the
-- email gate, and returns a whitelist (never access_code / tenant_email).
--
-- ⚠️ ORDER OF DEPLOY IS LOAD-BEARING: ship the CODE first (the pages now read via
-- the fetch route), THEN run this. If this runs while the old pages are still live,
-- their select('*') loses column access and every lease page breaks.
--
-- NOT CLOSED HERE (tracked, step 2 = server-side signing): anon still holds UPDATE
-- on lease_agreements, so the signing write is still browser-side. Revoking that
-- can only happen once signing moves to the server (the old code needs it), exactly
-- as it was sequenced for the OA. This migration closes the READ disclosure only.
--
-- Staff/authenticated reads are untouched: only anon privileges change.

REVOKE SELECT ON public.lease_agreements FROM anon;
GRANT SELECT (id) ON public.lease_agreements TO anon;

DROP POLICY IF EXISTS "anon_select_lease" ON public.lease_agreements;

-- A row must still be visible to anon at the id level, or the anon UPDATE that
-- records the signature (…update(...).eq('id', lease.id)) cannot match it. Column
-- privilege above already limits what "visible" can return to just the id.
CREATE POLICY "lease_row_id_visible_to_anon_for_signing"
  ON public.lease_agreements
  FOR SELECT TO anon
  USING (true);
