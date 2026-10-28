import { describe, expect, it } from "vitest"
import { checkSaleAgainstFeed, marketingRefFromFeed, receiptLanguage, type MarketingFeedRef, type SaleFacts } from "@/lib/finance/marketing-sale-ref"
import { buildInvoiceEmail } from "@/lib/email/invoice-email"
import vercel from "../../vercel.json"

const SALE = "109b5717-7b95-4d86-856e-ae3cbe229cab"
const LEAD = "baa2db18-02ff-43b4-b881-41206f0356fe"
const TEAM = "bc54d2f9-f62c-48de-b995-3a404123f8b8"

// the real shape of a Stripe feed row: raw_data is the charge, its payment_intent is expanded
const feed = (over: Record<string, unknown> = {}, meta: Record<string, string> | null = { source: "td-marketing", payment_kind: "marketing_sale", marketing_lead_id: LEAD, marketing_sale_id: SALE, marketing_team_id: TEAM }) => ({
  source: "stripe", amount: 397, currency: "EUR",
  raw_data: { id: "ch_1", metadata: {}, payment_intent: { id: "pi_3UVX", metadata: meta ?? {}, payment_details: { order_reference: "cs_live_abc" } } },
  ...over,
})

describe("Finance recognises a payment from one of Rocco's links", () => {
  it("reads the sale, the lead, the team, the payment and the link from the payment's own labels", () => {
    expect(marketingRefFromFeed(feed())).toEqual({ saleId: SALE, leadId: LEAD, teamId: TEAM, paymentIntentId: "pi_3UVX", sessionId: "cs_live_abc", amountCents: 39700, currency: "EUR" })
  })
  it("is not a marketing payment without the label, from another source, or with a sale id that is not an id", () => {
    expect(marketingRefFromFeed(feed({}, null))).toBeNull()
    expect(marketingRefFromFeed(feed({}, { payment_kind: "paid_call", marketing_sale_id: SALE }))).toBeNull()
    expect(marketingRefFromFeed(feed({ source: "relay" }))).toBeNull()
    expect(marketingRefFromFeed(feed({}, { payment_kind: "marketing_sale", marketing_sale_id: "not-an-id" }))).toBeNull()
    expect(marketingRefFromFeed(feed({ raw_data: null }))).toBeNull()
    expect(marketingRefFromFeed(feed({ amount: 0 }))).toBeNull()
  })
  it("never guesses from a name or an amount: a payment with the right amount but no label is left alone", () => {
    expect(marketingRefFromFeed({ source: "stripe", amount: 397, currency: "EUR", raw_data: { id: "ch_2", metadata: {}, payment_intent: { id: "pi_x", metadata: {} } } })).toBeNull()
  })
  it("still works when the payment is not expanded (labels on the charge, payment id as a string)", () => {
    const r = marketingRefFromFeed({ source: "stripe", amount: 397, currency: "eur", raw_data: { id: "ch_3", metadata: { payment_kind: "marketing_sale", marketing_sale_id: SALE }, payment_intent: "pi_77" } })
    expect(r).toMatchObject({ saleId: SALE, paymentIntentId: "pi_77", sessionId: null, currency: "EUR" })
  })
})

describe("the sale agrees with the money, or a person decides", () => {
  const ref = marketingRefFromFeed(feed()) as MarketingFeedRef
  const sale = (over: Partial<SaleFacts> = {}): SaleFacts => ({ id: SALE, lead_id: LEAD, status: "link_created", amount_cents: 39700, currency: "EUR", stripe_session_id: "cs_live_abc", ...over })
  it("accepts an open sale or one already marked paid, with the same lead, link, amount and currency", () => {
    expect(checkSaleAgainstFeed(sale(), ref)).toEqual({ ok: true })
    expect(checkSaleAgainstFeed(sale({ status: "paid" }), ref)).toEqual({ ok: true })
  })
  it("refuses a different amount, currency, lead or link, and a sale that is already refunded or failed", () => {
    for (const bad of [sale({ amount_cents: 49700 }), sale({ currency: "USD" }), sale({ lead_id: "00000000-0000-4000-8000-000000000000" }), sale({ stripe_session_id: "cs_live_other" }), sale({ status: "refunded" }), sale({ status: "failed" })]) {
      expect(checkSaleAgainstFeed(bad, ref).ok).toBe(false)
    }
  })
})

describe("the language of the invoice email", () => {
  it("follows the person's record when it says a language", () => {
    expect(receiptLanguage("Italian", {})).toBe("it")
    expect(receiptLanguage("it", { campaign_name: "x" })).toBe("it")
    expect(receiptLanguage("English", { campaign_name: "LLC ITA | Lead Form" })).toBe("en")
  })
  it("for a person with no language: Italian only when the ad itself is Italian", () => {
    expect(receiptLanguage(null, { campaign_name: "14.10.2026 | LLC ITA | Lead Form | CBO 35$" })).toBe("it")
    expect(receiptLanguage(null, { adset_name: "Lingua IT | Europa+AE+CA | 25-65" })).toBe("it")
    expect(receiptLanguage(null, { campaign_name: "LLC US | Lead Form" })).toBe("en")
    expect(receiptLanguage(undefined, {})).toBe("en")
  })
})

describe("the paid receipt email in Italian", () => {
  const base = { purpose: "receipt" as const, audience: "no_portal" as const, clientName: "Nicola Catacchio", invoiceNumber: "INV-002800", issueDate: "2026-10-28", total: 397, currencySymbol: "€", currency: "EUR" }
  it("is Italian when asked, and unchanged English otherwise", () => {
    const it = buildInvoiceEmail({ ...base, language: "it" })
    expect(it.subject).toBe("Pagamento ricevuto per la fattura INV-002800")
    expect(it.html).toContain("Gentile Nicola Catacchio")
    expect(it.html).toContain("Abbiamo ricevuto il tuo pagamento")
    expect(it.html).toContain("Importo pagato")
    expect(it.html).not.toContain("Dear ")
    const en = buildInvoiceEmail(base)
    expect(en.subject).toBe("Payment received for Invoice INV-002800")
    expect(en.html).toContain("Dear Nicola Catacchio")
    expect(en.html).toContain("Amount Paid")
  })
  it("never changes the other emails: an invoice or reminder asked in Italian stays English", () => {
    expect(buildInvoiceEmail({ ...base, purpose: "initial", language: "it", payToken: "t" }).subject).toBe("Invoice INV-002800 from Tony Durante LLC")
  })
})

describe("Finance pulls Stripe payments every 3 minutes", () => {
  const crons = (vercel as { crons: Array<{ path: string; schedule: string }> }).crons.filter(c => c.path.startsWith("/api/cron/stripe-sync"))
  it("is one cron, every 3 minutes, with a short look-back (the nightly 90-day run is by hand: ?days=90)", () => {
    expect(crons).toEqual([{ path: "/api/cron/stripe-sync?days=3", schedule: "*/3 * * * *" }])
  })
})
