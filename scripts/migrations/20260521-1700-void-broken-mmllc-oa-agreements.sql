-- Void 23 broken MMLLC oa_agreements records that have total_signers=1
-- and no oa_signatures rows. These were created before the MMLLC multi-signer
-- system shipped (April 26-27, 2026) and cannot be signed.
-- Exception: Oh My Creatives LLC (status='signed') and the 2 correctly-formed
-- OAs (Azarexa LLC, PTBT Holding LLC) — they have total_signers > 1.

UPDATE oa_agreements
SET status = 'voided'
WHERE entity_type = 'MMLLC'
  AND total_signers = 1
  AND status NOT IN ('signed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM oa_signatures os WHERE os.oa_id = oa_agreements.id
  );
