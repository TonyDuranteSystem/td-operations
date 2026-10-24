-- Undo of 20261023-1500-incoming-payment-resolutions-phase3.sql: back to the three Phase 1 values.
-- Refuses (the ADD CONSTRAINT fails and everything rolls back) while any row already uses marketing_sale or invoice_paid.
BEGIN;
ALTER TABLE public.incoming_payment_resolutions DROP CONSTRAINT IF EXISTS incoming_payment_resolutions_resolution_check;
ALTER TABLE public.incoming_payment_resolutions ADD CONSTRAINT incoming_payment_resolutions_resolution_check
  CHECK (resolution IN ('paid_call', 'paid_call_already_deducted', 'recorded_elsewhere'));
COMMIT;
