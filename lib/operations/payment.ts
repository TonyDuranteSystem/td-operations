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
  syncTDInvoiceStatus,
  reconcileTDInvoiceMirror,
  type TDInvoiceInput,
  type TDInvoiceResult,
  type ReconcileTDMirrorResult,
} from "@/lib/portal/td-invoice"
import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"
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
  outcome: "paid" | "already_paid" | "error"
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
    .select("id, account_id, installment, status, portal_invoice_id")
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

  // Route through syncInvoiceStatus when linked to a portal invoice — it
  // updates payments, client_invoices, and client_expenses coherently.
  if (payment.portal_invoice_id) {
    await syncInvoiceStatus(
      "invoice",
      payment.portal_invoice_id,
      "Paid",
      paid_date,
      params.amount_paid,
    )
  } else {
    // Direct update path for payments without a portal invoice link (wire,
    // ad-hoc, or legacy installment payments).
    const updates: Record<string, unknown> = {
      status: "Paid",
      paid_date,
      updated_at: new Date().toISOString(),
    }
    if (params.amount_paid !== undefined) {
      updates.amount_paid = params.amount_paid
    }
    await dbWrite(
      supabaseAdmin.from("payments").update(updates).eq("id", payment.id),
      "payments.update",
    )

    // Mirror the status transition to client_expenses (task 918fe55e —
    // prior behavior silently left client_expenses on 'Overdue' when a
    // wire/ad-hoc payment was confirmed via this path, causing 6
    // client-visible invoices to stay "overdue" in the portal after
    // payment. Backfilling + calling sync here so new confirmations
    // don't recreate the drift.
    await syncTDInvoiceStatus(
      payment.id,
      "Paid",
      paid_date,
      params.amount_paid,
    )
  }

  let installment_handler: ConfirmPaymentResult["installment_handler"] | undefined
  if (
    params.trigger_installment_handler !== false &&
    payment.account_id &&
    payment.installment
  ) {
    const year = new Date(paid_date).getFullYear()
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
