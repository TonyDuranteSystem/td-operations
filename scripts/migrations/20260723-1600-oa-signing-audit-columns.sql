-- OA server-side signing: per-signer audit + method columns on oa_signatures.
--
-- WHY.
-- Signing moves from the browser (which screenshotted the page and wrote the row
-- with the anon key) to the SERVER. The server now captures the evidence that
-- makes a signature legally defensible — the same fields the e-sign engine records
-- on esign_signers — so the Operating Agreement can carry a real Certificate of
-- Completion (who / when / from what device + address / consent + a document
-- fingerprint), the proof DocuSign-class tools rely on.
--
-- These are ADDITIVE and nullable. Every existing row (MMLLC signature rows) keeps
-- working; the columns fill in only for signatures collected on the new path.
--
-- Columns:
--   last_ip           — the signer's IP at signing time (server-captured, never
--                       from the client body).
--   last_user_agent   — the signer's device/browser string (server-captured).
--   consent           — did they affirmatively agree to sign electronically
--                       (ESIGN/UETA). Recorded per signer.
--   signature_method  — HOW they made the mark: 'drawn' | 'typed' | 'uploaded'.
--                       This is the per-signer method, distinct from
--                       oa_agreements.signature_method ('electronic' | 'by_hand'),
--                       which records whether the whole agreement was signed in the
--                       system or on paper.
--   signature_hash    — SHA-256 of the signature image bytes, printed on the
--                       certificate as tamper-evidence for that mark.

ALTER TABLE oa_signatures
  ADD COLUMN IF NOT EXISTS last_ip text,
  ADD COLUMN IF NOT EXISTS last_user_agent text,
  ADD COLUMN IF NOT EXISTS consent boolean,
  ADD COLUMN IF NOT EXISTS signature_method text,
  ADD COLUMN IF NOT EXISTS signature_hash text;

ALTER TABLE oa_signatures
  DROP CONSTRAINT IF EXISTS oa_signatures_signature_method_check;

ALTER TABLE oa_signatures
  ADD CONSTRAINT oa_signatures_signature_method_check
  CHECK (signature_method IS NULL OR signature_method IN ('drawn', 'typed', 'uploaded'));

COMMENT ON COLUMN oa_signatures.signature_method IS
  'How the signer made their mark: drawn | typed | uploaded. Per-signer; distinct from oa_agreements.signature_method (electronic | by_hand). See scripts/migrations/20260723-1600-oa-signing-audit-columns.sql';

-- One signature row per member per agreement. The server signing path creates the
-- SMLLC row on the fly (index 0) and updates MMLLC rows in place; this constraint is
-- what makes a concurrent double-submit lose cleanly instead of inserting a second
-- signed row and double-counting. Verified 0 existing violations on production before
-- adding (2026-07-23).
ALTER TABLE oa_signatures
  DROP CONSTRAINT IF EXISTS oa_signatures_oa_member_unique;

ALTER TABLE oa_signatures
  ADD CONSTRAINT oa_signatures_oa_member_unique UNIQUE (oa_id, member_index);
