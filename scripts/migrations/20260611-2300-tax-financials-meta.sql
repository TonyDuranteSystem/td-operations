-- Slice 9 (master plan §3.4): home for the financials flow's system-managed
-- state on the submission — coverage answers ("did this account have activity
-- before March?"), and future flags. JSONB so new keys never need DDL (§8
-- flexible architecture). Separate from submitted_data (the client's form
-- answers) on purpose.
ALTER TABLE public.tax_return_submissions
  ADD COLUMN IF NOT EXISTS financials_meta JSONB NOT NULL DEFAULT '{}'::jsonb;
