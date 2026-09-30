-- Sandbox drift fix (S1 QA, 2026-09-27): production has UNIQUE (token) on
-- itin_submissions and company_info_submissions (constraints
-- itin_submissions_token_key / company_info_submissions_token_key); sandbox
-- did not, so the portal wizard's upsert (onConflict: 'token') failed there
-- with "no unique or exclusion constraint matching the ON CONFLICT" and the
-- ITIN and company-info forms could not be tested on sandbox.
-- No-op in production (the constraints already exist). Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'itin_submissions_token_key') THEN
    ALTER TABLE public.itin_submissions ADD CONSTRAINT itin_submissions_token_key UNIQUE (token);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_info_submissions_token_key') THEN
    ALTER TABLE public.company_info_submissions ADD CONSTRAINT company_info_submissions_token_key UNIQUE (token);
  END IF;
END $$;

SELECT conname FROM pg_constraint WHERE conname IN ('itin_submissions_token_key', 'company_info_submissions_token_key');
