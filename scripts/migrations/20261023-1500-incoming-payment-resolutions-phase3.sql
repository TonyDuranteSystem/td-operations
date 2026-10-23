-- Payments to confirm, Phase 3 (Antonio 2026-10-23; dev job 40a58d9a): two more things staff can say a waiting payment was —
--   marketing_sale  recorded in TD Marketing's own sales ledger (with the split in force on the day of payment)
--   invoice_paid    it paid an existing open invoice (the same settle engine a wire or a labelled Stripe payment uses)
-- WHAT: widens the one CHECK list on incoming_payment_resolutions.resolution (created by 20261023-1200). Nothing else changes.
-- Requires 20261023-1200 first. Safe to run again. Undo: the .UNDO.sql beside this file (refuses while a row uses a new value).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.incoming_payment_resolutions') IS NULL THEN
    RAISE EXCEPTION 'Run 20261023-1200-incoming-payment-resolutions.sql FIRST: incoming_payment_resolutions is missing.';
  END IF;
END $$;

ALTER TABLE public.incoming_payment_resolutions DROP CONSTRAINT IF EXISTS incoming_payment_resolutions_resolution_check;
ALTER TABLE public.incoming_payment_resolutions ADD CONSTRAINT incoming_payment_resolutions_resolution_check
  CHECK (resolution IN ('paid_call', 'paid_call_already_deducted', 'recorded_elsewhere', 'marketing_sale', 'invoice_paid'));

COMMIT;
