/**
 * Finance settles a TD Marketing payment (SERVER-ONLY; TD Marketing, dev job 9aec66fa — Antonio, 2026-10-28: "what regulates everything is Finance. When the
 * payment is matched with the marketing sale and the lead, the card on Marketing moves, not before" … "create the invoice and send it to them", and the paid
 * call gives a credit like every strategic-call link made in the CRM).
 *
 * One Stripe payment row in the Bank Feed that carries Rocco's link labels is settled in this order, every step safe to run twice:
 *   1. the checks (still our money, the amount and the lead agree with the sale) — anything doubtful is parked "needs review" for a person, never guessed;
 *   2. the paid Strategic Call invoice + the deductible credit (the same as a CRM link: `recordPaidCall`), filed under the Stripe session so a retry adds nothing;
 *   3. the sale becomes PAID and the lead's card moves to Paid (`recordPaidSession`, paid at the real payment time);
 *   4. the Bank Feed row is marked MATCHED to the invoice — last, because it is what tells the sync "this one is done";
 *   5. the invoice is emailed to the lead ONCE (a lock row per Stripe session; a failed email is written on the row and reported, never retried into a duplicate).
 * The Stripe webhook no longer marks the sale paid by itself: only this does.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { recordPaidSession } from "@/lib/marketing/sales-server"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { isChargeRefundedNow } from "@/lib/stripe-sync"
import { updateFeed } from "@/lib/finance/feed-write"
import { auditLinkMetadata } from "@/lib/finance/feed-vocabulary"
import { checkSaleAgainstFeed, marketingRefFromFeed, receiptLanguage, type MarketingFeedRef, type SaleFacts } from "@/lib/finance/marketing-sale-ref"
import { extractStripePaymentIntent } from "@/lib/finance/feed-signals"
import { reportSystemError } from "@/lib/system-errors"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdb = () => supabaseAdmin as any

/** The only kind of marketing sale Finance invoices today (it is the only kind that exists): the paid Strategic Call. Another kind is parked until it has its own rule. */
export const INVOICED_SALE_KIND = "strategic_call"

export type MarketingSettleResult =
  | { matched: true; paymentId: string; invoiceNumber?: string; alreadyMatched?: boolean; email?: "sent" | "skipped" | "failed"; note?: string }
  | { matched: false; notMarketing?: true; parked?: true; error?: string; note?: string }

async function park(feedId: string, reason: string): Promise<MarketingSettleResult> {
  await updateFeed(feedId, { status: "needs_review", review_metadata: { marketing_sale_problem: reason, checked_at: new Date().toISOString() } }, "marketing-sale:park")
  return { matched: false, parked: true, note: reason }
}

export async function settleMarketingSaleFromFeed(feedId: string, opts: { sendEmail?: boolean; allowStatuses?: string[] } = {}): Promise<MarketingSettleResult> {
  const { data: feed, error: fErr } = await sdb().from("td_bank_feeds").select("*").eq("id", feedId).maybeSingle()
  if (fErr || !feed) return { matched: false, error: `Feed not found: ${fErr?.message ?? "no row"}` }
  if (feed.status === "matched" && feed.matched_payment_id) return { matched: true, paymentId: feed.matched_payment_id, alreadyMatched: true }
  if (!(opts.allowStatuses ?? ["unmatched"]).includes(feed.status)) return { matched: false, note: `the row is "${feed.status}": left as it is` }

  const ref = marketingRefFromFeed(feed)
  if (!ref) return { matched: false, notMarketing: true }
  return settleWithRef(feedId, feed, ref, opts)
}

/**
 * The same settlement for a payment that does NOT carry Rocco's labels, when a person says which sale it was (a payment made through a hand-made Stripe link,
 * recorded as a marketing sale by hand afterwards — Monica Germani's €397 of 23 Oct). The sale's own link and amount are still checked against the money.
 */
export async function settleMarketingSaleByHand(input: { feedId: string; saleId: string; sendEmail?: boolean }): Promise<MarketingSettleResult> {
  const { data: feed } = await sdb().from("td_bank_feeds").select("*").eq("id", input.feedId).maybeSingle()
  if (!feed) return { matched: false, error: "Feed not found." }
  if (feed.status === "matched" && feed.matched_payment_id) return { matched: true, paymentId: feed.matched_payment_id, alreadyMatched: true }
  if (feed.source !== "stripe" || !["unmatched", "ignored"].includes(feed.status)) return { matched: false, note: `the row is "${feed.status}" (${feed.source}): left as it is` }
  const { data: sale } = await sdb().from("marketing_sales").select("id, lead_id, team_id, stripe_session_id, stripe_payment_intent").eq("id", input.saleId).maybeSingle()
  if (!sale) return { matched: false, error: "Sale not found." }
  const pi = extractStripePaymentIntent(feed) ?? (sale.stripe_payment_intent as string | null)
  // the payment must be the one this sale was paid with: same Stripe payment when both say so
  if (pi && sale.stripe_payment_intent && pi !== sale.stripe_payment_intent) return park(input.feedId, "this payment is not the one the sale was recorded with")
  const ref: MarketingFeedRef = { saleId: sale.id, leadId: sale.lead_id, teamId: sale.team_id, paymentIntentId: pi, sessionId: sale.stripe_session_id, amountCents: Math.round(Number(feed.amount) * 100), currency: String(feed.currency ?? "").toUpperCase() }
  return settleWithRef(input.feedId, feed, ref, { sendEmail: input.sendEmail })
}

