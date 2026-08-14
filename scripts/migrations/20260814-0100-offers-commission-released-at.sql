-- Atomic release gate for a payment-plan deal's referrer/partner commission.
--
-- ⛔ WHY THIS COLUMN EXISTS (bug-hunter, 2026-08-14, code-level pass on the finished
-- release-commission feature): the first version of the release route dedup'd purely in
-- application code (SELECT for an existing referrals/referral_payouts row, then INSERT if
-- none found). Neither table carries anything beyond a primary key — no UNIQUE constraint
-- backs that check — so two near-simultaneous release requests (a slow request + an
-- impatient reload, or two staff members open the same account) can both pass the SELECT
-- and both INSERT, paying the same commission twice. This is the exact TOCTOU shape this
-- codebase already has an established fix for elsewhere (the `reviewed_at IS NULL` +
-- `.is()` guard pattern) — applied here as a single atomic claim on the OFFER itself,
-- BEFORE either the referrer or the partner rail runs, rather than retrofitting a
-- uniqueness constraint onto two shared tables used by many other flows.
--
-- The claim is a single conditional UPDATE: only the request that flips this column from
-- null wins the right to release; every other concurrent or later request sees it already
-- set and refuses cleanly. This also naturally serializes the choice between the referrer
-- and partner rails (see the same commit for `shouldRunReferralCredit`) — only the winning
-- request ever reaches the rail-selection logic at all.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS commission_released_at timestamptz;

COMMENT ON COLUMN offers.commission_released_at IS
  'Set exactly once, atomically, by the release-commission route — the claim gate that prevents a payment-plan deal''s referrer/partner commission from being released twice by a race. Null = not yet released.';
