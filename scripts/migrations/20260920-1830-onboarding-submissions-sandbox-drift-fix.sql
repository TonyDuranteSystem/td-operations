-- Sandbox schema-drift fix, found during live E2E QA of dev job bc2a8f7f
-- (2026-09-20): sandbox's onboarding_submissions table was missing
-- constraints that PRODUCTION already has, confirmed via pg_constraint on
-- both. Most importantly the UNIQUE constraint on `token` — without it,
-- wizard-submit's upsert(onConflict:'token') fails outright with
-- "no unique or exclusion constraint matching the ON CONFLICT specification",
-- meaning the real onboarding wizard could not be submitted AT ALL in
-- sandbox. Production is unaffected (already has all of these). This is a
-- sandbox-only sync to match production, not a new schema change.

ALTER TABLE onboarding_submissions
  ADD CONSTRAINT onboarding_submissions_token_key UNIQUE (token);

ALTER TABLE onboarding_submissions
  ADD CONSTRAINT onboarding_submissions_entity_type_check
    CHECK (entity_type = ANY (ARRAY['SMLLC'::text, 'MMLLC'::text]));

ALTER TABLE onboarding_submissions
  ADD CONSTRAINT onboarding_submissions_language_check
    CHECK (language = ANY (ARRAY['en'::text, 'it'::text]));

ALTER TABLE onboarding_submissions
  ADD CONSTRAINT onboarding_submissions_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'opened'::text, 'completed'::text, 'reviewed'::text]));
