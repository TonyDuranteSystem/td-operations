/**
 * P1.6 — Payment operation authority layer
 *
 * Single-entry wrappers for payment-related writes: invoice creation,
 * status transition to Paid, and installment side effects.  Thin shims over
 * existing canonical helpers (`createTDInvoice`, `syncInvoiceStatus`,
 * `onFirstInstallmentPaid`, `onSecondInstallmentPaid`) so that P1.6 callers
 * can import from a single stable surface.
 *
 * Why this wrapper exists even though the underlying helpers already exist:
 * the plan §4 P1.6 specifies a cohesive `lib/operations/` directory so that
 * future characterization tests (P1.7) and freeze rules (§9.4) can target
 * a single import surface.  The long-term goal is that any write to
 * `payments` / `client_invoices` / `client_expenses` goes through
 * `lib/operations/payment.ts` — not raw SQL and not scattered direct
 * `.from("payments")` calls.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite } from "@/lib/db"
import {
  createTDInvoice,
  reconcileTDInvoiceMirror,
  type TDInvoiceInput,
  type TDInvoiceResult,
  type ReconcileTDMirrorResult,
} from "@/lib/portal/td-invoice"
// The client-visible mirrors (client_expenses + client_invoices) are now written
// inside applyMoneyToInvoice — the one money writer — so this module no longer
// calls syncTDInvoiceStatus / syncInvoiceStatus directly.
import { applyMoneyToInvoice } from "@/lib/finance/apply-payment"
import {
  onFirstInstallmentPaid,
  onSecondInstallmentPaid,
} from "@/lib/installment-handler"

// ─── Types ─────────────────────────────────────────────

export type CreateInvoiceParams = TDInvoiceInput

export interface ConfirmPaymentParams {
  payment_id: string
  paid_date?: string
  amount_paid?: number
  /**
   * If false, skip installment side effects.  Default true.
   *
   * Installment side effects are already handled by the DB trigger fixed in
   * P1.5 (see lib/mcp/tools/crm.ts crm_update_record), so direct calls from
   * MCP / CRM buttons don't need to re-run them.  This flag lets integration
   * points that bypass the trigger (e.g. Whop webhook, wire-cron) opt in.
   */
  trigger_installment_handler?: boolean
}

export interface ConfirmPaymentResult {
  success: boolean
  payment_id: string
  /**
   * "partial" (2026-07-14): the caller passed an amount smaller than the balance.
   * The money is recorded and the invoice keeps its remaining debt — but it is NOT
   * settled, so no installment handler and no paid receipt fire.
   */
  outcome: "paid" | "partial" | "already_paid" | "error"
  installment_handler?: {
    triggered: boolean
    year?: number
    number?: 1 | 2
    steps?: unknown
    reason?: string
  }
  error?: string
}

export type InstallmentNumber = 1 | 2

// ─── createInvoice ─────────────────────────────────────

/**
 * Create a TD invoice (payment row + client_expenses mirror).
 *
 * Thin wrapper over `createTDInvoice`.  Exposed here so future callers can
 * treat `lib/operations/payment.ts` as the single import surface for
 * invoice/payment writes.
 */
export async function createInvoice(
  params: CreateInvoiceParams,
): Promise<TDInvoiceResult> {
  return createTDInvoice(params)
}

// ─── confirmPayment ────────────────────────────────────

/**
 * Mark a payment as Paid and sync downstream records.
 *
 * When `trigger_installment_handler=true` and the payment row has
 * `installment="Installment 1 (Jan)"` or `"Installment 2 (Jun)"` and
 * the account is `account_type="Client"`, the matching installment
 * handler is invoked after the Paid transition.  This mirrors the DB
 * trigger fixed in P1.5 for callers that bypass `crm_update_record`.
 */
