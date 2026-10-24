/**
 * Marketing sale -> Finance's Bank Feed (incoming-payments, dev job 40a58d9a). SERVER-ONLY, best effort.
 *
 * A payment that Antonio confirms as a TD Marketing sale writes NO client payment, so its Stripe row in Finance → Bank Feed would sit
 * "unmatched" forever as work nobody can do. This marks THAT row as handled and says why, so Finance and Marketing agree on the same money:
 *   - only the Stripe row of THIS payment (matched on its payment-intent id) and only while it is still "unmatched" (a row someone already
 *     matched, ignored or flagged is never touched);
 *   - status becomes "ignored" (the dismissal the Bank Feed already has — it leaves the work list and the matcher never reconsiders it) and the
 *     row's review note carries the marketing sale id, the marketing lead and who did it, so the tag is findable from Finance;
 *   - it never throws: the sale is already recorded, a failed tag is reported back as `tagged: false` and logged.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface FeedTagResult {
  tagged: boolean
  reason?: string
  feedId?: string
}

export async function tagBankFeedAsMarketingSale(input: {
  paymentIntentId: string | null
  saleId: string
  marketingLeadId: string
  leadName: string | null
  actor: string
}, now: Date = new Date()): Promise<FeedTagResult> {
  const pi = input.paymentIntentId?.trim()
  if (!pi) return { tagged: false, reason: "the payment has no Stripe payment-intent id" }
  try {
    const { data, error } = await db()
      .from("td_bank_feeds")
      .select("id, status, review_metadata")
      .eq("source", "stripe")
      .eq("raw_data->>payment_intent", pi)
      .limit(3)
    if (error) return { tagged: false, reason: `could not read the Bank Feed: ${error.message}` }
    const rows = (data ?? []) as Array<{ id: string; status: string; review_metadata: Record<string, unknown> | null }>
    if (rows.length === 0) return { tagged: false, reason: "no Bank Feed row for this payment (it may not have synced yet)" }
    if (rows.length > 1) return { tagged: false, reason: "more than one Bank Feed row for this payment: left for a person" }
    const row = rows[0]
    if (row.status !== "unmatched") return { tagged: false, reason: `the Bank Feed row is already "${row.status}": left as it is`, feedId: row.id }
    const review = {
      ...(row.review_metadata ?? {}),
      note: `Marketing sale${input.leadName ? ` — ${input.leadName}` : ""}: recorded on the TD Marketing Money page, not an invoice payment.`,
      marketing_sale: { sale_id: input.saleId, marketing_lead_id: input.marketingLeadId, tagged_by: input.actor, tagged_at: now.toISOString() },
    }
    // "still unmatched" is part of the write itself, so a colleague matching the row at the same moment is never overwritten.
    const { data: changed, error: upErr } = await db()
      .from("td_bank_feeds")
      .update({ status: "ignored", review_metadata: review, updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "unmatched")
      .select("id")
    if (upErr) return { tagged: false, reason: `could not update the Bank Feed row: ${upErr.message}`, feedId: row.id }
    if (!changed || changed.length === 0) return { tagged: false, reason: "the Bank Feed row changed meanwhile: left as it is", feedId: row.id }
    return { tagged: true, feedId: row.id }
  } catch (err) {
    console.error(`[incoming-payments] could not tag the Bank Feed row for ${pi}:`, err instanceof Error ? err.message : err)
    return { tagged: false, reason: "unexpected error (logged)" }
  }
}
