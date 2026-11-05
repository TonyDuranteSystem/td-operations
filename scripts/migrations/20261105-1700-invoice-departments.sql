-- Invoice departments (dev job ac893719, Antonio 2026-11-05: "two tabs ... TD clients and TD Marketing ... flexible and not hardcoded").
--
-- Every invoice may belong to a DEPARTMENT. The list of departments is a catalog (`invoice_departments`), so a third department is a new row, never new code.
--   td_clients   = the default department: an invoice with NO department stored belongs to it, permanently (the ~700 existing invoices and every code path
--                  that inserts into `payments` directly never name the new column).
--   td_marketing = owns the origin `marketing_sale` (metadata.origins): the invoice + credit note Finance makes for a paid TD Marketing link.
-- Only a NON-default department is written to the invoice, so if code that writes the column ever ran before this migration, only marketing invoice creation
-- would fail (an ordinary invoice never names the column).
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not tag any existing invoice. The six existing marketing records (3 invoices + 3 credit notes) are tagged by a
-- separate, previewed, re-runnable backfill (step 2). It does not touch totals, portal, or any other table.
--
--   1. register the catalog + seed the two departments (ON CONFLICT DO NOTHING: a re-run never overwrites a rename, a retire or a changed default);
--   2. payments.department_entry_id uuid NULL -> catalog_entries(id) ON DELETE RESTRICT (a department row can never be deleted while an invoice points at it);
--   3. a partial index (almost every row is NULL).
-- UNDO: 20261105-1700-invoice-departments.UNDO.sql (drops the column, then the catalog rows).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"invoice-departments-migration"}', true);

INSERT INTO public.catalog_definitions (id, display_name, display_name_translations, description, admin_can_add_rows)
VALUES (
  'invoice_departments',
  'Invoice departments',
  '{"it":"Reparti delle fatture"}'::jsonb,
  'Which part of Tony Durante LLC an invoice belongs to (TD clients, TD Marketing, ...). Slug = stable id (never changed). display_name = the name shown. metadata.is_default = true on exactly ONE row: an invoice with no department stored belongs to it. metadata.origins = the invoice origins this department owns (today: marketing_sale), so the code that creates an invoice asks "which department owns this origin?" and never names a department. metadata.sort_order = the order of the switches.',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.catalog_entries (catalog_id, slug, display_name, display_name_translations, status, metadata) VALUES
  ('invoice_departments', 'td_clients',   'TD clients',   '{"it":"Clienti TD"}'::jsonb,  'active', '{"is_default":true,"origins":[],"sort_order":10}'::jsonb),
  ('invoice_departments', 'td_marketing', 'TD Marketing', '{"it":"TD Marketing"}'::jsonb, 'active', '{"origins":["marketing_sale"],"sort_order":20}'::jsonb)
ON CONFLICT (catalog_id, slug) DO NOTHING;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS department_entry_id uuid REFERENCES public.catalog_entries(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_payments_department_entry_id
  ON public.payments (department_entry_id) WHERE department_entry_id IS NOT NULL;

COMMENT ON COLUMN public.payments.department_entry_id IS
  'The department this invoice belongs to: a row of the catalog invoice_departments. NULL = the default department (TD clients), permanently. Only a non-default department is stored. Set at creation by createTDInvoice (department_entry_id param); the six pre-existing TD Marketing records are tagged by the step-2 backfill.';

COMMIT;
