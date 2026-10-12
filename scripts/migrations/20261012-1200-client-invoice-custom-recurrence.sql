-- Client invoices: "Custom" repeat schedule (dev job 1a23f5f1, Antonio 2026-10-12).
-- A client picks "Custom" and says how many months between invoices (1 to 36). The existing choices
-- (monthly / quarterly / yearly) are unchanged. Safe on existing rows: every current row has no interval.
-- Apply to the SANDBOX first (node scripts/apply-migration.js <file>); production only on Antonio's word,
-- BEFORE the code that writes 'custom' is shipped there.

ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS recurring_interval_months integer;

ALTER TABLE client_invoices DROP CONSTRAINT IF EXISTS client_invoices_recurring_frequency_check;
ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_recurring_frequency_check
  CHECK (recurring_frequency IS NULL OR recurring_frequency = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text]));

-- Shape rule: a custom schedule must carry 1..36 months; any other schedule must carry none.
ALTER TABLE client_invoices DROP CONSTRAINT IF EXISTS client_invoices_recurring_interval_check;
ALTER TABLE client_invoices ADD CONSTRAINT client_invoices_recurring_interval_check
  CHECK (
    (recurring_frequency = 'custom' AND recurring_interval_months BETWEEN 1 AND 36)
    OR (recurring_frequency IS DISTINCT FROM 'custom' AND recurring_interval_months IS NULL)
  );
