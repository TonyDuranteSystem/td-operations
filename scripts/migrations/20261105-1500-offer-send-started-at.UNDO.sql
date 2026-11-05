-- UNDO for 20261105-1500-offer-send-started-at.sql. Safe: nothing else reads the column once the code that uses it is reverted.
-- Revert the code (lib/offers/send-claim.ts, publish.ts, mark-sent.ts) BEFORE running this, or Send will fail on the missing column.
ALTER TABLE public.offers DROP COLUMN IF EXISTS send_started_at;
