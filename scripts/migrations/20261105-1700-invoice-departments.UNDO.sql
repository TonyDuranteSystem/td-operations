-- UNDO of 20261105-1700-invoice-departments.sql.
-- Run ONLY after the code that writes payments.department_entry_id has been rolled back (or it will fail to insert marketing invoices).
-- Order matters: the column goes first (it holds the ON DELETE RESTRICT link), then the catalog rows.
-- Dropping the column forgets which invoices were tagged TD Marketing; the step-2 backfill can recreate that (it matches on the Stripe session key).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"invoice-departments-undo"}', true);

DROP INDEX IF EXISTS public.idx_payments_department_entry_id;
ALTER TABLE public.payments DROP COLUMN IF EXISTS department_entry_id;

DELETE FROM public.catalog_entries WHERE catalog_id = 'invoice_departments';
DELETE FROM public.catalog_definitions WHERE id = 'invoice_departments';

COMMIT;