async function settleWithRef(feedId: string, feed: Record<string, any>, ref: MarketingFeedRef, opts: { sendEmail?: boolean }): Promise<MarketingSettleResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
  // Still our money? A refund after the sync would otherwise be booked as a sale. "defer" = Stripe could not be reached: try again next run.
  const refund = feed.external_id ? await isChargeRefundedNow(String(feed.external_id)) : "unchecked"
  if (refund === "refunded") return park(feedId, "Stripe says this payment was refunded or disputed: no invoice, the sale stays unpaid")
  if (refund === "defer") return { matched: false, error: "Could not verify the payment with Stripe (will retry on the next run)." }

  const db = leadDb() as Db
  const { data: sale } = await sdb().from("marketing_sales").select("id, lead_id, status, kind, amount_cents, currency, stripe_session_id, team_id").eq("id", ref.saleId).maybeSingle()
  if (!sale) return park(feedId, "the sale named by the payment was not found")
  const s = sale as SaleFacts & { kind: string; team_id: string }
  const check = checkSaleAgainstFeed(s, ref)
  if (check.ok === false) return park(feedId, check.reason)
  if (s.kind !== INVOICED_SALE_KIND) return park(feedId, `sales of kind "${s.kind}" have no invoice rule yet`)
  if (ref.currency !== "EUR" && ref.currency !== "USD") return park(feedId, `the payment is in ${ref.currency}, which invoices do not support`)
  const sessionId = ref.sessionId ?? s.stripe_session_id
  if (!sessionId) return park(feedId, "the payment does not say which link it came through")

  const { data: lead } = await sdb().from("marketing_leads").select("id, full_name, email, team_id, campaign_name, adset_name").eq("id", s.lead_id).maybeSingle()
  if (!lead) return park(feedId, "the lead of the sale was not found")
  const l = lead as { id: string; full_name: string | null; email: string | null; team_id: string | null; campaign_name: string | null; adset_name: string | null }
  if (!l.email) return park(feedId, "the lead has no email, so the invoice and the credit could never be found again")

  const paidAt = new Date(feed.transaction_date)
  const when = Number.isNaN(paidAt.getTime()) ? new Date() : paidAt

  // 2. The invoice + the credit (idempotent on the Stripe session).
  let invoice: { invoiceId: string; invoiceNumber: string; contactId: string; contactCreated: boolean }
  try {
    invoice = await recordPaidCall({
      payment: { chargeId: `stripe-session:${sessionId}`, amount: Number(feed.amount), currency: ref.currency as "EUR" | "USD", provider: "stripe", paymentIntentId: ref.paymentIntentId },
      inviteeEmail: l.email,
      inviteeName: l.full_name,
      callDate: when.toISOString().slice(0, 10),
      isTest: false,
      manual: { feedId: `stripe-session:${sessionId}`, sourceLabel: "Stripe payment (TD Marketing link)", creditUsedAtCreation: false },
    })
  } catch (e) {
    return { matched: false, error: `Could not create the invoice: ${e instanceof Error ? e.message : String(e)}` }
  }

  // 3. The sale is paid and the card moves — only now. A sale the webhook had already marked paid (before this rule) stays as it is.
  try {
    await recordPaidSession(db, { id: sessionId, payment_intent: ref.paymentIntentId, amount_total: ref.amountCents, currency: ref.currency.toLowerCase(), payment_status: "paid", metadata: { marketing_sale_id: s.id } }, when)
  } catch (e) {
    return { matched: false, error: `The invoice exists but the sale could not be marked paid: ${e instanceof Error ? e.message : String(e)} (will retry)` }
  }

  // 4. The Bank Feed row: matched to the invoice (the same audit link the matcher uses for a payment it can identify by Stripe's payment id).
  const note = `TD Marketing sale — ${l.full_name ?? "lead"}: matched to invoice ${invoice.invoiceNumber} and to the sale; the card moved to Paid.`
  const wrote = await updateFeed(feedId, {
    status: "matched", matched_payment_id: invoice.invoiceId, match_confidence: "retroactive", matched_at: new Date().toISOString(), matched_by: "auto",
    review_metadata: { ...auditLinkMetadata("payment_intent", note), marketing_sale: { sale_id: s.id, marketing_lead_id: l.id, matched_at: new Date().toISOString() } },
  }, "marketing-sale:matched")
  if (!wrote.ok) return { matched: false, error: `The sale was settled but the Bank Feed row could not be marked: ${wrote.error ?? "unknown"} (will retry)` }

  // 5. The invoice email, once.
  let email: "sent" | "skipped" | "failed" = "skipped"
  if (opts.sendEmail !== false) {
    const lockRow = {
      stripe_session_id: sessionId, resolution: "paid_call", contact_id: invoice.contactId, lead_id: null, invoice_payment_id: invoice.invoiceId,
      credit_payment_id: null, note: `Marketing sale ${s.id}: matched in Finance, invoice emailed to ${l.email}.`, resolved_by: "finance:marketing-match",
    }
    let { error: lockErr } = await sdb().from("incoming_payment_resolutions").insert(lockRow)
    if (lockErr?.code === "23505") {
      // A person already confirmed this session (the hand-recorded marketing sale): that row has no invoice yet — taking it over (only while it has none) is the lock.
      const { data: took } = await sdb().from("incoming_payment_resolutions").update({ invoice_payment_id: invoice.invoiceId, contact_id: invoice.contactId }).eq("stripe_session_id", sessionId).is("invoice_payment_id", null).select("stripe_session_id")
      if (took && took.length > 0) lockErr = null
    }
    if (!lockErr) {
      try {
        const { sendPaidReceipt } = await import("@/lib/invoice-auto-send")
        // A person we have just created has only the database's default language, which says nothing: only a record that existed before speaks for itself.
        const { data: contact } = invoice.contactCreated ? { data: null } : await sdb().from("contacts").select("language").eq("id", invoice.contactId).maybeSingle()
        await sendPaidReceipt(invoice.invoiceId, { language: receiptLanguage((contact as { language: string | null } | null)?.language, l) })
        email = "sent"
      } catch (e) {
        email = "failed"
        const msg = e instanceof Error ? e.message : String(e)
        await updateFeed(feedId, { review_metadata: { marketing_receipt_email: `FAILED: ${msg}` } }, "marketing-sale:email-failed")
        await reportSystemError({ source: "server", route: "lib/finance/marketing-sale-settle", message: `Invoice ${invoice.invoiceNumber} was created for ${l.email} but the email failed: ${msg}`, context: { feedId, saleId: s.id } }).catch(() => undefined)
      }
    } else if (lockErr.code !== "23505") {
      email = "failed"
      await reportSystemError({ source: "server", route: "lib/finance/marketing-sale-settle", message: `Could not lock the invoice email of ${invoice.invoiceNumber}: ${lockErr.message}`, context: { feedId, saleId: s.id } }).catch(() => undefined)
    }
  }
  return { matched: true, paymentId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber, email, note }
}

