-- Undo of 20261023-1200-incoming-payment-resolutions.sql: removes the list of settled incoming payments.
-- After this, every unlabelled payment since 2026-10-01 shows as waiting again (the payments themselves are untouched).
BEGIN;
DROP TABLE IF EXISTS public.incoming_payment_resolutions;
COMMIT;
