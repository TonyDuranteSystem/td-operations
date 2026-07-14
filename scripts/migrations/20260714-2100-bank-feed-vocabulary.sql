-- Bank-feed vocabulary — align the database with the code, and stop them drifting again.
--
-- WHY (2026-07-14, the post-ship incident):
-- `td_bank_feeds` has a CHECK constraint listing the permitted `status` values. It was
-- written when the table was created and never updated. `needs_review` and
-- `activation_crashed` were added LATER, in code, with three UI surfaces each — a Needs
-- Review tab, a Crashed tab, a sidebar badge, a Retry button — and no accompanying
-- migration.
--
-- So every attempt to park a transaction for review has been REJECTED by the database.
-- For months. And the code discarded the rejection (supabase-js returns errors, it does
-- not throw), so nothing ever surfaced. Production has ZERO rows in `needs_review` or
-- `activation_crashed` — not because nothing needed reviewing, but because the queue
-- could not be written to. Staff have been looking at an empty review tab and reasonably
-- concluding there was nothing to review.
--
-- The constraint was not a guard anyone designed. It is an unshipped migration.
--
-- WHAT THIS DOES:
--   1. Adds `needs_review` and `activation_crashed` to the status CHECK.
--   2. Leaves `match_confidence` ALONE — deliberately. See the note below.
--   3. Applies the same three CHECKs to SANDBOX, which today has NONE. That divergence is
--      the root cause: the test harness was validating against a database strictly more
--      permissive than production, so a 32/32 green run proved nothing about prod.
--
-- ⚠️ `match_confidence` IS NOT WIDENED, ON PURPOSE.
-- The new code wanted `certain_retroactive` and `manual_audit_link`. It no longer does.
-- `retroactive` is load-bearing: the retroactive pass builds its "this invoice is already
-- claimed by a transaction" set by querying that value, and that set is what stops two
-- different payments being attributed to one invoice. A NEW confidence value would be
-- invisible to that guard. So the audit-link *kind* (payment-intent / fuzzy / manual) is
-- recorded in `review_metadata.link_kind` instead, and the confidence column keeps its
-- existing vocabulary.
--
-- ⚠️ `diagnostic` IS NOT ADDED, ON PURPOSE.
-- Two CRM diagnose routes wrote it, inside an unbounded fuzzy-name bulk update that
-- stamped one payment id onto EVERY matched feed whose sender name contained the company
-- string. It has never landed a single row — because this CHECK rejected it. The
-- constraint has been accidentally shielding us from a mass mis-attribution of payments.
-- The write is now deleted. Adding the value would have switched the landmine ON.
--
-- The permitted lists live in `lib/finance/feed-vocabulary.ts`. Keep them identical;
-- `scripts/check-db-constraints.ts` asserts that they are.

-- ── status: add the two values the code has always written ───────────────────────
ALTER TABLE td_bank_feeds DROP CONSTRAINT IF EXISTS td_bank_feeds_status_check;

ALTER TABLE td_bank_feeds ADD CONSTRAINT td_bank_feeds_status_check
  CHECK (status = ANY (ARRAY[
    'unmatched'::text,
    'matched'::text,
    'ignored'::text,
    'duplicate'::text,
    'outgoing'::text,
    'needs_review'::text,
    'activation_crashed'::text
  ]));

-- ── match_confidence: unchanged vocabulary, but ENSURE the constraint exists ──────
-- (Sandbox has no such constraint at all — this is what let the illegal values through
--  in testing while production rejected them.)
ALTER TABLE td_bank_feeds DROP CONSTRAINT IF EXISTS td_bank_feeds_match_confidence_check;

ALTER TABLE td_bank_feeds ADD CONSTRAINT td_bank_feeds_match_confidence_check
  CHECK (match_confidence = ANY (ARRAY[
    'exact'::text,
    'high'::text,
    'medium'::text,
    'low'::text,
    'manual'::text,
    'partial'::text,
    'retroactive'::text
  ]));

-- ── source: same vocabulary, ensure it exists in both environments ────────────────
ALTER TABLE td_bank_feeds DROP CONSTRAINT IF EXISTS td_bank_feeds_source_check;

ALTER TABLE td_bank_feeds ADD CONSTRAINT td_bank_feeds_source_check
  CHECK (source = ANY (ARRAY[
    'relay'::text,
    'mercury'::text,
    'mercury_api'::text,
    'banking_circle'::text,
    'qb_deposit'::text,
    'airwallex_email'::text,
    'airwallex_api'::text,
    'manual'::text,
    'stripe'::text,
    'chase'::text
  ]));

COMMENT ON CONSTRAINT td_bank_feeds_status_check ON td_bank_feeds IS
  'Permitted feed statuses. MUST stay identical to FEED_STATUSES in lib/finance/feed-vocabulary.ts — a value in the code but not here is silently rejected at write time, which is exactly how the review queue stayed empty for months.';
