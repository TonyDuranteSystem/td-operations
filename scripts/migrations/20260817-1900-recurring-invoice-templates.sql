-- migration:20260817-1900-recurring-invoice-templates.sql
-- ============================================================================
-- RECURRING INVOICE TEMPLATES — billing schedules for TD's own client
-- invoicing (the `payments` table), general-purpose (not the Jan/June
-- installment-only cron). Dev job 4a854806. Design approved by Antonio
-- 2026-08-17, including the AI Architect's ordering-invariant amendment.
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `payments`. The existing recurring
-- pattern (client_invoices.recurring_frequency/_next_date/_end_date, cloned by
-- app/api/cron/portal-recurring-invoices) works only because that table's
-- template row sits there as a genuinely live invoice (status Sent/Paid) that
-- createUnifiedInvoice never mirrors into `payments`/QB/credit-netting. That
-- same shape is UNSAFE on `payments`: the daily dunning cron
-- (lib/billing/dunning.ts) auto-escalates any payments row with
-- invoice_status IN ('Sent','Partial') past its due_date to Overdue and
-- queues a client-facing chase email, and the bank-feed matcher's matchable
-- set is every payments row not in a terminal status — both would treat an
-- inert template as a real bill. So a template here is NEVER a payments row:
-- this table holds only schedule metadata, and the daily cron
-- (app/api/cron/recurring-invoices) calls createTDInvoice() fresh each cycle,
-- the same single legal insert path every other TD invoice uses — inheriting
-- its idempotency-key dedup, credit-netting, and invoice-number handling for
-- free. Generated invoices land as invoice_status='Draft', same as the
-- existing annual-installments cron — nothing here ever auto-emails a client.
--
-- ORDERING INVARIANT (the one blocker the architect review raised):
-- next_run_date must be advanced ONLY after createTDInvoice() succeeds for
-- that cycle, never before and never unconditionally — otherwise a failed
-- attempt (transient DB error, retry exhaustion) silently and permanently
-- skips the charge with no trace it was ever due. The cron enforces this by
-- construction: create first, advance second, on failure record last_error
-- and leave next_run_date untouched so the row stays due and retries the
-- next day. Same shape as portal-recurring-invoices' own try/catch.
--
-- AMENDED (same day, before production promotion): added `description`
-- (applied on every cycle, not just the first) and widened `frequency` to
-- weekly/biweekly for the New Invoice screen's Recurring toggle. Cycle 1 and
-- every later cycle go through the SAME generator function
-- (lib/billing/recurring-invoice-generate.ts) — deliberately never two
-- separate code paths that could drift (Council review, dev job 4a854806).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.recurring_invoice_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one of the two, mirroring createTDInvoice's own runtime check
  -- (lib/portal/td-invoice.ts) that at least one of account_id/contact_id
  -- is required. Either alone is allowed here (a contact-only client is a
  -- real case, e.g. pre-formation), so this is an OR, not an exclusive-or.
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT recurring_invoice_templates_subject_check CHECK (
    account_id IS NOT NULL OR contact_id IS NOT NULL
  ),

  -- Human-readable label so staff can tell templates apart in the CRM and in
  -- the "What's New" notification. Internal only — never shown to the client.
  label text NOT NULL,

  -- Staff-typed description that OVERRIDES createTDInvoice's own
  -- line-item-derived default on every generated cycle (not just the first) —
  -- mirrors the one-time New Invoice screen's own Service field. NULL falls
  -- back to createTDInvoice's default (the first line item's description).
  description text,

  -- Same shape as TDInvoiceInput.line_items (lib/portal/td-invoice.ts):
  -- [{description, unit_price, quantity?, tax_rate?}, ...]. Copied verbatim
  -- into createTDInvoice at generation time.
  line_items jsonb NOT NULL,

  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR')),

  -- weekly/biweekly are plain day-count cycles (7/14 days); monthly/quarterly/
  -- yearly add calendar months with day-of-month clamping. See
  -- advanceRecurringDate (lib/billing/recurring-invoice-schedule.ts) — it
  -- branches explicitly on this set, never falls through to a default.
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),

  -- Next date this schedule is due to fire. The cron selects active rows
  -- where next_run_date <= today. See the ordering invariant above for when
  -- this is allowed to advance.
  next_run_date date NOT NULL,

  -- Optional last date to generate on/before. NULL = runs indefinitely.
  end_date date,

  -- Days after next_run_date the generated invoice's due_date is set to.
  -- 0 = due the same day it's generated. NEVER negative: a negative offset
  -- would issue an invoice already past its own due date — harmless while
  -- Draft, but the moment it's sent the daily dunning pass (invoice_status
  -- Sent/Partial + due_date < today) would flag it Overdue immediately, and
  -- if automatic reminders are ever turned on it could fire BOTH chase
  -- thresholds back-to-back on the very first pass (bug-hunter finding, dev
  -- job 4a854806, second pass).
  due_date_offset_days integer NOT NULL DEFAULT 0 CHECK (due_date_offset_days >= 0),

  -- Staff off-switch. An inactive template is invisible to the cron but the
  -- row (and its history) is kept — flip back on rather than recreate.
  active boolean NOT NULL DEFAULT true,

  -- Optional passthroughs to createTDInvoice — see TDInvoiceInput for exact
  -- meaning of each. All nullable; the cron omits whichever are unset.
  installment text,
  payment_category text,
  notes text,
  message text,
  bank_preference text,

  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Audit trail of the most recent cycle only — NOT a live join partner. The
  -- generated row is an ordinary payments row with no back-reference to this
  -- table (payments has no recurring_* columns, deliberately). This pointer
  -- exists solely so staff can see what a template last created.
  last_generated_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  last_generated_at timestamptz,
  last_run_status text CHECK (last_run_status IS NULL OR last_run_status IN ('ok', 'error')),
  last_error text
);

-- The cron's own query: active templates due today or earlier.
CREATE INDEX IF NOT EXISTS idx_recurring_invoice_templates_due
  ON public.recurring_invoice_templates (next_run_date)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_recurring_invoice_templates_account_id
  ON public.recurring_invoice_templates (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recurring_invoice_templates_contact_id
  ON public.recurring_invoice_templates (contact_id) WHERE contact_id IS NOT NULL;

-- Server-only, like every other purely-internal staff/cron table here
-- (payer_client_map, annual_agreements): no anon/authenticated grants are
-- added, so it is reachable exclusively through service-role code. No client
-- surface ever reads this table.
ALTER TABLE public.recurring_invoice_templates ENABLE ROW LEVEL SECURITY;

-- ⛔ NO updated_at TRIGGER, DELIBERATELY — same reasoning as payer_client_map
-- (2026-08-09): public.update_updated_at() exists in PRODUCTION but NOT in
-- sandbox, so depending on it makes this table's DDL environment-specific.
-- The only writer is the recurring-invoices cron, which sets updated_at
-- explicitly.

COMMENT ON TABLE public.recurring_invoice_templates IS
  'Billing schedules for TD''s own recurring client invoicing. A daily cron (app/api/cron/recurring-invoices) reads due, active rows and calls createTDInvoice() fresh each cycle — Draft-only, same idempotency/credit-netting as every other TD invoice. This table itself is NEVER a live payments row, so the dunning cron and the bank-feed matcher never mistake an inert template for a real bill. next_run_date advances only after a successful generation. Dev job 4a854806.';