export async function confirmPayment(
  params: ConfirmPaymentParams,
): Promise<ConfirmPaymentResult> {
  const paid_date = params.paid_date || new Date().toISOString().split("T")[0]

  const { data: payment, error: payErr } = await supabaseAdmin
    .from("payments")
    .select("id, account_id, installment, status, portal_invoice_id, year")
    .eq("id", params.payment_id)
    .single()

  if (payErr || !payment) {
    return {
      success: false,
      payment_id: params.payment_id,
      outcome: "error",
      error: `Payment not found: ${payErr?.message || "unknown"}`,
    }
  }

  if (payment.status === "Paid") {
    return {
      success: true,
      payment_id: params.payment_id,
      outcome: "already_paid",
    }
  }

  // ONE writer for both branches (2026-07-14). Previously this function had two,
  // and BOTH were broken:
  //   * the portal_invoice_id branch called syncInvoiceStatus('invoice', …), which
  //     only touches client_invoices — it NEVER wrote the payments row at all, yet
  //     this function still returned outcome:"paid". The idempotency guard above
  //     reads payment.status, the very column that branch never wrote, so a
  //     retried Stripe webhook re-fired the installment handler and the receipt.
  //   * the direct branch wrote status + amount_paid but never invoice_status and
  //     never amount_due — the source of the 64 "half-closed" invoices that still
  //     read as open, still counted as outstanding, and stayed matchable.
  //
  // applyMoneyToInvoice writes the full coherent tuple, mirrors client_expenses and
  // client_invoices, caps the amount, and logs to action_log.
  //
  // Mode: when the caller passes an explicit amount (the Stripe webhook passes the
  // amount actually charged), APPLY that amount — defaulting to the invoice total
  // would silently convert a part-payment into a full credit. With no amount, the
  // caller is asserting full settlement.
  const apply = await applyMoneyToInvoice({
    paymentId: payment.id,
    mode: params.amount_paid !== undefined ? "apply" : "settle_full",
    appliedAmount: params.amount_paid,
    paidDate: paid_date,
    actor: "confirm-payment",
  })

  if (!apply.applied) {
    // Terminal / zero — nothing was written. Report honestly instead of claiming paid.
    return {
      success: apply.reason === "terminal",
      payment_id: params.payment_id,
      outcome: apply.reason === "terminal" ? "already_paid" : "error",
      ...(apply.reason === "terminal" ? {} : { error: apply.detail || "Payment could not be applied." }),
    }
  }

  // A part-payment is NOT a settlement: no installment handler, no paid receipt.
  if (apply.newStatus === "Partial") {
    return {
      success: true,
      payment_id: params.payment_id,
      outcome: "partial",
    }
  }

  let installment_handler: ConfirmPaymentResult["installment_handler"] | undefined
  if (
    params.trigger_installment_handler !== false &&
    payment.account_id &&
    payment.installment
  ) {
    // Renewal year comes from the PAYMENT ROW, not the calendar (council
    // 2026-07-17): a 2026 installment paid/reconciled in January 2027 must
    // fire for renewal year 2026 (tax year 2025) — paid-date year would
    // create/ensure a tax record for a season the client never paid.
    const year = payment.year ?? new Date(paid_date).getFullYear()
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("account_type")
      .eq("id", payment.account_id)
      .single()

    if (acct?.account_type !== "Client") {
      installment_handler = {
        triggered: false,
        reason: `account_type=${acct?.account_type || "unknown"}, not Client`,
      }
    } else if (payment.installment === "Installment 1 (Jan)") {
      const r = await onFirstInstallmentPaid(payment.account_id, year)
      installment_handler = { triggered: true, year, number: 1, steps: r.steps }
    } else if (payment.installment === "Installment 2 (Jun)") {
      const r = await onSecondInstallmentPaid(payment.account_id, year)
      installment_handler = { triggered: true, year, number: 2, steps: r.steps }
    } else {
      installment_handler = {
        triggered: false,
        reason: `installment="${payment.installment}" not Installment 1/2`,
      }
    }
  }

  // Fire-and-forget receipt email. Never blocks the paid transition —
  // a missing email address or transient Gmail error must not roll back
  // the payment. sendPaidReceipt guards against payments without an
  // invoice_number (ad-hoc bookkeeping entries) internally.
  import("@/lib/invoice-auto-send").then(({ sendPaidReceipt }) =>
    sendPaidReceipt(params.payment_id).catch((err) =>
      console.error("[confirmPayment] receipt send failed:", err),
    ),
  )

  return {
    success: true,
    payment_id: params.payment_id,
    outcome: "paid",
    installment_handler,
  }
}

