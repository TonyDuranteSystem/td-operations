-- Dev job bc2a8f7f — distinguish which onboarding path a submission came
-- from (the real in-portal client wizard vs. the separate manual
-- token-link tool) so the staff review-inbox Confirm action can route to
-- the correct account-creation logic for each.
--
-- 'portal_wizard' = the real client journey (logged-in portal wizard,
--   app/api/portal/wizard-submit/route.ts). NULL = the manual token-link
--   tool (app/api/onboarding-form-completed/route.ts). Mirrors the
--   job_queue payload's own `source` field for the same distinction.

ALTER TABLE onboarding_submissions ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN onboarding_submissions.source IS
  'portal_wizard = real client portal wizard submission; NULL = manual token-link tool submission. Drives which account-creation path the review-inbox Confirm action uses.';
