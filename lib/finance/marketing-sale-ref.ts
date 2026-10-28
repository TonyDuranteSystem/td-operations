/**
 * Finance recognises a TD Marketing payment (pure; TD Marketing, dev job 9aec66fa — Antonio, 2026-10-28: "what regulates everything is Finance. When the
 * payment is matched, the card on Marketing moves, not before").
 *
 * Every payment link Rocco makes labels its Stripe payment (`payment_kind: marketing_sale` + the sale and the lead). The Stripe sync copies that payment
 * into the Bank Feed with its labels inside, so Finance can tie the money to the sale and the lead without guessing. Nothing here touches a database.
 */
import { PAYMENT_KIND_META_KEY, PAYMENT_KIND_MARKETING } from "@/lib/payments/payment-kind"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MarketingFeedRef {
  saleId: string
  leadId: string | null
  teamId: string | null
  paymentIntentId: string | null
  /** The Checkout Session that took the money (Stripe keeps it on the payment as its order reference); null when Stripe did not say. */
  sessionId: string | null
  amountCents: number
  /** Upper case, like the sale's own currency. */
  currency: string
}

type Meta = Record<string, unknown> | null | undefined
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/**
 * Read a Bank Feed row of Stripe money: is it a payment from one of Rocco's links, and which sale is it? null = not a marketing payment (or its labels are not
 * trustworthy: a sale id that is not an id). The labels come from the payment itself, never from a name or an amount.
 */
export function marketingRefFromFeed(feed: { source?: string | null; amount?: number | string | null; currency?: string | null; raw_data?: unknown }): MarketingFeedRef | null {
  if (feed.source !== "stripe") return null
  const raw = feed.raw_data
  if (!raw || typeof raw !== "object") return null
  const charge = raw as { metadata?: Meta; payment_intent?: unknown }
  const pi = charge.payment_intent && typeof charge.payment_intent === "object" ? (charge.payment_intent as { id?: unknown; metadata?: Meta; payment_details?: { order_reference?: unknown } | null }) : null
  // Stripe puts the labels on the payment; the charge's own copy is empty for Checkout payments, so read both.
  const meta: Meta = { ...(charge.metadata ?? {}), ...(pi?.metadata ?? {}) }
  if (str(meta?.[PAYMENT_KIND_META_KEY]) !== PAYMENT_KIND_MARKETING) return null
  const saleId = str(meta?.marketing_sale_id)
  if (!saleId || !UUID_RE.test(saleId)) return null
  const leadId = str(meta?.marketing_lead_id)
  const teamId = str(meta?.marketing_team_id)
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : str(pi?.id)
  const order = str(pi?.payment_details?.order_reference)
  const amount = Number(feed.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return {
    saleId,
    leadId: leadId && UUID_RE.test(leadId) ? leadId : null,
    teamId: teamId && UUID_RE.test(teamId) ? teamId : null,
    paymentIntentId: piId && piId.startsWith("pi_") ? piId : null,
    sessionId: order && order.startsWith("cs_") ? order : null,
    amountCents: Math.round(amount * 100),
    currency: String(feed.currency ?? "").toUpperCase(),
  }
}

export interface SaleFacts { id: string; lead_id: string; status: string; amount_cents: number; currency: string; stripe_session_id: string | null }

/** Does the money match what the link was for? Anything else is parked for a person: Finance never marks a sale paid on a guess. */
export function checkSaleAgainstFeed(sale: SaleFacts, ref: MarketingFeedRef): { ok: true } | { ok: false; reason: string } {
  if (sale.id !== ref.saleId) return { ok: false, reason: "the payment names a different sale" }
  if (ref.leadId && ref.leadId !== sale.lead_id) return { ok: false, reason: "the payment names a different lead than the sale" }
  if (sale.status === "refunded" || sale.status === "partly_refunded" || sale.status === "failed") return { ok: false, reason: `the sale is already ${sale.status.replace("_", " ")}` }
  if (ref.sessionId && sale.stripe_session_id && ref.sessionId !== sale.stripe_session_id) return { ok: false, reason: "the payment came through a different link than this sale's" }
  if (sale.amount_cents !== ref.amountCents) return { ok: false, reason: `the money (${(ref.amountCents / 100).toFixed(2)}) is not the amount of the link (${(sale.amount_cents / 100).toFixed(2)})` }
  if (sale.currency.toUpperCase() !== ref.currency) return { ok: false, reason: `the money is in ${ref.currency} but the link was in ${sale.currency.toUpperCase()}` }
  return { ok: true }
}

/**
 * The language of the invoice email: what the person's record says; for a brand-new person, Italian when the lead came from an Italian ad (the campaign or the
 * ad set says so in its own name), else English. Never a guess from the name.
 */
export function receiptLanguage(contactLanguage: string | null | undefined, lead: { campaign_name?: string | null; adset_name?: string | null }): "it" | "en" {
  const l = (contactLanguage ?? "").trim().toLowerCase()
  if (l.startsWith("it")) return "it"
  if (l.startsWith("en")) return "en"
  return /\bITA\b|Lingua\s*IT/i.test(`${lead.campaign_name ?? ""} ${lead.adset_name ?? ""}`) ? "it" : "en"
}
