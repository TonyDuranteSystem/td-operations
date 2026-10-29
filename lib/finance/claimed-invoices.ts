/**
 * "Is this invoice already accounted for by a DIFFERENT bank transaction?"
 *
 * A paid invoice normally has one bank payment behind it. Linking a second transaction to it for
 * the record would double-claim the invoice — and undoing that second link would later reverse the
 * money of the first, because the money ledger is keyed by invoice. So the Match popup flags such
 * invoices, never suggests them, and the server refuses to link to them.
 *
 * Three places record a claim: a matched transaction's own invoice pointer, the member list of a
 * transaction linked to several already-paid invoices, and a confirmed row in the money ledger.
 * Returns null when any of them could not be read — the caller must not guess.
 *
 * Only a PAID invoice can be "taken": one still owed money can receive a second payment normally.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readLinkedPaymentIds } from "@/lib/finance/multi-invoice-link"

export async function readClaimedInvoiceIds(invoiceIds: string[], thisFeedId: string): Promise<Set<string> | null> {
  const claimed = new Set<string>()
  if (invoiceIds.length === 0) return claimed

  const [pointed, multi, applied] = await Promise.all([
    supabaseAdmin.from("td_bank_feeds").select("matched_payment_id").eq("status", "matched").neq("id", thisFeedId).in("matched_payment_id", invoiceIds),
    supabaseAdmin.from("td_bank_feeds").select("review_metadata").eq("status", "matched").neq("id", thisFeedId).eq("review_metadata->>multi_audit_link", "true"),
    supabaseAdmin.from("payment_applications").select("payment_id").neq("feed_id", thisFeedId).not("confirmed_at", "is", null).in("payment_id", invoiceIds),
  ])
  if (pointed.error || multi.error || applied.error) return null

  for (const f of pointed.data ?? []) if (f.matched_payment_id) claimed.add(f.matched_payment_id)
  for (const f of multi.data ?? []) for (const id of readLinkedPaymentIds(f.review_metadata)) claimed.add(id)
  for (const a of applied.data ?? []) if (a.payment_id) claimed.add(a.payment_id)
  return claimed
}
