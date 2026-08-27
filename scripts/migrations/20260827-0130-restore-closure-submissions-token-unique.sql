-- Restores a unique index that already exists in production but was missing
-- in sandbox (pure environment drift, unrelated to any feature work). The
-- wizard-submit route upserts closure_submissions with onConflict: 'token',
-- which requires this constraint to exist or every closure submission 500s
-- with "no unique or exclusion constraint matching the ON CONFLICT
-- specification". Discovered 2026-08-27 while live-verifying the closure
-- wizard scoping fix (dev job fbbf4abe) in sandbox.
CREATE UNIQUE INDEX IF NOT EXISTS closure_submissions_token_key ON public.closure_submissions USING btree (token);
