/**
 * applyMoneyToInvoice — the ONE writer of the `payments` money columns.
 *
 * Why this exists (2026-07-14, Simple Holdings / Fazekas incident): the system
 * had THREE money-application algorithms that disagreed with each other.
 *
 *   1. `settleInvoiceFromFeed` (manual match) — capped + ACCUMULATES
 *      amount_paid, writes amount_due. Correct.
 *   2. `syncInvoiceStatus('payment', …)` (the AUTO matcher) — OVERWRITES
 *      amount_paid and NEVER writes amount_due. A $500 invoice with $300 already
 *      paid, settled by a $200 wire, recorded amount_paid = $200. The $300 was
 *      silently erased.
 *   3. `confirmPayment`'s direct branch — writes status + amount_paid but never
 *      invoice_status and never amount_due, producing "half-closed" invoices
 *      (64 of them in production) that still read as open, still count as
 *      outstanding, and — because the matcher filtered on invoice_status alone —
 *      remained LIVE auto-match targets that could be credited a second time.
 *
 * One function now owns the decision. Every caller routes through it.
 *
 * INVARIANTS (each one is load-bearing — do not "simplify" them away):
 *  - NEVER credit a terminal invoice (see `isTerminalInvoice`). Returns
 *    `applied: false` with a reason instead of silently no-op'ing while
 *    reporting success — that silent-success is what hid the original bug.
 *  - NEVER apply the same bank transaction to the same invoice twice. When a
 *    `feedId` is given, an insert into `payment_applications` (UNIQUE on
 *    (feed_id, payment_id)) is the gate; a unique violation means "already
 *    applied" and the money write is SKIPPED. Because amount_paid now
 *    accumulates, this guard is what stands between us and double-crediting.
 *  - NEVER over-credit: amount_paid is capped at the invoice total by the
 *    shared, unit-tested `resolveInvoiceStatusAfterPayment`.
 *  - ALWAYS write the full coherent tuple (status, invoice_status, amount_paid,
 *    amount_due, paid_date) so the two status columns can never drift again.
 *  - ALWAYS leave an audit row. The cron/auto path previously moved client money
 *    with NO record in action_log at all.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isTerminalInvoice, terminalReason } from "@/lib/finance/invoice-matchability"
import { resolveInvoiceStatusAfterPayment } from "@/lib/finance/invoice-money"

export type ApplyMode =
  /** Add `appliedAmount` to whatever is already paid (bank feed, part-payment). */
  | "apply"
  /** Settle the invoice in full — used when a caller asserts full settlement and passes no amount. */
  | "settle_full"

export interface ApplyMoneyParams {
  paymentId: string
  /** Required for mode 'apply'. Ignored for 'settle_full'. */
  appliedAmount?: number
  mode: ApplyMode
  paidDate: string
  paymentMethod?: string
  /** Who/what did this — lands in action_log and payment_applications. */
  actor: string
  /** Set for bank-feed settlement. Enables the double-credit guard. */
  feedId?: string
}

export interface ApplyMoneyResult {
  applied: boolean
  /** Why nothing was applied — 'terminal' | 'already_applied' | 'not_found' | 'zero_amount' */
  reason?: string
  detail?: string
  invoiceNumber?: string
  newStatus?: "Paid" | "Partial"
  newAmountPaid?: number
  newAmountDue?: number
}

