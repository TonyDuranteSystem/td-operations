-- Workspace-only plan S1 (dev job 9d34e750, Antonio approved 2026-09-27):
-- "Invoice to" chosen on the OFFER. The offer lives where it was created
-- (lead / contact / company page); by default the invoice goes to that same
-- place, but staff can pick another payer — e.g. a lead who pays with his own
-- company that is not in the CRM. Shape (validated in code):
--   {"type":"person"}
--   {"type":"company","account_id":"<uuid>"}
--   {"type":"entity","billing_entity_id":"<uuid>"}            -- an existing billing entity of the contact
--   {"type":"entity","entity":{"name":"…","address":"…","country":"…","vat_number":"…","fiscal_code":"…"}}  -- typed; saved as a billing entity at signing
-- NULL = legacy offer → company when the offer carries one, else the person.
-- Idempotent.

ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS bill_to jsonb;

COMMENT ON COLUMN public.offers.bill_to IS
  'Who the invoice is addressed to (S1, 2026-09-27): {type: person|company|entity, account_id?, billing_entity_id?, entity?}. NULL = company of the offer if any, else the person.';

SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'offers' AND column_name = 'bill_to';
