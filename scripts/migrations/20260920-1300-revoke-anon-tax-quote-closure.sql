-- 2026-09-20 — Security: close anonymous database access on the tax-quote
-- and closure-form public forms.
--
-- Both pages (app/tax-quote/[token]/page.tsx, app/closure-form/[token]/page.tsx
-- + app/closure-form/[token]/[code]/page.tsx) queried Supabase directly from
-- the browser with the anon key. The underlying RLS policies below grant that
-- key unconditional SELECT/UPDATE regardless of the token filter in the
-- query, so anyone with the public anon key could read or rewrite any row on
-- either table with no login. Both pages were converted this same change to
-- server-side routes (app/api/tax-quote/[token]/data,
-- app/api/closure-form/[token]/{gate,data}) that verify the token (and, for
-- closure-form, the access_code or a server-checked email match) themselves
-- using the service role — see lib/public-forms/verify-token-access.ts.
--
-- Exact policy names confirmed live against production via
-- `SELECT tablename, policyname, roles, cmd FROM pg_policies WHERE tablename
-- IN ('tax_quote_submissions','closure_submissions')` before writing this.
--
-- DELETE/INSERT/TRUNCATE on both tables were already revoked from anon by
-- scripts/migrations/20260721-0900-revoke-unused-anon-grants.sql. This
-- migration closes the remaining SELECT/UPDATE.
--
-- No staff/CRM tool is affected: lib/mcp/tools/tax-quote.ts and
-- lib/mcp/tools/closure.ts both read via the service-role client, not the
-- anon client (confirmed via grep before writing this).
--
-- ROLLBACK: re-run the CREATE POLICY statements below with USING (true) /
-- WITH CHECK (true), and re-GRANT SELECT/UPDATE to anon (or public, matching
-- tax_quote_submissions' original role) on the affected table.

BEGIN;

-- tax_quote_submissions
DROP POLICY IF EXISTS "anon_select" ON public.tax_quote_submissions;
DROP POLICY IF EXISTS "anon_update" ON public.tax_quote_submissions;
REVOKE SELECT, UPDATE ON public.tax_quote_submissions FROM anon;
REVOKE SELECT, UPDATE ON public.tax_quote_submissions FROM PUBLIC;

-- closure_submissions
DROP POLICY IF EXISTS "Allow anon read closure_submissions" ON public.closure_submissions;
DROP POLICY IF EXISTS "Allow anon update closure_submissions" ON public.closure_submissions;
REVOKE SELECT, UPDATE ON public.closure_submissions FROM anon;
REVOKE SELECT, UPDATE ON public.closure_submissions FROM PUBLIC;

COMMIT;
