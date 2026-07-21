-- 2026-07-21 — Security: revoke anon privileges that NO browser path uses.
--
-- CONTEXT
-- 19 client-facing tables carry permissive RLS policies named "...by token"
-- whose USING/WITH CHECK expression is literally `true`. The anon key ships in
-- the browser bundle, so those tables are effectively world-readable and
-- world-writable. Closing that properly means moving each public form's data
-- access server-side — a staged migration (see the remediation plan / dev job
-- e08ab690). This file is the part that can be done FIRST, with no code change
-- and no client-facing risk.
--
-- WHAT THIS DOES: revokes only the GRANTS that nothing in the browser uses.
-- WHAT THIS DOES NOT DO: it does not DROP or alter a single policy, and it does
-- not touch SELECT. Dropping a `{public}` policy would also cut off the
-- AUTHENTICATED role (staff realtime, the audit page) — REVOKE ... FROM anon is
-- role-scoped and does not.
--
-- HOW THE SAFE SET WAS ESTABLISHED (not assumed — mapped from the code):
-- every usage of `supabasePublic` (lib/supabase/public-client.ts, the anon-key
-- browser client) was parsed for its table + operation. Result:
--   * DELETE  — used by NO browser path, on any table.
--   * INSERT  — used by exactly ONE table, `contracts` (the offer-signing flow:
--               app/offer/[token]/contract/{page,service-agreement,
--               standalone-service-agreement,renewal-agreement}.tsx).
--   * UPDATE  — not used at all for ss4_applications, form_8832_applications,
--               member_info_requests, action_log, email_tracking. Their writes
--               all go through server routes holding the service key
--               (verified: every action_log / email_tracking writer is
--               supabaseAdmin; the SS-4 / 8832 signed uploads go through
--               app/api/{ss4,8832}/[token]/upload-signed).
-- The SS-4 and 8832 signing pages read only (app/ss4/[token]/[code]/page.tsx:67,
-- app/8832/[token]/[code]/page.tsx:58) — verified explicitly, because a wrong
-- call here breaks a live signing flow.
--
-- WHAT IT PROTECTS
--   * the synthetic-row attack: insert a row with status='completed', then POST
--     the public *-form-completed endpoint to drive contact creation, Drive
--     folders, service-delivery creation and staff email from unauthenticated
--     input.
--   * audit-log forgery and flooding (action_log INSERT was world-open, and the
--     staff realtime toast renders its content).
--   * direct DB overwrite of signed SS-4 / 8832 / member-info records.
--
-- ROLLBACK: re-GRANT the same privilege to anon. Seconds, no data change.
--
-- STILL OPEN AFTER THIS: SELECT is untouched, so the read exposure remains.
-- That is the staged server-side migration, not a revoke.

BEGIN;

-- 1) DELETE — no browser path deletes from any of these.
REVOKE DELETE ON
  public.action_log,
  public.annual_agreements,
  public.banking_submissions,
  public.closure_submissions,
  public.contracts,
  public.email_tracking,
  public.form_8832_applications,
  public.formation_submissions,
  public.itin_submissions,
  public.lease_agreements,
  public.member_info_requests,
  public.oa_agreements,
  public.oa_signatures,
  public.offers,
  public.onboarding_submissions,
  public.signature_requests,
  public.ss4_applications,
  public.tax_quote_submissions,
  public.tax_return_submissions
FROM anon;

-- 2) INSERT — only `contracts` is inserted from the browser; it is deliberately
--    NOT in this list.
REVOKE INSERT ON
  public.action_log,
  public.annual_agreements,
  public.banking_submissions,
  public.closure_submissions,
  public.email_tracking,
  public.form_8832_applications,
  public.formation_submissions,
  public.itin_submissions,
  public.lease_agreements,
  public.member_info_requests,
  public.oa_agreements,
  public.oa_signatures,
  public.offers,
  public.onboarding_submissions,
  public.signature_requests,
  public.ss4_applications,
  public.tax_quote_submissions,
  public.tax_return_submissions
FROM anon;

-- 3) UPDATE — only where no browser writer exists at all.
REVOKE UPDATE ON
  public.action_log,
  public.email_tracking,
  public.form_8832_applications,
  public.member_info_requests,
  public.ss4_applications
FROM anon;

-- 4) TRUNCATE — a leftover of Supabase's default blanket grant to anon.
--    NOT reachable through PostgREST (the REST API exposes only
--    SELECT/INSERT/UPDATE/DELETE), so this is not a live exploit path — but
--    TRUNCATE bypasses RLS entirely and would empty a table, so there is no
--    reason for the anonymous role to hold it. Zero legitimate use; revoked as
--    defence in depth.
REVOKE TRUNCATE ON
  public.action_log,
  public.annual_agreements,
  public.banking_submissions,
  public.closure_submissions,
  public.contracts,
  public.email_tracking,
  public.form_8832_applications,
  public.formation_submissions,
  public.itin_submissions,
  public.lease_agreements,
  public.member_info_requests,
  public.oa_agreements,
  public.oa_signatures,
  public.offers,
  public.onboarding_submissions,
  public.signature_requests,
  public.ss4_applications,
  public.tax_quote_submissions,
  public.tax_return_submissions
FROM anon;

COMMIT;