export async function applyMoneyToInvoice(params: ApplyMoneyParams): Promise<ApplyMoneyResult> {
  const { paymentId, mode, paidDate, paymentMethod, actor, feedId } = params

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, status, total, amount, amount_paid, portal_invoice_id, account_id, contact_id")
    .eq("id", paymentId)
    .maybeSingle()

  if (!payment) {
    return { applied: false, reason: "not_found", detail: "Invoice not found." }
  }

  // ── Guard 1: terminal invoices are never credited ───────────────────────
  // A feed may still LINK to a Paid invoice for the audit trail (that is how a
  // Stripe payment gets tied to the invoice its own webhook already closed) —
  // but no money is written. The caller decides whether to record the link.
  if (isTerminalInvoice(payment)) {
    return {
      applied: false,
      reason: "terminal",
      detail: terminalReason(payment) ?? "Invoice is closed.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  const invoiceTotal = Number(payment.total ?? payment.amount ?? 0)
  const currentPaid = Number(payment.amount_paid ?? 0)

  const appliedAmount =
    mode === "settle_full"
      ? Math.max(invoiceTotal - currentPaid, 0)
      : Number(params.appliedAmount ?? 0)

  if (!(appliedAmount > 0)) {
    return {
      applied: false,
      reason: "zero_amount",
      detail: "Nothing to apply — amount is zero.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // Work out what will ACTUALLY be credited before claiming it. The cap matters:
  // a $650 wire against a $500 balance credits $500, not $650. Claiming the raw
  // amount would make the ledger disagree with the invoice, which defeats the
  // point of having a ledger.
  const { newStatus, newAmountPaid, newAmountDue } = resolveInvoiceStatusAfterPayment(
    invoiceTotal,
    currentPaid,
    appliedAmount,
  )
  const creditedAmount = newAmountPaid - currentPaid

  // ── Guard 2: the double-credit lock ─────────────────────────────────────
  // Claim the (feed, invoice) pair BEFORE writing money. The UNIQUE constraint
  // makes this atomic — a concurrent double-click loses the race and applies
  // nothing. Only bank-feed settlement carries a feedId; other channels (Stripe
  // webhook, manual mark-paid) are guarded by confirmPayment's already-paid
  // short-circuit.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any

  // How long an UNCONFIRMED claim is honoured before we treat it as the debris of a
  // crashed attempt. Long enough that a slow-but-alive write is never stolen from;
  // short enough that a human retry isn't blocked for the rest of the day.
  const STALE_CLAIM_MS = 5 * 60 * 1000

  let claimId: string | null = null

  if (feedId) {
    // `payment_applications` is not in the generated Supabase types (same escape as
    // `system_errors`); see 20260714-1500-payment-applications.sql (+ confirmed_at).
    //
    // The claim is taken with confirmed_at NULL and confirmed only once the money has
    // actually landed. An unconfirmed claim is NOT proof that money moved — it is
    // proof that someone STARTED. That distinction is what stops a crashed attempt
    // from bricking the transaction forever behind a false "already applied".
    const { data: claimRow, error: claimErr } = await db
      .from("payment_applications")
      .insert({ feed_id: feedId, payment_id: paymentId, amount: creditedAmount, applied_by: actor })
      .select("id")
      .single()

    if (claimErr) {
      if (claimErr.code === "23505") {
        // Someone else holds the lock. Confirmed → the money really was applied.
        // Unconfirmed and old → the previous attempt died before writing; take it over.
        const { data: existing } = await db
          .from("payment_applications")
          .select("id, confirmed_at, applied_at")
          .eq("feed_id", feedId)
          .eq("payment_id", paymentId)
          .maybeSingle()

        const isStale =
          existing != null &&
          existing.confirmed_at == null &&
          Date.now() - new Date(existing.applied_at).getTime() > STALE_CLAIM_MS

        if (!isStale) {
          return {
            applied: false,
            reason: "already_applied",
            detail: "This transaction has already been applied to this invoice.",
            invoiceNumber: payment.invoice_number ?? undefined,
          }
        }

        // Reclaim the abandoned attempt: take ownership of the existing row rather
        // than deleting and re-inserting (which would reopen the race we just closed).
        const { error: retakeErr } = await db
          .from("payment_applications")
          .update({ amount: creditedAmount, applied_by: actor, applied_at: new Date().toISOString() })
          .eq("id", existing.id)
          .is("confirmed_at", null)

        if (retakeErr) {
          return {
            applied: false,
            reason: "guard_failed",
            detail: `Could not take over the stale payment lock: ${retakeErr.message}`,
            invoiceNumber: payment.invoice_number ?? undefined,
          }
        }
        claimId = existing.id as string
        console.warn(`[apply-payment] Took over a stale, unconfirmed claim for feed=${feedId} payment=${paymentId}`)
      } else {
        // Any other failure: refuse to write money we cannot record.
        return {
          applied: false,
          reason: "guard_failed",
          detail: `Could not record the payment application: ${claimErr.message}`,
          invoiceNumber: payment.invoice_number ?? undefined,
        }
      }
    } else {
      claimId = (claimRow?.id as string) ?? null
    }
  }

  /**
   * Release the lock WE took — by its own id, never by (feed, payment).
   *
   * Deleting by (feed_id, payment_id) is not safe: a delayed failing attempt could
   * delete a DIFFERENT attempt's row — one that had meanwhile succeeded and credited
   * the invoice. The lock would vanish while the money stayed applied, and the next
   * pass would credit it a second time. That is the precise failure this table exists
   * to prevent, so the release must be as precise as the claim.
   */
  const releaseClaim = async (): Promise<string> => {
    if (!claimId) return ""
    const { error: delErr } = await db
      .from("payment_applications")
      .delete()
      .eq("id", claimId)
      .is("confirmed_at", null) // never delete a claim that already committed money
    if (delErr) {
      console.error(`[apply-payment] FAILED TO RELEASE CLAIM ${claimId} (feed=${feedId} payment=${paymentId}):`, delErr.message)
      return " The retry lock could not be released — this transaction may need to be unlocked manually before it can be matched again."
    }
    return ""
  }

  const now = new Date().toISOString()

  // ── The coherent tuple — both status columns, both money columns, always ──
  // The `status` enum is stricter than `invoice_status`: only flip it to Paid on
  // full settlement; a Partial keeps its current enum status (Pending/Overdue).
  const updates: Record<string, unknown> = {
    invoice_status: newStatus,
    amount_paid: newAmountPaid,
    amount_due: newAmountDue,
    updated_at: now,
    ...(newStatus === "Paid" ? { status: "Paid", paid_date: paidDate } : {}),
    ...(paymentMethod ? { payment_method: paymentMethod } : {}),
  }

  // eslint-disable-next-line no-restricted-syntax -- THIS is the choke-point the rule points at (dev_task 7ebb1e0c)
  const { error: updErr } = await supabaseAdmin.from("payments").update(updates).eq("id", paymentId)

  if (updErr) {
    // The money did not land — give the lock back, or this (transaction, invoice)
    // pair is bricked forever behind a false "already applied".
    const releaseNote = await releaseClaim()
    return {
      applied: false,
      reason: "write_failed",
      detail: `${updErr.message}${releaseNote}`,
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // The money has landed. CONFIRM the claim — only a confirmed row is evidence that
  // money was actually applied, and only confirmed rows count toward the invariant
  // sum(payment_applications.amount) == payments.amount_paid.
  if (claimId) {
    const { error: confirmErr } = await db
      .from("payment_applications")
      .update({ confirmed_at: now })
      .eq("id", claimId)
    if (confirmErr) {
      // The money IS applied. A missing confirmation makes the claim look stale, which
      // could later let the same money be applied a second time — so this must be loud.
      console.error(
        `[apply-payment] MONEY APPLIED BUT CLAIM ${claimId} NOT CONFIRMED (feed=${feedId} payment=${paymentId}):`,
        confirmErr.message,
      )
    }
  }

  // ── Mirrors: keep the client-visible copies in step ──────────────────────
  // client_expenses (what the client sees in the portal as a TD invoice).
  try {
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    await syncTDInvoiceStatus(paymentId, newStatus, newStatus === "Paid" ? paidDate : undefined, newAmountPaid)
  } catch (err) {
    console.error(`[apply-payment] client_expenses mirror failed for ${paymentId}:`, err)
  }

  // Legacy client_invoices link (older portal records).
  // supabase-js RETURNS errors, it does not throw them — a try/catch here would be
  // dead code and a failed mirror would vanish silently. Check `error` explicitly.
  if (payment.portal_invoice_id) {
    const { error: mirrorErr } = await supabaseAdmin
      .from("client_invoices")
      .update({
        status: newStatus,
        amount_paid: newAmountPaid,
        amount_due: newAmountDue,
        updated_at: now,
        ...(newStatus === "Paid" ? { paid_date: paidDate } : {}),
      })
      .eq("id", payment.portal_invoice_id)

    if (mirrorErr) {
      // The money IS applied — do not fail the operation. But this must be loud: the
      // client's portal copy now disagrees with the invoice.
      console.error(`[apply-payment] client_invoices mirror FAILED for ${paymentId}:`, mirrorErr.message)
    }
  }

  // ── Audit: the auto/cron path previously wrote NOTHING here ──────────────
  try {
    await supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "payment_applied",
      table_name: "payments",
      record_id: paymentId,
      account_id: payment.account_id,
      contact_id: payment.contact_id,
      summary: `${newStatus === "Paid" ? "Settled" : "Part-paid"} ${payment.invoice_number ?? "invoice"}: ${creditedAmount} applied${feedId ? " from bank transaction" : ""}`,
      details: {
        payment_id: paymentId,
        feed_id: feedId ?? null,
        // What was actually credited (capped at the balance) vs what arrived.
        applied_amount: creditedAmount,
        received_amount: appliedAmount,
        previous_amount_paid: currentPaid,
        new_amount_paid: newAmountPaid,
        new_amount_due: newAmountDue,
        new_status: newStatus,
        mode,
        payment_method: paymentMethod ?? null,
      },
    })
  } catch (err) {
    console.error(`[apply-payment] action_log write failed for ${paymentId}:`, err)
  }

  return {
    applied: true,
    invoiceNumber: payment.invoice_number ?? undefined,
    newStatus,
    newAmountPaid,
    newAmountDue,
  }
}