/**
 * A marketing sale a person recorded by hand afterwards (a payment through a hand-made Stripe link, no labels: "Recorded afterwards by …") has no invoice yet, and
 * its Stripe payment sits in the Bank Feed unmatched (or marked "ignored" by the older hand tag). Finance settles those too — the same invoice, credit, match and
 * email — by the payment's own Stripe id. Safe to run every few minutes: a settled one has an invoice and a matched row, so it is skipped.
 */
export async function settleHandRecordedSales(limit = 20): Promise<{ looked: number; matched: number; failed: number }> {
  const out = { looked: 0, matched: 0, failed: 0 }
  const { data: sales } = await sdb().from("marketing_sales").select("id, stripe_payment_intent").eq("status", "paid").like("note", "Recorded afterwards%").not("stripe_payment_intent", "is", null).order("paid_at", { ascending: true }).limit(limit)
  for (const sale of (sales ?? []) as Array<{ id: string; stripe_payment_intent: string }>) {
    const { data: feeds } = await sdb().from("td_bank_feeds").select("id, status").eq("source", "stripe").in("status", ["unmatched", "ignored"]).eq("raw_data->payment_intent->>id", sale.stripe_payment_intent).limit(2)
    if (!feeds || feeds.length !== 1) continue // none yet (not synced) or ambiguous: nothing to do / left for a person
    out.looked++
    try {
      const r = await settleMarketingSaleByHand({ feedId: feeds[0].id, saleId: sale.id })
      if (r.matched === true) out.matched++
      else out.failed++
    } catch (e) {
      out.failed++
      console.error("[marketing-sale-settle] hand-recorded sale could not be settled:", e instanceof Error ? e.message : String(e))
    }
  }
  return out
}
