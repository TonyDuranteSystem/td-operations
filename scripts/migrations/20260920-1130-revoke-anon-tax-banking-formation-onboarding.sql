-- Revoke anonymous (no-login) read/write access to tax_return_submissions,
-- banking_submissions, formation_submissions, and onboarding_submissions.
--
-- Same class of fix as 20260919-2300-revoke-anon-ss4-itin.sql (EIN/ITIN),
-- applied to the tax intake form, the banking setup form, the LLC formation
-- form, and the onboarding form. All four had RLS policies granting the
-- anon role (and PUBLIC) unconditional SELECT/UPDATE(/INSERT on some) — any
-- request using only the public anon API key could read or rewrite any
-- real client's submission.
--
-- Verified live before this migration was written: none of the eight real
-- pages (bare email-gated page + [code] page, for each of the four forms)
-- read or write these tables with the anon key anymore — all converted to
-- server routes using the service key
-- (/api/{tax-form,banking-form,formation-form,onboarding-form}/[token]/data
-- and .../gate). Confirmed independently by the repo's own anon-usage AST
-- scanner (tests/unit/anon-grant-contract.test.ts).
--
-- Scope: ANON and PUBLIC pseudo-role on these four tables only.
-- `authenticated`/`service_role` grants are untouched. File uploads
-- (client-attached documents/bank statements) still go directly to storage
-- with the anon key — a separate, already-tracked, already-accepted
-- exposure class (ANON_REACHABLE_BUCKETS in the contract test), not part of
-- this fix.
--
-- Dev job: 527b2377-a459-4c2e-b1b6-1f392d3d6704

-- ── tax_return_submissions ───────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow read by token" ON tax_return_submissions;
DROP POLICY IF EXISTS "Allow update by token" ON tax_return_submissions;
REVOKE SELECT, UPDATE ON tax_return_submissions FROM anon;
REVOKE SELECT, UPDATE ON tax_return_submissions FROM PUBLIC;

-- ── banking_submissions ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "anon_read_banking" ON banking_submissions;
DROP POLICY IF EXISTS "anon_update_banking" ON banking_submissions;
REVOKE SELECT, UPDATE ON banking_submissions FROM anon;
REVOKE SELECT, UPDATE ON banking_submissions FROM PUBLIC;

-- ── formation_submissions ────────────────────────────────────────────────
DROP POLICY IF EXISTS "formation_submissions_anon_read" ON formation_submissions;
DROP POLICY IF EXISTS "formation_submissions_anon_update" ON formation_submissions;
REVOKE SELECT, UPDATE ON formation_submissions FROM anon;
REVOKE SELECT, UPDATE ON formation_submissions FROM PUBLIC;

-- ── onboarding_submissions ───────────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public read by token" ON onboarding_submissions;
DROP POLICY IF EXISTS "Allow public update by token" ON onboarding_submissions;
REVOKE SELECT, UPDATE ON onboarding_submissions FROM anon;
REVOKE SELECT, UPDATE ON onboarding_submissions FROM PUBLIC;
