import { describe, it, expect } from "vitest"
import type { CommissionTerm } from "@/lib/marketing/commission"
import {
  applyTermToSale, canPayOut, formatMoney, isReceived, parseAmountToCents, planLink, planPaid, planRefund, saleStatusLabel, snapshotForSale, stageForPaidSale, totalsByCurrency, payoutTotals, sellerPaidInOtherCurrency,
  type SaleRow,
} from "@/lib/marketing/sales"

const term = (o: Partial<CommissionTerm> = {}): CommissionTerm => ({
  id: "t1", team_id: "team", person_ref: "team", kind: "strategic_call", seller_pct: 80, td_pct: 20, basis: "amount_paid", payee_account_id: "acc", effective_from: "2026-10-01T00:00:00Z", ...o,
})
const sale = (o: Partial<SaleRow> = {}): SaleRow => ({
  id: "s1", team_id: "team", lead_id: "l1", kind: "strategic_call", amount_cents: 100000, currency: "EUR", note: null, status: "link_created", created_by: "r@x", created_by_user_id: "u1",
  term_id: "t1", seller_pct: 80, td_pct: 20, term_basis: "amount_paid", payee_account_id: "acc", seller_cents: 80000, td_cents: 20000,
  stripe_session_id: "cs_1", stripe_payment_intent: null, checkout_url: "https://x", link_expires_at: null, paid_at: null, paid_amount_cents: null, refunded_at: null, refunded_cents: 0,
  needs_attention: null, paid_out_at: null, paid_out_reference: null, paid_out_by: null, created_at: "2026-10-21T10:00:00Z", ...o,
})
const settings = { kinds: [{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }], currencies: ["USD", "EUR"], confirmAbove: null as number | null }

describe("parseAmountToCents", () => {
  it("reads plain amounts, never through a float", () => {
    expect(parseAmountToCents("1500")).toBe(150000)
    expect(parseAmountToCents("1,500.50")).toBe(150050)
    expect(parseAmountToCents("0.10")).toBe(10)
    expect(parseAmountToCents(19.99)).toBe(1999)
    expect(parseAmountToCents("1.005")).toBeNull()
  })
  it("refuses zero, negative, empty, letters and absurd sizes", () => {
    for (const bad of ["0", "-5", "", "abc", "12e3", "1234567890", " "]) expect(parseAmountToCents(bad)).toBeNull()
  })
})

describe("snapshotForSale (the split saved with the sale)", () => {
  const q = { teamId: "team", kind: "strategic_call", personRef: "u1", amountCents: 100001, at: new Date("2026-10-21T00:00:00Z") }
  it("copies the term in force; the odd cent stays with TD", () => {
    const s = snapshotForSale([term()], q)
    expect(s).toMatchObject({ term_id: "t1", seller_pct: 80, td_pct: 20, seller_cents: 80000, td_cents: 20001, payee_account_id: "acc" })
    expect((s.seller_cents ?? 0) + (s.td_cents ?? 0)).toBe(100001)
  })
  it("no term = terms not set, every figure empty", () => {
    expect(snapshotForSale([], q)).toEqual({ term_id: null, seller_pct: null, td_pct: null, term_basis: null, payee_account_id: null, seller_cents: null, td_cents: null })
    expect(snapshotForSale([term()], { ...q, kind: "upsell" }).seller_cents).toBeNull()
  })
  it("a term that starts later is not in force yet", () => {
    expect(snapshotForSale([term({ effective_from: "2026-12-01T00:00:00Z" })], q).seller_cents).toBeNull()
  })
  it("a net-of-fees term keeps the percentages but computes no amounts", () => {
    const s = snapshotForSale([term({ basis: "net_of_fees" })], q)
    expect(s.seller_pct).toBe(80)
    expect(s.seller_cents).toBeNull()
  })
})

describe("planLink", () => {
  it("accepts a good request, any amount", () => {
    expect(planLink({ kind: "upsell", amount: "25000", currency: "usd" }, settings)).toEqual({ ok: true, amountCents: 2500000, currency: "USD", kind: "upsell", note: null })
  })
  it("refuses an unknown kind, an unlisted currency, a bad amount", () => {
    expect(planLink({ kind: "x", amount: "10", currency: "USD" }, settings).ok).toBe(false)
    expect(planLink({ kind: "upsell", amount: "10", currency: "GBP" }, settings).ok).toBe(false)
    expect(planLink({ kind: "upsell", amount: "ten", currency: "USD" }, settings).ok).toBe(false)
  })
  it("above the confirm amount it asks once, then lets it through", () => {
    const s = { ...settings, confirmAbove: 5000 }
    expect(planLink({ kind: "upsell", amount: "6000", currency: "USD" }, s)).toMatchObject({ ok: false, needsConfirm: true })
    expect(planLink({ kind: "upsell", amount: "6000", currency: "USD", confirmed: true }, s).ok).toBe(true)
    expect(planLink({ kind: "upsell", amount: "5000", currency: "USD" }, s).ok).toBe(true)
  })
})

