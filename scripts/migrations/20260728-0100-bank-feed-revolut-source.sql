-- Bank-feed source: add 'revolut'.
--
-- Revolut Business was connected via Plaid on 2026-07-27. The sync labels each
-- transaction with its bank; a bank missing from this list falls back to "manual",
-- which would permanently mislabel every Revolut row (the sync never relabels an
-- existing row). This must be in the database BEFORE the code that writes it deploys.
--
-- The list below must stay identical to FEED_SOURCES in lib/finance/feed-vocabulary.ts.

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
    'chase'::text,
    'revolut'::text
  ]));
