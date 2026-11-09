/**
 * Raise a STAFF-ONLY portal issue for the card-fee edge cases (dev_task 6ec6872a).
 *
 * Who sees it TODAY: the hourly admin email digest (app/api/cron/portal-issues), which
 * lists every open `portal_issues` row — company (from `account_id`), area, and the
 * FIRST 80 CHARACTERS of the message. So the message must lead with what matters (the
 * invoice number and the figures) and the row must carry `account_id`. There is no
 * dashboard "Issue tab" that reads this table (checked 2026-11-09). It is NOT rendered
 * on any client-facing portal page, so an internal money note never leaks.
 *
 * Both raises are DEDUPED on the gateway payment id: Stripe retries webhooks and
 * activation can fail repeatedly, so we must not spawn duplicate issues for one
 * payment. An existing OPEN card_fee issue with the same key short-circuits.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

const AREA = 'card_fee'

async function alreadyOpen(gatewayPaymentId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin
      .from('portal_issues')
      .select('id')
      .eq('area', AREA)
      .is('resolved_at', null)
      .contains('error_context', { gateway_payment_id: gatewayPaymentId })
      .limit(1)
    return !!data?.length
  } catch {
    return false // never let dedup lookup block raising the alert
  }
}

async function insertIssue(params: {
  paymentId: string | null
  /** Links the row to a company so the digest shows its name instead of "Unknown". */
  accountId?: string | null
  message: string
  context: Record<string, unknown>
}): Promise<void> {
  try {
    // portal_issues insert shape is loosely typed in the generated types; cast the
    // row so `status`/`client_notified` (both have DB defaults) are accepted.
    const row = {
      area: AREA,
      account_id: params.accountId ?? null,
      error_message: params.message,
      error_context: params.context,
      status: 'open',
      client_notified: false, // staff-only, never surfaced to the client
    } as never
    // supabase-js RETURNS errors instead of throwing — read it, or a failed insert is
    // a silent "no alert" (the money already moved and nobody would know).
    const { error } = await supabaseAdmin.from('portal_issues').insert(row)
    if (error) console.error('[card-fee-issues] failed to raise issue:', error.message)
  } catch (e) {
    // The money already moved; a failed alert must not break the webhook.
    console.error('[card-fee-issues] failed to raise issue:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * The charge did not match the invoice base — real money sits at the gateway with no
 * matching invoice line. Raise IMMEDIATELY (this will not self-heal).
 */
export async function raiseCardFeeOverageIssue(p: {
  paymentId: string | null
  base: number
  charged: number
  gatewayPaymentId: string
}): Promise<void> {
  if (await alreadyOpen(p.gatewayPaymentId)) return
  // Best-effort: the invoice number and company make the alert readable. A failed lookup
  // must never stop the alert itself.
  let invoiceNumber: string | null = null
  let accountId: string | null = null
  if (p.paymentId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns newer than the generated types
      const { data } = await (supabaseAdmin as any).from('payments').select('invoice_number, account_id').eq('id', p.paymentId).maybeSingle()
      invoiceNumber = data?.invoice_number ?? null
      accountId = data?.account_id ?? null
    } catch { /* alert without the lookup */ }
  }
  await insertIssue({
    paymentId: p.paymentId,
    accountId,
    // The digest shows only the first 80 characters: invoice + figures + the action first.
    message: `${invoiceNumber ?? 'Invoice'} card overpay: charged ${p.charged}, owed ${p.base} — refund the surplus. No fee was booked; the invoice was settled for what was owed.`,
    context: {
      kind: 'overage',
      gateway_payment_id: p.gatewayPaymentId,
      payment_id: p.paymentId,
      base: p.base,
      charged: p.charged,
    },
  })
}

/**
 * A card payment succeeded (invoice is Paid) but the automatic account setup failed.
 * Client sees Paid; staff finish setup from here. Raised after the webhook's retries
 * reach the failure branch (dedup keeps it to one per payment across retries).
 */
export async function raiseActivationFailedIssue(p: {
  paymentId: string | null
  pendingActivationId: string
  clientName: string | null
  email: string | null
  error: string
  gatewayPaymentId: string
}): Promise<void> {
  if (await alreadyOpen(p.gatewayPaymentId)) return
  await insertIssue({
    paymentId: p.paymentId,
    message: `Payment received (invoice Paid) but automatic setup failed for ${p.clientName || p.email || 'a client'} — finish setup by hand. ${p.error}`,
    context: {
      kind: 'activation_failed',
      gateway_payment_id: p.gatewayPaymentId,
      payment_id: p.paymentId,
      pending_activation_id: p.pendingActivationId,
      error: p.error,
    },
  })
}
