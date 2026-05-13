-- PR B — Bank Feed review queue infrastructure.
--
-- Adds review_metadata jsonb to td_bank_feeds for storing context about feeds
-- that are in a review state — candidate score, activation error message,
-- rejection timestamp, etc.
--
-- Two new status values are now valid on td_bank_feeds (no DB check constraint
-- exists, so application code is the only gate):
--   * 'needs_review'       — matcher found a candidate but confidence is below
--                            the auto-activate threshold; staff must confirm.
--   * 'activation_crashed' — matcher auto-matched the invoice, but the
--                            downstream runActivation() call failed; staff can
--                            retry from the Reconciliation review queue.
--
-- An index supports the sidebar badge query (counts rows in either state).

ALTER TABLE td_bank_feeds
  ADD COLUMN IF NOT EXISTS review_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_td_bank_feeds_review_status
  ON td_bank_feeds (status)
  WHERE status IN ('needs_review', 'activation_crashed');

-- One-off backfill (NOT run as part of this migration — apply manually after
-- review). Pre-existing medium-confidence rows were stored as status='unmatched'
-- with matched_payment_id+match_confidence already populated. To migrate them
-- into the new review queue:
--
-- UPDATE td_bank_feeds
--   SET status = 'needs_review',
--       updated_at = now()
-- WHERE status = 'unmatched'
--   AND matched_payment_id IS NOT NULL
--   AND match_confidence IN ('medium', 'high');
