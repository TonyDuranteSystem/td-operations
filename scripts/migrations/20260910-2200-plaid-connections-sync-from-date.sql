-- Antonio, 2026-09-10: "it's important the system recognize existing transactions and not
-- make a mess." Council review found the tempting fix (guess a duplicate by matching content
-- between a synced transaction and a hand-entered one) does not actually work for the accounts
-- that matter -- automatic sync labels a transaction by bare institution ("Chase"), hand-entry
-- labels it per account ("Chase checking 3920"), and the two never line up; worse, a wrong
-- guess can quietly erase a real transaction with no trace, since a bank-feed row is the only
-- record of that money before it lands in the books.
--
-- sync_from_date replaces "guess" with "never look there in the first place": when a bank with
-- prior hand-entered history is connected, transactions dated on or before this date are simply
-- never pulled in. No matching, no risk of erasing a real transaction, no risk of a duplicate --
-- the two sources just don't overlap in time. NULL means "no prior history for this account,
-- sync everything" (the correct default for a genuinely new connection).
ALTER TABLE public.plaid_connections
  ADD COLUMN IF NOT EXISTS sync_from_date date;
