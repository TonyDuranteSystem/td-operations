-- ============================================================================
-- client_expenses.is_test — dev job ea5751ef (post-ship QA fixes for the
-- recurring-invoicing feature, child of 4a854806).
--
-- `payments.is_test` already exists and is already read by two live production
-- surfaces (the bank-feed matcher and the owner P&L income calc), but nothing
-- has ever set it, and the client-portal expense mirror (client_expenses) has
-- no equivalent column at all — confirmed absent via information_schema by
-- three independent reviewers during this job's council pass. createTDInvoice
-- will start stamping is_test on both the payments row AND this mirror row
-- once this column exists.
-- ============================================================================

ALTER TABLE public.client_expenses
  ADD COLUMN IF NOT EXISTS is_test boolean;

COMMENT ON COLUMN public.client_expenses.is_test IS
  'Mirrors the is_test flag of the account/contact this expense was billed to. Stamped by createTDInvoice() at creation time (lib/portal/td-invoice.ts). Dev job ea5751ef.';
