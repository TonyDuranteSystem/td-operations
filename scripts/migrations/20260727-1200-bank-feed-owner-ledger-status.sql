-- Bank-feed status: add 'owner_ledger'.
--
-- WHAT IT MEANS: this bank transaction is NOT a client invoice payment — it is TD's own
-- money (a Stripe payout, a bank reward, money TD spent). It has been copied into
-- My Finances, where Antonio does the company's accounting. Finance keeps ONLY client
-- invoice payments, so staff working invoices never see the owner's business activity.
--
-- ⚠️ ORDER MATTERS (the 2026-07-14 incident): this CHECK must exist in a database BEFORE
-- any code writes the value there. supabase-js RETURNS errors rather than throwing, so a
-- value missing from the CHECK is silently rejected — that is how `needs_review` was
-- rejected for months while the UI showed an empty review queue. Apply this to sandbox
-- first, then to production (Supabase SQL editor), and only then let the code write it.
--
-- The list below must stay identical to FEED_STATUSES in lib/finance/feed-vocabulary.ts.

ALTER TABLE td_bank_feeds DROP CONSTRAINT IF EXISTS td_bank_feeds_status_check;

ALTER TABLE td_bank_feeds ADD CONSTRAINT td_bank_feeds_status_check
  CHECK (status = ANY (ARRAY[
    'unmatched'::text,
    'matched'::text,
    'ignored'::text,
    'duplicate'::text,
    'outgoing'::text,
    'needs_review'::text,
    'activation_crashed'::text,
    'owner_ledger'::text
  ]));
