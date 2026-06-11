-- Restore the unique index on tax_return_submissions.token in SANDBOX.
-- Production has tax_return_submissions_token_key; sandbox lost it (drift),
-- which broke the wizard-submit upsert (ON CONFLICT 'token') during Slice 1
-- QA on 2026-06-11. Idempotent; safe on both environments.
CREATE UNIQUE INDEX IF NOT EXISTS tax_return_submissions_token_key
  ON public.tax_return_submissions USING btree (token);
