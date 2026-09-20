-- Revoke anonymous (no-login) read/write access to ss4_applications and
-- itin_submissions.
--
-- Both tables had RLS policies granting the `anon` role (and, on
-- itin_submissions, `public` too) unconditional SELECT/UPDATE — and on
-- itin_submissions, INSERT. Any request using only the public anon API key
-- (which ships in the browser bundle) could read or rewrite EVERY row: EIN
-- applications and ITIN applications, including names, dates of birth,
-- foreign addresses/tax ids, and (on the SS-4 side) the ability to forge a
-- "signed" status without ever drawing a signature.
--
-- Verified live before this migration was written: neither table's public
-- signing page (nor the ITIN pre-code email gate) reads or writes the
-- database with the anon key anymore — both were converted this session to
-- go through server routes using the service key instead
-- (/api/ss4/[token]/data, /api/itin-form/[token]/data,
-- /api/itin-form/[token]/gate). Confirmed independently by the repo's own
-- anon-usage AST scanner (tests/unit/anon-grant-contract.test.ts), which
-- fails the build if any real code still needs a privilege this migration
-- removes.
--
-- Scope: ANON role only. `authenticated` and `service_role` grants on these
-- tables are untouched — a separate, lower-severity question, not part of
-- this fix.
--
-- Dev job: 527b2377-a459-4c2e-b1b6-1f392d3d6704

-- ── ss4_applications ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_ss4_by_token" ON ss4_applications;
DROP POLICY IF EXISTS "anon_update_ss4_by_token" ON ss4_applications;
REVOKE SELECT, UPDATE ON ss4_applications FROM anon;

-- ── itin_submissions ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow anon read itin_submissions" ON itin_submissions;
DROP POLICY IF EXISTS "Allow anon update itin_submissions" ON itin_submissions;
DROP POLICY IF EXISTS "Allow anon insert itin_submissions" ON itin_submissions;
DROP POLICY IF EXISTS "Public read itin_submissions by token" ON itin_submissions;
REVOKE SELECT, UPDATE, INSERT ON itin_submissions FROM anon;
