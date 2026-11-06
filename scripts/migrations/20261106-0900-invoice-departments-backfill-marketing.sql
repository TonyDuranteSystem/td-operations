-- Invoice departments, step 2 (dev job ac893719): file the EXISTING TD Marketing invoices and credit notes under the TD Marketing department.
--
-- Which rows: a payments row whose idempotency_key is 'paid-call-manual:stripe-session:<id>:invoice' or ':credit' where <id> is the stripe_session_id of a
-- row in marketing_sales - i.e. exactly the invoice + credit note Finance made for a paid TD Marketing link. Nothing else is touched (INV-002702 is TD's own
-- invoice and has no such key, so it stays under TD clients).
-- Re-runnable: it only touches rows with NO department yet, so a second run changes 0 rows. Safe on a database that has no marketing sales (0 rows).
--
-- STEP 1 (preview, changes nothing): run the SELECT block below on its own and check the rows.
-- STEP 2 (apply): run the BEGIN..COMMIT block.
-- UNDO: UPDATE public.payments SET department_entry_id = NULL WHERE department_entry_id = (SELECT id FROM public.catalog_entries WHERE catalog_id='invoice_departments' AND slug='td_marketing');

-- ===== PREVIEW =====
SELECT p.invoice_number, p.invoice_status, p.total, p.department_entry_id, ms.id AS marketing_sale_id
FROM public.payments p
JOIN public.marketing_sales ms
  ON p.idempotency_key IN (
       'paid-call-manual:stripe-session:' || ms.stripe_session_id || ':invoice',
       'paid-call-manual:stripe-session:' || ms.stripe_session_id || ':credit')
WHERE p.department_entry_id IS NULL
ORDER BY p.invoice_number;

-- ===== APPLY =====
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"invoice-departments-backfill"}', true);

UPDATE public.payments p
SET department_entry_id = (SELECT id FROM public.catalog_entries WHERE catalog_id = 'invoice_departments' AND slug = 'td_marketing')
FROM public.marketing_sales ms
WHERE p.department_entry_id IS NULL
  AND p.idempotency_key IN (
        'paid-call-manual:stripe-session:' || ms.stripe_session_id || ':invoice',
        'paid-call-manual:stripe-session:' || ms.stripe_session_id || ':credit')
  AND EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'invoice_departments' AND slug = 'td_marketing');

COMMIT;
