-- ============================================================================
-- client_expenses auto-sync + write guard — dev job 0dcb0a18 (client-portal
-- invoice-mirror drift). Council-reviewed across 3 rounds (senior-engineer,
-- ai-architect, bug-hunter; core council also included project-director +
-- system-counselor on the earlier investigation).
--
-- PROBLEM: `payments` is the single source of truth for a TD invoice.
-- `client_expenses` (rows where source='td_invoice') is the client-portal
-- copy of it, matched by td_payment_id. Historically kept in sync by
-- scattered TypeScript call sites (syncTDInvoiceMirror, syncTDInvoiceStatus,
-- and at least one direct ad hoc edit) that repeatedly forgot to cover every
-- writer — confirmed real drift on production invoices (e.g. Domenico
-- Pio Cristiano / DOM Consulting LLC, INV-002457: mirror showed amount_due
-- 2500 against a real invoice that is fully paid at 0 due).
--
-- FIX: the database itself keeps the two in lockstep. Any UPDATE to the
-- relevant payments columns automatically recomputes the matching
-- client_expenses row inside the SAME transaction — no application code
-- has to remember to call anything, ever, for any current or future writer.
-- A second trigger then makes it impossible for anything OTHER than this
-- mechanism to write those same fields on a td_invoice row.
--
-- EXPLICITLY NOT done here (different shape, confirmed in review):
--  - client_invoices <-> payments (legacy portal_invoice_id link) — some
--    client_invoices rows have no upstream payments row at all; no clean
--    1:1 relationship to project from a single source.
--  - accounts.ra_renewal_date/annual_report_due_date <-> deadlines — that
--    table carries independent per-row lifecycle state (filed_date, status
--    advanced by staff independently of the account's stored date) and
--    can hold multiple rows per account; not a mirror-pair shape at all.
--
-- The payment-received CLIENT CHAT NOTIFICATION deliberately stays OUT of
-- this trigger (round-3 finding): it would (a) duplicate message/marker
-- wording that lib/portal/chat-events.ts already owns as the single source,
-- risking the reversal path (retirePaymentReceivedNote) silently failing to
-- match a drifted marker, (b) be unable to distinguish a genuine cash
-- settlement from a credit-note settlement (lib/operations/credit-netting.ts
-- deliberately never emits this notification), and (c) flood real clients
-- with false "you just paid" notes if a future bulk data-correction script
-- touches many old, already-settled payments rows at once. The notification
-- stays exactly where it is today, in application code.
-- ============================================================================

-- ─── 1. THE SYNC: payments -> client_expenses, automatic, every UPDATE ──────

CREATE OR REPLACE FUNCTION public.sync_client_expense_from_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw_status text;
  v_mapped_status text;
  v_settled boolean;
  v_amount_due numeric;
BEGIN
  -- Nothing to do if this payment has no client-facing mirror at all
  -- (e.g. a credit note — createTDInvoice deliberately never creates one
  -- for a negative-total invoice; or a contact-only/legacy payment that
  -- predates the TD-invoice system and was never invoiced).
  IF NOT EXISTS (
    SELECT 1 FROM public.client_expenses
    WHERE td_payment_id = NEW.id AND source = 'td_invoice'
  ) THEN
    RETURN NEW;
  END IF;

  -- Same precedence as the TypeScript mapper this replaces:
  -- invoice_status first, payments.status as the fallback.
  v_raw_status := COALESCE(NEW.invoice_status, NEW.status::text);

  v_mapped_status := CASE v_raw_status
    WHEN 'Draft'     THEN 'Pending'
    WHEN 'Sent'      THEN 'Pending'
    WHEN 'Pending'   THEN 'Pending'
    WHEN 'Partial'   THEN 'Pending'
    WHEN 'Overdue'   THEN 'Overdue'
    WHEN 'Paid'      THEN 'Paid'
    WHEN 'Credit'    THEN 'Paid'
    WHEN 'Cancelled' THEN 'Cancelled'
    WHEN 'Split'     THEN 'Cancelled'
    WHEN 'Voided'    THEN 'Cancelled'
    ELSE NULL
  END;

  -- No CHECK constraint protects client_expenses.status today (verified
  -- directly against the live schema — it is plain, unconstrained text),
  -- so an unrecognised status word must fail loudly here rather than be
  -- silently written as garbage the client would see. Confirmed via live
  -- data this is not reachable in practice for any row that actually has a
  -- mirror (every payments row with a NULL invoice_status has zero linked
  -- client_expenses rows) — this is a defensive backstop, not a live path.
  IF v_mapped_status IS NULL THEN
    RAISE EXCEPTION
      'sync_client_expense_from_payment: unrecognised status "%" on payments.id=% — add it to the mapping before this can proceed',
      v_raw_status, NEW.id;
  END IF;

  v_settled := v_mapped_status IN ('Paid', 'Cancelled');

  -- A settled invoice owes zero — never blind-copy payments.amount_due,
  -- which can carry a stale non-zero value on an already-Paid row.
  v_amount_due := CASE WHEN v_settled THEN 0 ELSE COALESCE(NEW.amount_due, 0) END;

  UPDATE public.client_expenses
  SET
    total        = COALESCE(NEW.total, NEW.amount, 0),
    subtotal     = COALESCE(NEW.subtotal, client_expenses.subtotal),
    amount_paid  = COALESCE(NEW.amount_paid, 0),
    amount_due   = v_amount_due,
    status       = v_mapped_status,
    paid_date    = NEW.paid_date,
    due_date     = NEW.due_date,
    description  = COALESCE(NEW.description, client_expenses.description),
    updated_at   = now()
  WHERE td_payment_id = NEW.id AND source = 'td_invoice';

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_client_expense_from_payment IS
  'Dev job 0dcb0a18. THE single authoritative payments -> client_expenses '
  'projection. Fires on every UPDATE to a TD invoice''s money/status/date '
  'fields, for every current and future writer, so the client-facing copy '
  'can never silently drift again. Superseded application code: '
  'lib/portal/td-invoice-mirror.ts (syncTDInvoiceMirror), the mirror-write '
  'body of lib/portal/td-invoice.ts syncTDInvoiceStatus.';

DROP TRIGGER IF EXISTS trg_sync_client_expense ON public.payments;
CREATE TRIGGER trg_sync_client_expense
  AFTER UPDATE OF total, amount, amount_due, amount_paid, status,
                  invoice_status, paid_date, due_date, description, subtotal
  ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_client_expense_from_payment();

-- ─── 2. THE ONE-TIME HEAL: fix every already-drifted mirror row now ─────────
--
-- Routed entirely through the new trigger (a "touch" UPDATE on payments,
-- not a direct write to client_expenses) so it is never blocked by the
-- guard trigger installed in step 3 below, regardless of install order —
-- the cascade payments -> client_expenses always arrives at trigger depth
-- 2, which the guard explicitly allows.
UPDATE public.payments
SET total = total
WHERE id IN (
  SELECT td_payment_id FROM public.client_expenses
  WHERE source = 'td_invoice' AND td_payment_id IS NOT NULL
);

-- ─── 3. THE GUARD: nothing else may write these fields on a td_invoice row ──

CREATE OR REPLACE FUNCTION public.guard_client_expense_td_invoice_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source = 'td_invoice' AND pg_trigger_depth() <= 1 THEN
    IF NEW.total        IS DISTINCT FROM OLD.total
       OR NEW.subtotal    IS DISTINCT FROM OLD.subtotal
       OR NEW.amount_due  IS DISTINCT FROM OLD.amount_due
       OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
       OR NEW.status      IS DISTINCT FROM OLD.status
       OR NEW.paid_date   IS DISTINCT FROM OLD.paid_date
       OR NEW.due_date    IS DISTINCT FROM OLD.due_date
       OR NEW.description IS DISTINCT FROM OLD.description
    THEN
      RAISE EXCEPTION
        'This invoice''s amount, status, and dates are calculated automatically from the real invoice and cannot be edited directly. Edit the invoice itself instead.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_client_expense_td_invoice_write IS
  'Dev job 0dcb0a18. Blocks any DIRECT write (trigger depth <= 1, i.e. not '
  'cascaded from trg_sync_client_expense) to the synced fields on a '
  'source=''td_invoice'' row. Structurally closes the "a fourth writer gets '
  'added later and forgets to sync" bug class, including the previously '
  'unguarded app/portal/invoices/expense-actions.ts markExpensePaid gap.';

DROP TRIGGER IF EXISTS trg_guard_client_expense_td_invoice ON public.client_expenses;
CREATE TRIGGER trg_guard_client_expense_td_invoice
  BEFORE UPDATE ON public.client_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_client_expense_td_invoice_write();
