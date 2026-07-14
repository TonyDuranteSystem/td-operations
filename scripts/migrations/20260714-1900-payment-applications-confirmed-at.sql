-- payment_applications.confirmed_at — make the double-credit lock survive a crash.
--
-- WHY (2026-07-14, adversarial code review):
-- The lock is claimed BEFORE the money is written, so that a concurrent double-click
-- loses the race. If the money write then fails, the code deletes the claim. But if the
-- PROCESS DIES between the claim and the write — a function timeout, an out-of-memory,
-- a redeploy mid-cron — nothing deletes it. The claim survives, and every later attempt
-- (automatic or a human clicking Match) is told "already applied".
--
-- That message is FALSE: no money was ever applied. The transaction becomes unbookable
-- through every surface, with no way out but direct database access.
--
-- The fix is the standard claim/commit shape:
--   * insert the claim with confirmed_at NULL;
--   * set confirmed_at once the money has actually landed;
--   * on a unique violation, look at the existing row —
--       confirmed_at IS NOT NULL  → genuinely already applied, refuse (the guard working);
--       confirmed_at IS NULL, old → the previous attempt died before writing, so it is
--                                   safe to take the lock over and retry.
--
-- It also makes the invariant provable, which is the entire reason this table exists:
--   sum(amount) WHERE confirmed_at IS NOT NULL  ==  payments.amount_paid

ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Rows written before this column existed all represent COMPLETED applications
-- (the money write had already succeeded), so confirm them.
UPDATE payment_applications
SET confirmed_at = applied_at
WHERE confirmed_at IS NULL;

COMMENT ON COLUMN payment_applications.confirmed_at IS
  'Set once the money write actually succeeded. NULL = an attempt that claimed the lock but never completed (crashed mid-write); such a claim is stale and may be retaken. Only confirmed rows count toward the sum(amount) == payments.amount_paid invariant.';
