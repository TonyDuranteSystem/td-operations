/**
 * Finance settles a TD Marketing payment (SERVER-ONLY; TD Marketing, dev job 9aec66fa — Antonio, 2026-10-28: "what regulates everything is Finance. When the
 * payment is matched with the marketing sale and the lead, the card on Marketing moves, not before" … "create the invoice and send it to them", and the paid
 * call gives a credit like every strategic-call link made in the CRM).
 *
 * One Stripe payment row in the Bank Feed that carries Rocco's link labels is settled in this order, every step safe to run twice:
 *   1. the checks (still our money, the amount and the lead agree with the sale, not a test lead, not an old row) — anything doubtful is parked "needs review" for a person, never guessed;
 *   2. the paid Strategic Call invoice + the deductible credit (the same as a CRM link: `recordPaidCall`), filed under the Stripe session so a retry adds nothing;
 *   3. the sale becomes PAID and the lead's card moves (`recordPaidSession`, paid at the real payment time) — verified, not assumed;
 *   4. the Bank Feed row is marked MATCHED to the invoice — last, because it is what tells the sync "this one is done";
 *   5. the invoice is emailed to the lead: claimed once per Stripe session, marked sent/failed on that claim, and a failed or interrupted one is retried a few times
 *      (`retryMarketingReceipts`) and then reported — never lost silently, never sent twice while the first is still in flight.
 * The Stripe webhook no longer marks the sale paid by itself: only this does. A row that keeps failing is parked after a few tries so it can never block the newer ones.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import type { Db } from "@/lib/marketing/meta-leads/ingest"
import { recordPaidSession } from "@/lib/marketing/sales-server"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { isChargeRefundedNow } from "@/lib/stripe-sync"
import { updateFeed } from "@/lib/finance/feed-write"
import { auditLinkMetadata } from "@/lib/finance/feed-vocabulary"
import { checkSaleAgainstFeed, isTestLeadEmail, marketingRefFromFeed, receiptLanguage, type MarketingFeedRef, type SaleFacts } from "@/lib/finance/marketing-sale-ref"
import { extractStripePaymentIntent } from "@/lib/finance/feed-signals"
import { reportSystemError } from "@/lib/system-errors"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdb = () => supabaseAdmin as any

/** The only kind of marketing sale Finance invoices today (it is the only kind that exists): the paid Strategic Call. Another kind is parked until it has its own rule. */
export const INVOICED_SALE_KIND = "strategic_call"
/** Automatic settlement only touches payments from the last days (the sync's own look-back is 3): an older one is left in Finance for a person, so switching this on can never mass-settle history. */
export const LABELLED_MAX_AGE_DAYS = 4
/** A sale recorded by hand is looked for in the Bank Feed for this long after it was paid. */
export const HAND_RECORDED_MAX_AGE_DAYS = 14
/** After this many failed tries (not counting "Stripe could not be reached") a row is parked for a person with the reason, so it cannot hold up the others. */
export const MAX_SETTLE_TRIES = 4
const MAX_EMAIL_TRIES = 5

export type MarketingSettleResult =
  | { matched: true; paymentId: string; invoiceNumber?: string; alreadyMatched?: boolean; email?: "sent" | "skipped" | "failed"; note?: string }
  | { matched: false; notMarketing?: true; parked?: true; error?: string; note?: string }

const DAY = 86_400_000

async function park(feedId: string, reason: string): Promise<MarketingSettleResult> {
  await updateFeed(feedId, { status: "needs_review", review_metadata: { marketing_sale_problem: reason, checked_at: new Date().toISOString() } }, "marketing-sale:park")
  return { matched: false, parked: true, note: reason }
}

/** A step failed and will be tried again on the next run — but only a few times: after that the row is parked with the reason (and so is visible to Antonio, not stuck first in line forever). */
async function failTry(feedId: string, feed: Record<string, any>, error: string, opts: { count?: boolean } = {}): Promise<MarketingSettleResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (opts.count === false) return { matched: false, error }
  const tries = Number((feed.review_metadata as { marketing_settle_tries?: unknown } | null)?.marketing_settle_tries ?? 0) + 1
  if (tries >= MAX_SETTLE_TRIES) return park(feedId, `could not be settled after ${tries} tries: ${error}`)
  await updateFeed(feedId, { review_metadata: { marketing_settle_tries: tries, marketing_settle_last_error: error } }, "marketing-sale:try")
  return { matched: false, error }
}

