-- Lease agreement template version + the Operating Address the client confirms at signing.
--
-- template_version 1 = the original "Office Lease Agreement" text (every lease that exists today keeps rendering exactly
--   that — a signed lease must never be re-rendered with newer wording).
-- template_version 2 = the "Office Lease and Services Agreement" (Antonio 2026-10-10): CMRA/mail handling, no rent or deposit,
--   12-month fixed term, official + mailing (PMB) address.
-- operating_address = where the client's day-to-day business is run, typed by the client at signing (v2 only).
--
-- Run BEFORE the code that selects these columns ships: a missing column would make every lease page return "not found".
ALTER TABLE public.lease_agreements
  ADD COLUMN IF NOT EXISTS template_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS operating_address text;

COMMENT ON COLUMN public.lease_agreements.template_version IS '1 = original Office Lease Agreement; 2 = Office Lease and Services Agreement (2026-10-10). Existing rows stay 1.';
COMMENT ON COLUMN public.lease_agreements.operating_address IS 'Client''s operating address confirmed at signing (template_version 2).';
