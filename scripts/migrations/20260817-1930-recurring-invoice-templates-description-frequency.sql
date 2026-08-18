-- migration:20260817-1930-recurring-invoice-templates-description-frequency.sql
--
-- Amends recurring_invoice_templates (dev job 4a854806) for the New Invoice
-- screen's Recurring toggle: adds `description` (applied on every generated
-- cycle, mirroring the one-time flow's own Service field) and widens
-- `frequency` to weekly/biweekly, alongside the existing monthly/quarterly/
-- yearly. Also adds `payment_method` — the dialog collects it for recurring
-- invoices same as one-time ones, and it was being silently discarded on
-- every generated cycle (bug-hunter finding, third pass). ALTER, not
-- drop+recreate — sandbox already holds a real schedule (Antonio's live
-- demo) that must survive this change.

ALTER TABLE public.recurring_invoice_templates
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.recurring_invoice_templates
  ADD COLUMN IF NOT EXISTS payment_method text;

ALTER TABLE public.recurring_invoice_templates
  DROP CONSTRAINT IF EXISTS recurring_invoice_templates_frequency_check;

ALTER TABLE public.recurring_invoice_templates
  ADD CONSTRAINT recurring_invoice_templates_frequency_check
  CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'));
