/**
 * Cascade-cancel TD invoices linked to one or more offer tokens.
 *
 * Used by the three offer-cleanup paths in app/api/crm/admin-actions:
 *   - delete-offer
 *   - reset-offer
 *   - delete-lead
 *
 * Without this step, deleting/resetting an offer leaves the TD invoice that
 * was created by app/api/webhooks/offer-signed at sign time orphaned in the
 * client portal — the client still sees a "due" invoice for a deal that no
 * longer exists. Precedent: INV-002090 / INV-002091 for Mojo Labs LLC.
 *
 * Soft-cancel only (status='Cancelled', invoice_status='Cancelled') so the
 * audit trail is preserved. The mirror row in client_expenses is updated via
 * syncTDInvoiceStatus so the portal stops showing it as Pending.
 *
 * idempotency_key is NULLed on cancel so that if the offer is recreated and
 * re-signed under the same token, createTDInvoice can mint a fresh invoice
 * (the offer-signed webhook keys on `offer-signed:{offer_token}`).
 *
 * Refuses to cascade if any linked payment has been paid — surfaces details so
 * the admin can resolve manually instead of silently voiding real revenue.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncTDInvoiceStatus } from "@/lib/portal/td-invoice"
import { logAction } from "@/lib/mcp/action-log"

export interface BlockedPaidInvoice {
  payment_id: string
  invoice_number: string | null
  status: string
  amount_paid: number
}

export interface CancelOfferPaymentsResult {
  ok: boolean
  cancelled: number
  /** All payment ids that were considered (already-cancelled + newly cancelled). */
  payment_ids: string[]
  /** Populated when refusal occurred — list of paid invoices that blocked the cascade. */
  blocked_paid?: BlockedPaidInvoice[]
  error?: string
}

/**
 * Find all TD payments linked to the given offer tokens (via
 * pending_activations.portal_invoice_id) and cancel them. Idempotent — calling
 * twice is safe; the second call returns cancelled=0 with the same payment_ids.
 *
 * @param offerTokens — offer.token values whose linked payments should be cancelled
 * @param actor — string written to action_log (e.g. `dashboard:antonio`)
 */
export async function cancelPaymentsForOfferTokens(
  offerTokens: string[],
  actor: string,
): Promise<CancelOfferPaymentsResult> {
  if (!offerTokens.length) {
    return { ok: true, cancelled: 0, payment_ids: [] }
  }

  // 1. Collect payment ids linked via pending_activations.
  const { data: activations, error: actErr } = await supabaseAdmin
    .from("pending_activations")
    .select("portal_invoice_id")
    .in("offer_token", offerTokens)
    .not("portal_invoice_id", "is", null)

  if (actErr) {
    return {
      ok: false,
      cancelled: 0,
      payment_ids: [],
      error: `pending_activations lookup failed: ${actErr.message}`,
    }
  }

  const paymentIds = Array.from(
    new Set(
      (activations ?? [])
        .map((a) => a.portal_invoice_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  )

  if (!paymentIds.length) {
    return { ok: true, cancelled: 0, payment_ids: [] }
  }

  // 2. Load current state — refuse if any have been paid.
  const { data: payments, error: payErr } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, status, invoice_status, amount_paid")
    .in("id", paymentIds)

  if (payErr) {
    return {
      ok: false,
      cancelled: 0,
      payment_ids: paymentIds,
      error: `payments lookup failed: ${payErr.message}`,
    }
  }

  const paid = (payments ?? []).filter((p) => {
    const amt = Number(p.amount_paid ?? 0)
    return p.status === "Paid" || amt > 0
  })

  if (paid.length > 0) {
    return {
      ok: false,
      cancelled: 0,
      payment_ids: paymentIds,
      blocked_paid: paid.map((p) => ({
        payment_id: p.id as string,
        invoice_number: (p.invoice_number as string | null) ?? null,
        status: (p.status as string) ?? "",
        amount_paid: Number(p.amount_paid) || 0,
      })),
      error: `Refusing to cancel: ${paid.length} payment(s) already paid (${paid
        .map((p) => p.invoice_number || p.id)
        .join(", ")}). Resolve the payment first or unlink it before deleting the offer.`,
    }
  }

  // 3. Skip rows already cancelled — idempotency.
  const cancellable = (payments ?? []).filter(
    (p) => p.status !== "Cancelled" && p.invoice_status !== "Cancelled",
  )

  if (!cancellable.length) {
    return { ok: true, cancelled: 0, payment_ids: paymentIds }
  }

  const cancellableIds = cancellable.map((p) => p.id as string)

  // 4. Soft-cancel + free idempotency key so a future re-sign with the same
  //    offer token can create a fresh invoice.
  const { error: upErr } = await supabaseAdmin
    .from("payments")
    .update({
      status: "Cancelled",
      invoice_status: "Cancelled",
      idempotency_key: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", cancellableIds)

  if (upErr) {
    return {
      ok: false,
      cancelled: 0,
      payment_ids: paymentIds,
      error: `payments update failed: ${upErr.message}`,
    }
  }

  // 5. Mirror to client_expenses so the portal stops showing the row as Pending.
  for (const pid of cancellableIds) {
    try {
      await syncTDInvoiceStatus(pid, "Cancelled")
    } catch (e) {
      console.error(
        `[cancel-offer-payments] client_expenses mirror sync failed for ${pid}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }

  // 6. action_log — one entry per voided invoice for clarity in audit.
  for (const p of cancellable) {
    logAction({
      actor,
      action_type: "update",
      table_name: "payments",
      record_id: p.id as string,
      summary: `Voided invoice ${p.invoice_number || p.id} — offer cascade cleanup`,
      details: {
        invoice_number: p.invoice_number,
        previous_status: p.status,
        previous_invoice_status: p.invoice_status,
        reason: "offer-deleted-cascade",
      },
    })
  }

  return { ok: true, cancelled: cancellable.length, payment_ids: cancellableIds }
}