describe("planPaid", () => {
  const f = { sessionId: "cs_1", paymentIntent: "pi_1", amountCents: 100000, currency: "eur", paymentStatus: "paid", at: new Date("2026-10-21T11:00:00Z") }
  it("records a paid link", () => {
    const p = planPaid(sale(), f)
    expect(p).toMatchObject({ action: "record", patch: { status: "paid", stripe_payment_intent: "pi_1", paid_amount_cents: 100000 } })
    expect((p as { patch: Record<string, unknown> }).patch.needs_attention).toBeUndefined()
  })
  it("is idempotent: a second delivery changes nothing", () => {
    for (const status of ["paid", "refunded", "partly_refunded"] as const) expect(planPaid(sale({ status }), f).action).toBe("ignore")
  })
  it("never records a different session, or an unpaid one", () => {
    expect(planPaid(sale(), { ...f, sessionId: "cs_other" }).action).toBe("ignore")
    expect(planPaid(sale(), { ...f, paymentStatus: "unpaid" }).action).toBe("ignore")
  })
  it("an amount or currency that differs is flagged for Antonio, not silently accepted", () => {
    const p = planPaid(sale(), { ...f, amountCents: 90000 }) as { patch: Record<string, unknown> }
    expect(String(p.patch.needs_attention)).toMatch(/Check before paying out/)
    expect((planPaid(sale(), { ...f, currency: "usd" }) as { patch: Record<string, unknown> }).patch.needs_attention).toBeTruthy()
  })
})

describe("planRefund", () => {
  const at = new Date("2026-10-22T00:00:00Z")
  it("a full refund removes the sale from the money", () => {
    const p = planRefund(sale({ status: "paid" }), 100000, at) as { patch: Record<string, unknown> }
    expect(p.patch.status).toBe("refunded")
    expect(isReceived({ status: "refunded" })).toBe(false)
  })
  it("a partial refund is flagged and the split is left alone", () => {
    const p = planRefund(sale({ status: "paid" }), 30000, at) as { patch: Record<string, unknown> }
    expect(p.patch.status).toBe("partly_refunded")
    expect(String(p.patch.needs_attention)).toMatch(/Partly refunded/)
    expect(p.patch.seller_cents).toBeUndefined()
  })
  it("a refund after payout is flagged: nothing is taken back automatically", () => {
    const p = planRefund(sale({ status: "paid", paid_out_at: "2026-10-23T00:00:00Z" }), 100000, at) as { patch: Record<string, unknown> }
    expect(String(p.patch.needs_attention)).toMatch(/already paid out/)
  })
  it("ignores repeats, smaller amounts, and sales that were never paid", () => {
    expect(planRefund(sale({ status: "partly_refunded", refunded_cents: 30000 }), 30000, at).action).toBe("ignore")
    expect(planRefund(sale({ status: "link_created" }), 100000, at).action).toBe("ignore")
    expect(planRefund(sale({ status: "paid" }), 0, at).action).toBe("ignore")
  })
})

describe("totalsByCurrency", () => {
  const paid = (o: Partial<SaleRow>) => sale({ status: "paid", paid_amount_cents: o.amount_cents ?? 100000, ...o })
  it("never mixes currencies; splits received / owed / paid out", () => {
    const t = totalsByCurrency([
      paid({ id: "a" }), paid({ id: "b", paid_out_at: "2026-10-25T00:00:00Z" }),
      paid({ id: "c", currency: "USD", amount_cents: 50000, seller_cents: 40000, td_cents: 10000 }),
    ])
    expect(t.find(x => x.currency === "EUR")).toMatchObject({ receivedCents: 200000, sellerCents: 160000, tdCents: 40000, owedToSellerCents: 80000, paidOutCents: 80000 })
    expect(t.find(x => x.currency === "USD")).toMatchObject({ receivedCents: 50000, sellerCents: 40000 })
  })
  it("terms-not-set sales count as received but carry no share; refunded and open links are not money", () => {
    const t = totalsByCurrency([paid({ seller_cents: null, td_cents: null }), sale({ status: "refunded" }), sale({ status: "link_created" })])[0]
    expect(t).toMatchObject({ receivedCents: 100000, sellerCents: 0, unsetCount: 1, openLinks: 1, refundedCount: 1 })
  })
  it("an expired link is not an open link", () => {
    const t = totalsByCurrency([sale({ link_expires_at: "2026-10-22T00:00:00Z" }), sale({ id: "b", link_expires_at: "2026-10-24T00:00:00Z" })], new Date("2026-10-23T00:00:00Z"))[0]
    expect(t.openLinks).toBe(1)
  })
  it("a partly refunded sale still counts (nothing is clawed back automatically)", () => {
    expect(totalsByCurrency([paid({ status: "partly_refunded" })])[0].receivedCents).toBe(100000)
  })
})

