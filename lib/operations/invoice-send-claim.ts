/**
 * Exactly-once sending of a Draft invoice (dev job ae3c19db, end-to-end QA): the one place that stamps / releases the "I am sending this" mark.
 *
 * Why it exists: several clicks on the Calendar's Raise-and-send get the SAME Draft back from the idempotency key, and sendTDInvoice checks
 * "already sent?" BEFORE it sends — so every click passed that check and emailed the client (5 clicks → 5 emails, 1 invoice). The click that
 * wins this atomic claim is the only one that sends.
 *
 * The mark is `payments.sent_at` on a row that is still a Draft: the claim only succeeds while `sent_at` is empty or older than a few minutes
 * (a server that died mid-send must not block the invoice for ever). sendTDInvoice overwrites `sent_at` with the real send time when it finishes.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** How long a claim blocks others before it counts as abandoned. */
export const SEND_CLAIM_STALE_MS = 3 * 60_000

/** True = this caller now owns the send. False = someone else is sending it (or already did). Throws only on a database error. */
export async function claimInvoiceSend(paymentId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - SEND_CLAIM_STALE_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from("payments")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", paymentId)
    .eq("invoice_status", "Draft")
    .or(`sent_at.is.null,sent_at.lt.${staleBefore}`)
    .select("id")
  if (error) throw new Error(error.message)
  return (data ?? []).length === 1
}

/** The send failed: give the claim back so the next click can try again (only while it is still an unsent Draft). Never throws. */
export async function releaseInvoiceSendClaim(paymentId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("payments").update({ sent_at: null }).eq("id", paymentId).eq("invoice_status", "Draft")
  if (error) console.error("[invoice-send-claim] claim could not be released:", error.message)
}
