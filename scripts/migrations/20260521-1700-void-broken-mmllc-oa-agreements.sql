-- Void broken MMLLC oa_agreements records that have total_signers=1
-- and no oa_signatures rows. These were created before the MMLLC multi-signer
-- system shipped (April 26-27, 2026) and cannot be signed.
-- Exception: records with status='signed' and any with total_signers > 1.
--
-- NOTE: production has a status CHECK constraint that must be updated first
-- to include 'voided'. Sandbox has no constraint so this ran there without it.

-- Step 1: extend the status check constraint to include 'voided'
ALTER TABLE oa_agreements DROP CONSTRAINT IF EXISTS oa_agreements_status_check;
ALTER TABLE oa_agreements ADD CONSTRAINT oa_agreements_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'sent'::text, 'viewed'::text, 'partially_signed'::text, 'signed'::text, 'voided'::text]));

-- Step 2: void the broken records
UPDATE oa_agreements
SET status = 'voided'
WHERE entity_type = 'MMLLC'
  AND total_signers = 1
  AND status NOT IN ('signed', 'voided')
  AND NOT EXISTS (
    SELECT 1 FROM oa_signatures os WHERE os.oa_id = oa_agreements.id
  );
