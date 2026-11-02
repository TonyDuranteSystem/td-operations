-- The wording staff chose for an offer's invoice (optional). NULL = the automatic text ("<services> - <client name>").
-- Additive, no constraint on purpose (a CHECK list on a shared database turns other sessions' CI red); the length and
-- cleaning rule lives in lib/offers/invoice-description.ts. Re-runnable.

ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS invoice_description text;

COMMENT ON COLUMN public.offers.invoice_description IS
  'Optional wording for the invoice of this offer. NULL = automatic "<services> - <client name>". Private (never on the public offer page).';
