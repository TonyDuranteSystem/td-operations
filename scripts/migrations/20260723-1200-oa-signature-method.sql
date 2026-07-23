-- Operating Agreement: record HOW an agreement was signed.
--
-- WHY.
-- A client can now close out an Operating Agreement in one of two ways:
--   1. sign it electronically in the portal (what has always existed), or
--   2. print the unsigned draft, sign it on paper, and declare that here.
--
-- Both end with status = 'signed', because everything downstream — the portal
-- "documents to sign" list, the pending-signature queries, the formation flow —
-- keys on that value, and a hand-signed agreement IS signed. But the two are not
-- the same thing evidentially: for a hand-signed one, TD holds either a scan the
-- client uploaded or nothing but the unsigned draft.
--
-- Without this column nobody can tell them apart six months later. Staff need to
-- be able to answer "which agreements do we actually hold a signature for?"
-- without opening every file.
--
-- Values: 'electronic' | 'by_hand'. NULL for every row signed before this
-- column existed — deliberately NOT backfilled to 'electronic', because that
-- would be an assumption about 74 legal documents. NULL means "unknown, predates
-- the distinction", and that is the truth.

ALTER TABLE oa_agreements
  ADD COLUMN IF NOT EXISTS signature_method text;

ALTER TABLE oa_agreements
  DROP CONSTRAINT IF EXISTS oa_agreements_signature_method_check;

ALTER TABLE oa_agreements
  ADD CONSTRAINT oa_agreements_signature_method_check
  CHECK (signature_method IS NULL OR signature_method IN ('electronic', 'by_hand'));

COMMENT ON COLUMN oa_agreements.signature_method IS
  'How the agreement was executed: electronic (signed in the portal) or by_hand (client printed, signed on paper, and declared it). NULL = signed before this distinction was recorded. See scripts/migrations/20260723-1200-oa-signature-method.sql';
