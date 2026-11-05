-- UNDO of 20261105-1700-invoice-departments.sql.
-- Run ONLY after the code that writes payments.department_entry_id has been rolled back (or it will fail to insert marketing invoices).
-- Drops the index and the column (the column holds the ON DELETE RESTRICT link). The catalog rows (`invoice_departments`) are LEFT IN PLACE, exactly as the
-- earlier catalog UNDOs do: nothing reads them once the old code is back, and a later re-run of the migration (ON CONFLICT DO NOTHING) keeps any rename.
-- Dropping the column forgets which invoices were tagged TD Marketing; the step-2 backfill recreates that (it matches on the Stripe session key).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"invoice-departments-undo"}', true);

DROP INDEX IF EXISTS public.idx_payments_department_entry_id;
ALTER TABLE public.payments DROP COLUMN IF EXISTS department_entry_id;

COMMIT;