// ─── reconcilePaymentByInvoiceNumber ───────────────────

/**
 * Channel-agnostic reconciliation: given the (globally-unique) invoice number a
 * payment was made against, mark THAT invoice Paid and fire the installment
 * handler — the single step every payment channel should funnel through (Stripe
 * webhook today; any future channel). Matches by invoice number, so it works
 * even when a third party pays (we reconcile the invoice, not the payer name).
 *
 * Returns `reconciled: true` ONLY when this call flipped the invoice Paid
 * (outcome "paid"). An already-paid invoice returns `reconciled: false` so the
 * caller can still record a genuine second payment instead of silently dropping
 * it. Returns `reconciled: false` (no outcome) when no invoice matches.
 */
export async function reconcilePaymentByInvoiceNumber(
  invoiceNumber: string,
  opts: { amountPaid?: number; paidDate?: string; stripePaymentId?: string } = {},
): Promise<{ reconciled: boolean; outcome?: ConfirmPaymentResult["outcome"]; payment_id?: string }> {
  const { data: existing } = await supabaseAdmin
    .from("payments")
    .select("id, stripe_payment_id")
    .eq("invoice_number", invoiceNumber)
    .limit(1)
    .maybeSingle()

  if (!existing?.id) return { reconciled: false }

  const result = await confirmPayment({
    payment_id: existing.id,
    paid_date: opts.paidDate,
    amount_paid: opts.amountPaid,
    trigger_installment_handler: true,
  })

  // "partial" counts as RECONCILED (2026-07-14). The money was applied to this
  // invoice — it simply did not cover the whole balance.
  //
  // This is load-bearing for the Stripe webhook: it inserts a fresh payments row
  // whenever reconciliation reports failure. Before `partial` existed, this path
  // always returned "paid", so the webhook never fired. Treating a part-payment as
  // NOT reconciled would make the webhook record the same money a SECOND time — as a
  // full standalone payment — on top of the partial credit just applied. A duplicate,
  // in the exact table this work exists to make trustworthy.
  if (result.outcome !== "paid" && result.outcome !== "partial") {
    return { reconciled: false, outcome: result.outcome, payment_id: existing.id }
  }

  // Stamp the Stripe id for idempotency + audit, without clobbering an existing one.
  if (opts.stripePaymentId && !existing.stripe_payment_id) {
    await dbWrite(
      supabaseAdmin
        .from("payments")
        .update({ stripe_payment_id: opts.stripePaymentId, payment_method: "Stripe" })
        .eq("id", existing.id),
      "payments.update",
    )
  }

  return { reconciled: true, outcome: result.outcome, payment_id: existing.id }
}

// ─── reconcileInvoiceMirror (task 918fe55e) ───────────

/**
 * Force the client-visible `client_expenses` row to match the current
 * `payments` row for a given payment. Thin re-export over
 * `reconcileTDInvoiceMirror` so lib/operations/ stays the single
 * import surface for payment-related writes.
 */
export async function reconcileInvoiceMirror(
  paymentId: string,
): Promise<ReconcileTDMirrorResult> {
  return reconcileTDInvoiceMirror(paymentId)
}

// ─── onInstallmentPaid ─────────────────────────────────

/**
 * Direct entry point for the installment side-effect chain.
 *
 * Used by the DB trigger path (crm_update_record) and by confirmPayment.
 * Most callers should prefer `confirmPayment` which ensures the payment
 * row itself reaches `status="Paid"` first.
 */
export async function onInstallmentPaid(
  account_id: string,
  year: number,
  number: InstallmentNumber,
): Promise<{ steps: Array<{ step: string; status: string; detail?: string }> }> {
  if (number === 1) return onFirstInstallmentPaid(account_id, year)
  if (number === 2) return onSecondInstallmentPaid(account_id, year)
  throw new Error(`[onInstallmentPaid] invalid installment number: ${number}`)
}