export async function settleMarketingSaleFromFeed(feedId: string, opts: { sendEmail?: boolean; allowStatuses?: string[]; ignoreAge?: boolean } = {}): Promise<MarketingSettleResult> {
  const { data: feed, error: fErr } = await sdb().from("td_bank_feeds").select("*").eq("id", feedId).maybeSingle()
  if (fErr || !feed) return { matched: false, error: `Feed not found: ${fErr?.message ?? "no row"}` }
  if (feed.status === "matched" && feed.matched_payment_id) return { matched: true, paymentId: feed.matched_payment_id, alreadyMatched: true }
  if (!(opts.allowStatuses ?? ["unmatched"]).includes(feed.status)) return { matched: false, note: `the row is "${feed.status}": left as it is` }

  const ref = marketingRefFromFeed(feed)
  if (!ref) return { matched: false, notMarketing: true }
  const at = new Date(feed.transaction_date).getTime()
  if (!opts.ignoreAge && Number.isFinite(at) && Date.now() - at > LABELLED_MAX_AGE_DAYS * DAY) return { matched: false, note: `a payment older than ${LABELLED_MAX_AGE_DAYS} days is left in Finance for a person` }
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
  // Still our money? A refund after the sync would otherwise be booked as a sale. "defer" = Stripe could not be reached: try again next run (not counted as a failed try).
  const refund = feed.external_id ? await isChargeRefundedNow(String(feed.external_id)) : "unchecked"
  if (refund === "refunded") return park(feedId, "Stripe says this payment was refunded or disputed: no invoice, the sale stays unpaid")
  if (refund === "defer") return failTry(feedId, feed, "Could not verify the payment with Stripe (will retry on the next run).", { count: false })

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
  // a test lead must never mint a real invoice, a real credit or an email (the $1 "TEST Payment" lead of 21 Oct)
  if (isTestLeadEmail(l.email)) return park(feedId, `${l.email} is a test address: no invoice, no credit, no email`)

  const paidAt = new Date(feed.transaction_date)
  const when = Number.isNaN(paidAt.getTime()) ? new Date() : paidAt
  // the date on the invoice is the business day in New York, not the UTC day (a payment at 9pm ET is still that day)
  const callDate = when.toLocaleDateString("en-CA", { timeZone: "America/New_York" })

  // 2. The invoice + the credit (idempotent on the Stripe session).
  let invoice: { invoiceId: string; invoiceNumber: string; contactId: string; contactCreated: boolean }
  try {
    invoice = await recordPaidCall({
      payment: { chargeId: `stripe-session:${sessionId}`, amount: Number(feed.amount), currency: ref.currency as "EUR" | "USD", provider: "stripe", paymentIntentId: ref.paymentIntentId },
      inviteeEmail: l.email,
      inviteeName: l.full_name,
      callDate,
      isTest: false,
      manual: { feedId: `stripe-session:${sessionId}`, sourceLabel: "Stripe payment (TD Marketing link)", creditUsedAtCreation: false },
    })
  } catch (e) {
    return failTry(feedId, feed, `Could not create the invoice: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 3. The sale is paid and the card moves — only now. recordPaidSession answers "recorded: false" instead of failing for some reasons, so the sale is READ BACK: the row is
  //    only marked matched when the sale really is paid (a sale the webhook had already marked paid, before this rule, is fine as it is).
  try {
    await recordPaidSession(db, { id: sessionId, payment_intent: ref.paymentIntentId, amount_total: ref.amountCents, currency: ref.currency.toLowerCase(), payment_status: "paid", metadata: { marketing_sale_id: s.id } }, when)
  } catch (e) {
    return failTry(feedId, feed, `The invoice exists but the sale could not be marked paid: ${e instanceof Error ? e.message : String(e)}`)
  }
  const { data: after } = await sdb().from("marketing_sales").select("status").eq("id", s.id).maybeSingle()
  if (!after || !["paid", "partly_refunded", "refunded"].includes(String(after.status))) {
    return failTry(feedId, feed, `The invoice exists but the sale is still "${after?.status ?? "missing"}" (the payment's link does not match the sale's link)`)
  }

  // 4. The Bank Feed row: matched to the invoice (the same audit link the matcher uses for a payment it can identify by Stripe's payment id).
  const note = `TD Marketing sale — ${l.full_name ?? "lead"}: matched to invoice ${invoice.invoiceNumber} and to the sale; the card moved to Paid.`
  const wrote = await updateFeed(feedId, {
    status: "matched", matched_payment_id: invoice.invoiceId, match_confidence: "retroactive", matched_at: new Date().toISOString(), matched_by: "auto",
    review_metadata: { ...auditLinkMetadata("payment_intent", note), marketing_sale: { sale_id: s.id, marketing_lead_id: l.id, matched_at: new Date().toISOString() } },
  }, "marketing-sale:matched")
  if (!wrote.ok) return failTry(feedId, feed, `The sale was settled but the Bank Feed row could not be marked: ${wrote.error ?? "unknown"}`)

  // 5. The invoice email.
  const email = opts.sendEmail === false ? "skipped" : await emailOnce({ feedId, sessionId, saleId: s.id, invoice, lead: l })
  return { matched: true, paymentId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber, email, note }
}

// ───────────────────────── the invoice email: claimed once, marked, retried ─────────────────────────

const TOKEN_RE = /\s*\[email:[^\]]*\]/g
const withToken = (note: string | null | undefined, token: string) => `${(note ?? "").replace(TOKEN_RE, "").trim()} [email:${token}]`.trim().slice(0, 1000)

async function setEmailToken(sessionId: string, token: string) {
  const { data: row } = await sdb().from("incoming_payment_resolutions").select("note").eq("stripe_session_id", sessionId).maybeSingle()
  await sdb().from("incoming_payment_resolutions").update({ note: withToken(row?.note, token) }).eq("stripe_session_id", sessionId)
}

/** Send the paid-invoice email and say what really happened: sendPaidReceipt answers "sent" only when an email left. */
async function sendReceipt(invoiceId: string, lead: { campaign_name: string | null; adset_name: string | null }, contactId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { sendPaidReceipt } = await import("@/lib/invoice-auto-send")
    const { data: contact } = await sdb().from("contacts").select("language").eq("id", contactId).maybeSingle()
    const r = await sendPaidReceipt(invoiceId, { language: receiptLanguage((contact as { language: string | null } | null)?.language, lead) })
    return r === "sent" ? { ok: true } : { ok: false, error: r === "no_recipient" ? "the invoice has no email address to send to" : "the invoice has no number to send" }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function emailOnce(i: { feedId: string; sessionId: string; saleId: string; invoice: { invoiceId: string; invoiceNumber: string; contactId: string }; lead: { email: string | null; campaign_name: string | null; adset_name: string | null } }): Promise<"sent" | "skipped" | "failed"> {
  const claim = `Marketing sale ${i.saleId}: matched in Finance, invoice ${i.invoice.invoiceNumber} emailed to ${i.lead.email}.`
  let { error: lockErr } = await sdb().from("incoming_payment_resolutions").insert({
    stripe_session_id: i.sessionId, resolution: "paid_call", contact_id: i.invoice.contactId, lead_id: null, invoice_payment_id: i.invoice.invoiceId,
    credit_payment_id: null, note: withToken(claim, "pending"), resolved_by: "finance:marketing-match",
  })
  if (lockErr?.code === "23505") {
    // A person already confirmed this session (the hand-recorded marketing sale): that row has no invoice yet — taking it over (only while it has none) is the claim.
    const { data: row } = await sdb().from("incoming_payment_resolutions").select("note").eq("stripe_session_id", i.sessionId).maybeSingle()
    const { data: took } = await sdb().from("incoming_payment_resolutions").update({ invoice_payment_id: i.invoice.invoiceId, contact_id: i.invoice.contactId, note: withToken(row?.note, "pending") }).eq("stripe_session_id", i.sessionId).is("invoice_payment_id", null).select("stripe_session_id")
    if (took && took.length > 0) lockErr = null
    else return "skipped" // already claimed by another run: it sends it, or the retry below does
  }
  if (lockErr) {
    await reportSystemError({ source: "server", route: "lib/finance/marketing-sale-settle", message: `Could not claim the invoice email of ${i.invoice.invoiceNumber}: ${lockErr.message}`, context: { feedId: i.feedId, saleId: i.saleId } }).catch(() => undefined)
    return "failed"
  }
  const r = await sendReceipt(i.invoice.invoiceId, i.lead, i.invoice.contactId)
  if (r.ok === true) { await setEmailToken(i.sessionId, "sent"); return "sent" }
  await setEmailToken(i.sessionId, "failed:1")
  await updateFeed(i.feedId, { review_metadata: { marketing_receipt_email: `NOT SENT yet: ${r.ok === false ? r.error : ""} (will be retried)` } }, "marketing-sale:email-failed")
  return "failed"
}

/**
 * Invoice emails that failed, or were claimed but never finished (the function was cut off), are tried again a few times, then reported to system errors. A sent one is
 * never touched. Runs with the 3-minute cron.
 */
export async function retryMarketingReceipts(limit = 5): Promise<{ looked: number; sent: number; gaveUp: number }> {
  const out = { looked: 0, sent: 0, gaveUp: 0 }
  const since = new Date(Date.now() - 3 * DAY).toISOString()
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: rows } = await sdb().from("incoming_payment_resolutions").select("stripe_session_id, note, invoice_payment_id, contact_id, resolved_at")
    .not("invoice_payment_id", "is", null).gt("resolved_at", since).or(`note.ilike.%[email:failed:%,and(note.ilike.%[email:pending]%,resolved_at.lt.${tenMinAgo})`).order("resolved_at", { ascending: true }).limit(limit)
  for (const row of (rows ?? []) as Array<{ stripe_session_id: string; note: string | null; invoice_payment_id: string; contact_id: string | null }>) {
    const sale = /sale ([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(row.note ?? "")?.[1]
    if (!sale || !row.contact_id) continue
    out.looked++
    const failedBefore = Number(/\[email:failed:(\d+)\]/.exec(row.note ?? "")?.[1] ?? 0)
    const { data: s } = await sdb().from("marketing_sales").select("lead_id").eq("id", sale).maybeSingle()
    const { data: lead } = s ? await sdb().from("marketing_leads").select("campaign_name, adset_name").eq("id", s.lead_id).maybeSingle() : { data: null }
    const r = await sendReceipt(row.invoice_payment_id, (lead as { campaign_name: string | null; adset_name: string | null } | null) ?? { campaign_name: null, adset_name: null }, row.contact_id)
    if (r.ok === true) { await setEmailToken(row.stripe_session_id, "sent"); out.sent++; continue }
    const n = failedBefore + 1
    await setEmailToken(row.stripe_session_id, `failed:${n}`)
    if (n >= MAX_EMAIL_TRIES) {
      out.gaveUp++
      await setEmailToken(row.stripe_session_id, "gave-up")
      await reportSystemError({ source: "server", route: "lib/finance/marketing-sale-settle", message: `The invoice email for marketing sale ${sale} could not be sent after ${n} tries: ${r.ok === false ? r.error : ""}. Send the invoice by hand.`, context: { invoicePaymentId: row.invoice_payment_id } }).catch(() => undefined)
    }
  }
  return out
}

/**
 * A marketing sale a person recorded by hand afterwards (a payment through a hand-made Stripe link, no labels: "Recorded afterwards by …") has no invoice yet, and
 * its Stripe payment sits in the Bank Feed unmatched (or marked "ignored" by the older hand tag). Finance settles those too — the same invoice, credit, match and
 * email — by the payment's own Stripe id, for sales paid in the last two weeks (newest first, so an old settled one can never crowd out a new one).
 */
export async function settleHandRecordedSales(limit = 5): Promise<{ looked: number; matched: number; failed: number }> {
  const out = { looked: 0, matched: 0, failed: 0 }
  const since = new Date(Date.now() - HAND_RECORDED_MAX_AGE_DAYS * DAY).toISOString()
  const { data: sales } = await sdb().from("marketing_sales").select("id, stripe_payment_intent").eq("status", "paid").like("note", "Recorded afterwards%").not("stripe_payment_intent", "is", null).gt("paid_at", since).order("paid_at", { ascending: false }).limit(30)
  for (const sale of (sales ?? []) as Array<{ id: string; stripe_payment_intent: string }>) {
    if (out.looked >= limit) break
    const { data: feeds } = await sdb().from("td_bank_feeds").select("id, status").eq("source", "stripe").in("status", ["unmatched", "ignored"]).eq("raw_data->payment_intent->>id", sale.stripe_payment_intent).limit(2)
    if (!feeds || feeds.length !== 1) continue // none yet (not synced), already settled or ambiguous: nothing to do / left for a person
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

/**
 * The Stripe webhook no longer marks a marketing sale paid, so Finance is the only road: if a marketing payment was received more than 15 minutes ago and its sale is
 * still open, something is wrong (the sync is down, the payment never reached the Bank Feed, the row is stuck). It is reported to system errors, once per sale.
 */
export async function watchUnsettledMarketingPayments(): Promise<{ stuck: number }> {
  const from = new Date(Date.now() - 3 * DAY).toISOString()
  const to = new Date(Date.now() - 15 * 60_000).toISOString()
  const { data: events } = await sdb().from("webhook_events").select("external_id, payload").eq("source", "stripe").eq("event_type", "checkout.session.completed").gt("created_at", from).lt("created_at", to).eq("payload->metadata->>payment_kind", "marketing_sale").limit(50)
  let stuck = 0
  for (const ev of (events ?? []) as Array<{ external_id: string; payload: { metadata?: { marketing_sale_id?: string } } | null }>) {
    const saleId = ev.payload?.metadata?.marketing_sale_id
    if (!saleId) continue
    const { data: sale } = await sdb().from("marketing_sales").select("id, status").eq("id", saleId).maybeSingle()
    if (!sale || sale.status !== "link_created") continue
    stuck++
    await reportSystemError({ source: "server", route: "lib/finance/marketing-sale-settle", message: `A marketing payment was received more than 15 minutes ago but Finance has not matched it: sale ${saleId} is still open. Look in Finance → Bank Feed (Needs review / Unmatched).`, context: { saleId, session: ev.external_id } }).catch(() => undefined)
  }
  return { stuck }
}
