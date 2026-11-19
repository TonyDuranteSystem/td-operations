-- Dev job 0a60f416 — a signed short contract records WHICH agreements it contains.
--
-- Why: one offer for Company Closure + Tax Return was signed with only the Tax Return agreement printed, and the CRM could only name the contract
-- from the offer's single main type ("tax return"). With this column the server writes, at the moment of signing, the list of agreements the page
-- printed, e.g. [{"type":"closure","name":"Company Closure"},{"type":"tax_return","name":"Tax Return 2026"}]. Everything that names a signed
-- contract reads it first and falls back to the old name when it is NULL, so every contract signed before this keeps the name it always had.
--
-- Safe: one nullable column, no default, no backfill, no rewrite of existing rows. The application tolerates the column being absent (it signs
-- without the record and reads without the column), so the order of deploy and migration cannot block a client from signing.

ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS agreements jsonb;

COMMENT ON COLUMN public.contracts.agreements IS
  'The agreements this contract contained when it was signed: a list of {type, name}. NULL = signed before this was recorded (named from the offer''s main type, as before).';
