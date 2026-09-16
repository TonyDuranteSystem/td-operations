-- Antonio, 2026-09-10/11: matching must not depend on typing the same words a filename
-- happened to use — "the account number" is what's reliable. This carries the RESOLVED
-- per-transaction account identity (from Plaid's own account mask + type, captured at sync
-- time — the only point that mapping is available) so later steps (the duplicate check, and
-- building the final books row) can look up td_books_accounts by NUMBER, never by name text.
-- NULL for every non-Plaid source and for any Plaid transaction whose owning sub-account
-- couldn't be resolved — those fall back to today's coarse institution-only behavior, no
-- worse than before this feature existed.
ALTER TABLE public.td_bank_feeds
  ADD COLUMN IF NOT EXISTS owner_account_number text,
  ADD COLUMN IF NOT EXISTS owner_account_type text;
