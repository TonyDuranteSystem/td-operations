-- Bank application intake (dev job 11d484a4), follow-up: who the link is for and where the finished
-- form goes.
--   partner_name   the partner the link was made for (e.g. "Max Scale"); `label` keeps the same text.
--                  The CLIENT the partner shares it with is NOT typed here: it is read from the
--                  submitted answers (form_data.full_name / company_name) once the form is submitted.
--   recipients     email addresses the submitted form is emailed to (answers + documents), chosen by
--                  staff when the link is made. Empty = nothing is emailed.
--   email_status   null (never tried) | sending | sent | failed — set around the send so a retry or a
--                  double submit can never email twice; "failed" + email_error power the Resend button.
--
-- Additive and idempotent. Production: apply via the Supabase dashboard (R105) only on Antonio's
-- explicit word; sandbox / local: node scripts/apply-migration.js <file>.

ALTER TABLE public.bofa_intake_requests
  ADD COLUMN IF NOT EXISTS partner_name   text,
  ADD COLUMN IF NOT EXISTS recipients     text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS email_status   text,
  ADD COLUMN IF NOT EXISTS email_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS email_error    text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bofa_intake_requests_email_status_check'
  ) THEN
    ALTER TABLE public.bofa_intake_requests
      ADD CONSTRAINT bofa_intake_requests_email_status_check
      CHECK (email_status IS NULL OR email_status IN ('sending', 'sent', 'failed'));
  END IF;
END $$;

-- Links made before this change carried only a label.
UPDATE public.bofa_intake_requests SET partner_name = label WHERE partner_name IS NULL;
