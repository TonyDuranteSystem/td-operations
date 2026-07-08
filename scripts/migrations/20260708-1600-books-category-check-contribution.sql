-- S2 slice 1 (2026-07-08): align the bank_transactions category CHECK with the
-- code's category union. ROOT CAUSE of the Dynamiq missing-$3,059.99 incident:
-- prod's CHECK lacked 'contribution' (the member-money category added 2026-07-07
-- for workspaces was never propagated to the books table), so Save-to-client
-- silently dropped the only 2 contribution rows, the client's "Owner money in"
-- answer chip errors, and wizard ingestion of owner top-up rows loses them.
-- Sandboxes had NO CHECK at all (why every sandbox test passed) — this adds the
-- SAME constraint everywhere so future category drift fails in sandbox first.
-- The 9 values mirror the ParsedTransaction category union in
-- lib/bank-statement-parser.ts.

ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_category_check;

ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_category_check CHECK (category IN ('income','cogs','expense','distribution','contribution','fee','conversion','refund','uncategorized'));