describe("small helpers", () => {
  it("stageForPaidSale only returns a stage that exists", () => {
    const stages = [{ key: "paid_call" }, { key: "upsell_won" }]
    expect(stageForPaidSale("upsell", { upsell: "upsell_won" }, stages)).toBe("upsell_won")
    expect(stageForPaidSale("upsell", { upsell: "gone" }, stages)).toBeNull()
    expect(stageForPaidSale("other", {}, stages)).toBeNull()
  })
  it("canPayOut: only a paid, split, not-yet-paid sale", () => {
    expect(canPayOut(sale({ status: "paid" }))).toBe(true)
    expect(canPayOut(sale({ status: "paid", seller_cents: null }))).toBe(false)
    expect(canPayOut(sale({ status: "paid", paid_out_at: "x" }))).toBe(false)
    expect(canPayOut(sale({ status: "refunded" }))).toBe(false)
    expect(canPayOut(sale({ status: "link_created" }))).toBe(false)
  })
  it("status words", () => {
    expect(saleStatusLabel(sale())).toBe("Link sent")
    expect(saleStatusLabel(sale({ status: "paid", seller_cents: null }))).toBe("Paid · terms not set")
    expect(saleStatusLabel(sale({ status: "paid", paid_out_at: "x" }))).toBe("Paid · paid out")
    expect(saleStatusLabel(sale({ status: "refunded" }))).toBe("Refunded")
  })
  it("formatMoney shows a currency and a dash for nothing", () => {
    expect(formatMoney(150050, "EUR")).toContain("1,500.50")
    expect(formatMoney(null, "EUR")).toBe("—")
  })
  it("applyTermToSale uses the terms in force at the moment given, computed on what was paid", () => {
    const s = applyTermToSale({ amount_cents: 1000, paid_amount_cents: 1000, kind: "upsell" }, [term({ kind: "upsell", seller_pct: 70, td_pct: 30 })], "team", "u1", new Date("2026-10-30T00:00:00Z"))
    expect(s).toMatchObject({ seller_cents: 700, td_cents: 300 })
    expect(applyTermToSale({ amount_cents: 1000, paid_amount_cents: 1000, kind: "upsell" }, [], "team", "u1", new Date())).toBeNull()
  })
})

describe("the seller's company paid in dollars (same number, no exchange rate)", () => {
  const paid = (o: Partial<SaleRow> = {}) => sale({ status: "paid", paid_at: "2026-10-22T10:00:00Z", paid_amount_cents: 39700, amount_cents: 39700, seller_cents: 31760, td_cents: 7940, ...o })
  it("with no payout currency nothing changes", () => {
    const t = totalsByCurrency([paid()], new Date("2026-10-23T00:00:00Z"))
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ currency: "EUR", receivedCents: 39700, tdCents: 7940, sellerCents: 31760, owedToSellerCents: 31760 })
    expect(payoutTotals([paid()], "")).toBeNull()
    expect(payoutTotals([paid()], null)).toBeNull()
  })
  it("with USD the euro card keeps Received and TD share, and the seller's share moves to a dollar total with the same number", () => {
    const sales = [paid(), paid({ id: "s2", paid_out_at: "2026-10-23T10:00:00Z", seller_cents: 1000, td_cents: 250 })]
    const [eur] = totalsByCurrency(sales, new Date("2026-10-23T00:00:00Z"), "USD")
    expect(eur).toMatchObject({ currency: "EUR", receivedCents: 79400, tdCents: 8190, sellerCents: 0, owedToSellerCents: 0, paidOutCents: 0 })
    expect(payoutTotals(sales, "USD")).toEqual({ currency: "USD", sellerCents: 32760, owedCents: 31760, paidOutCents: 1000 })
  })
  it("a sale already in the payout currency stays in its own card", () => {
    const usd = paid({ currency: "USD" })
    expect(sellerPaidInOtherCurrency("USD", "USD")).toBe(false)
    expect(sellerPaidInOtherCurrency("EUR", "USD")).toBe(true)
    expect(sellerPaidInOtherCurrency("EUR", "")).toBe(false)
    expect(totalsByCurrency([usd], new Date(), "USD")[0].sellerCents).toBe(31760)
    expect(payoutTotals([usd], "USD")).toBeNull()
  })
  it("refunded, unpaid-link and unsplit sales never reach the dollar total", () => {
    const sales = [paid({ id: "a", status: "refunded" }), sale({ id: "b" }), paid({ id: "c", seller_cents: null, td_cents: null })]
    expect(payoutTotals(sales, "USD")).toBeNull()
  })
})
