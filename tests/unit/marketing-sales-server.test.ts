import { describe, it, expect, vi, beforeEach } from "vitest"
import { FakeDb } from "./helpers/fake-lead-db"
import type { Db } from "@/lib/marketing/meta-leads/ingest"

const SETTINGS: Record<string, unknown> = {
  sale_kinds: [{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }],
  allowed_currencies: ["USD", "EUR"],
  confirm_above_amount: null,
  sale_kind_stages: { strategic_call: "paid_call", upsell: "upsell_won" },
  seller_result_stages: { not_ready: "not_ready", closed: "closed", not_closed: "not_closed" },
  pipeline_stages: [{ key: "new" }, { key: "qualified" }, { key: "closed" }, { key: "paid_call" }, { key: "upsell_won" }],
}
let TERMS: unknown[] = []
vi.mock("@/lib/marketing/settings", () => ({
  getMarketingSetting: async (k: string) => SETTINGS[k],
  listCommissionTerms: async () => TERMS,
}))

import { applyTermsNow, createSaleLink, markPaidOut, recordDispute, recordPaidSession, recordRefund, saleMetadata } from "@/lib/marketing/sales-server"

const TEAM = "11111111-1111-1111-1111-111111111111"
const LEAD = "22222222-2222-2222-2222-222222222222"
const SALE = "33333333-3333-3333-3333-333333333333"
const ctx = { teamId: TEAM, userId: "u1", email: "rocco@x.com" }
const term = { id: "t1", team_id: TEAM, person_ref: "team", kind: "strategic_call", seller_pct: 80, td_pct: 20, basis: "amount_paid", payee_account_id: null, effective_from: "2026-10-01T00:00:00Z" }
const ok = async () => ({ success: true, sessionId: "cs_1", checkoutUrl: "https://checkout.stripe.test/cs_1", expiresAt: new Date("2026-10-22T10:00:00Z") })

let db: FakeDb
const asDb = () => db as unknown as Db
beforeEach(() => {
  db = new FakeDb()
  db.rows("marketing_leads").push({ id: LEAD, team_id: TEAM, full_name: "Mario Rossi", email: "m@x.com", status: "qualified" })
  TERMS = [term]
})
const paidSale = (o: Record<string, unknown> = {}) => ({ id: SALE, team_id: TEAM, lead_id: LEAD, kind: "strategic_call", amount_cents: 100000, currency: "EUR", status: "link_created", created_by: "r", created_by_user_id: "u1", seller_pct: 80, td_pct: 20, seller_cents: 80000, td_cents: 20000, stripe_session_id: "cs_1", stripe_payment_intent: null, refunded_cents: 0, paid_out_at: null, ...o })
const session = (o: Record<string, unknown> = {}) => ({ id: "cs_1", payment_intent: "pi_1", amount_total: 100000, currency: "eur", payment_status: "paid", metadata: saleMetadata({ saleId: SALE, leadId: LEAD, teamId: TEAM }), ...o })

describe("createSaleLink", () => {
  it("saves the sale with the split in force, then the link, and logs it on the lead", async () => {
    const r = await createSaleLink(asDb(), ctx, LEAD, { kind: "strategic_call", amount: "1000", currency: "EUR" }, ok)
    expect(r).toMatchObject({ ok: true, url: "https://checkout.stripe.test/cs_1" })
    const row = db.rows("marketing_sales")[0]
    expect(row).toMatchObject({ team_id: TEAM, lead_id: LEAD, amount_cents: 100000, currency: "EUR", status: "link_created", seller_cents: 80000, td_cents: 20000, stripe_session_id: "cs_1", created_by: "rocco@x.com" })
    expect(db.rows("marketing_lead_events")[0]).toMatchObject({ kind: "payment_link_created", lead_id: LEAD })
  })
  it("every link moves the lead to Link sent, with a line in the history; a lead that already paid stays Paid", async () => {
    await createSaleLink(asDb(), ctx, LEAD, { kind: "strategic_call", amount: "1000", currency: "EUR" }, ok)
    expect(db.rows("marketing_leads")[0].status).toBe("closed")
    expect(db.rows("marketing_lead_events").find(e => e.kind === "status_changed")).toMatchObject({ data: { from: "qualified", to: "closed", outcome: "link_sent" } })
    db.rows("marketing_leads")[0].status = "paid_call"
    await createSaleLink(asDb(), ctx, LEAD, { kind: "upsell", amount: "500", currency: "EUR" }, ok)
    expect(db.rows("marketing_leads")[0].status).toBe("paid_call")
    // past paying (booking link sent, upsell, waiting, archived): a new link, an upsell link for instance, never pulls the lead back to Link sent
    for (const later of ["booking_link", "upsell", "waiting", "archived"]) {
      db.rows("marketing_leads")[0].status = later
      await createSaleLink(asDb(), ctx, LEAD, { kind: "upsell", amount: "500", currency: "EUR" }, ok)
      expect(db.rows("marketing_leads")[0].status).toBe(later)
    }
  })
  it("another team's lead id finds nothing", async () => {
    const r = await createSaleLink(asDb(), { ...ctx, teamId: "99999999-9999-9999-9999-999999999999" }, LEAD, { kind: "strategic_call", amount: "10", currency: "EUR" }, ok)
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(db.rows("marketing_sales")).toHaveLength(0)
  })
  it("no terms: the sale is saved as terms not set", async () => {
    TERMS = []
    await createSaleLink(asDb(), ctx, LEAD, { kind: "upsell", amount: "500", currency: "USD" }, ok)
    expect(db.rows("marketing_sales")[0]).toMatchObject({ seller_cents: null, td_cents: null })
  })
  it("a Stripe failure leaves a failed row, never a live link", async () => {
    const r = await createSaleLink(asDb(), ctx, LEAD, { kind: "strategic_call", amount: "1000", currency: "EUR" }, async () => ({ success: false, error: "boom" }))
    expect(r).toMatchObject({ ok: false, status: 502 })
    expect(db.rows("marketing_sales")[0].status).toBe("failed")
    expect(db.rows("marketing_lead_events")).toHaveLength(0)
  })
  it("a thrown Stripe error is handled the same way", async () => {
    const r = await createSaleLink(asDb(), ctx, LEAD, { kind: "strategic_call", amount: "1000", currency: "EUR" }, async () => { throw new Error("network") })
    expect(r.ok).toBe(false)
    expect(db.rows("marketing_sales")[0].status).toBe("failed")
  })
  it("bad input never reaches the database", async () => {
    const r = await createSaleLink(asDb(), ctx, LEAD, { kind: "strategic_call", amount: "abc", currency: "EUR" }, ok)
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(db.rows("marketing_sales")).toHaveLength(0)
  })
  it("the Stripe metadata carries the tag that keeps client machinery out", () => {
    expect(saleMetadata({ saleId: SALE, leadId: LEAD, teamId: TEAM })).toMatchObject({ payment_kind: "marketing_sale", marketing_sale_id: SALE })
  })
})

describe("recordPaidSession", () => {
  it("records the payment, moves the lead, logs it; a redelivery changes nothing", async () => {
    db.rows("marketing_sales").push(paidSale())
    expect(await recordPaidSession(asDb(), session())).toEqual({ recorded: true })
    expect(db.rows("marketing_sales")[0]).toMatchObject({ status: "paid", stripe_payment_intent: "pi_1", paid_amount_cents: 100000 })
    expect(db.rows("marketing_leads")[0].status).toBe("paid_call")
    const kinds = db.rows("marketing_lead_events").map(e => e.kind)
    expect(kinds).toEqual(["payment_received", "status_changed"])
    expect(await recordPaidSession(asDb(), session())).toMatchObject({ recorded: false, reason: "already recorded" })
    expect(db.rows("marketing_lead_events")).toHaveLength(2)
  })
  it("never touches a sale with a different session id, or a missing sale", async () => {
    db.rows("marketing_sales").push(paidSale())
    expect(await recordPaidSession(asDb(), session({ id: "cs_other" }))).toMatchObject({ recorded: false })
    expect(db.rows("marketing_sales")[0].status).toBe("link_created")
    expect(await recordPaidSession(asDb(), session({ metadata: { payment_kind: "marketing_sale" } }))).toMatchObject({ recorded: false })
  })
  it("an upsell moves the lead to its own stage; a stage that does not exist is skipped without failing", async () => {
    db.rows("marketing_sales").push(paidSale({ kind: "upsell" }))
    await recordPaidSession(asDb(), session())
    expect(db.rows("marketing_leads")[0].status).toBe("upsell_won")
    db = new FakeDb(); db.rows("marketing_leads").push({ id: LEAD, team_id: TEAM, status: "qualified" }); db.rows("marketing_sales").push(paidSale())
    SETTINGS.sale_kind_stages = { strategic_call: "gone" }
    expect(await recordPaidSession(asDb(), session())).toEqual({ recorded: true })
    expect(db.rows("marketing_leads")[0].status).toBe("qualified")
    SETTINGS.sale_kind_stages = { strategic_call: "paid_call", upsell: "upsell_won" }
  })
  it("a paid lead's promised call back is cleared (it is no longer a 'late call back')", async () => {
    db.rows("marketing_leads")[0].callback_at = "2026-10-20T09:00:00Z"
    db.rows("marketing_sales").push(paidSale())
    await recordPaidSession(asDb(), session())
    expect(db.rows("marketing_leads")[0]).toMatchObject({ status: "paid_call", callback_at: null })
  })
  it("a lead that moved at the same moment gets one more try with the stage it is at now", async () => {
    db.rows("marketing_sales").push(paidSale())
    const real = db.from.bind(db)
    let reads = 0
    db.from = ((t: string) => { const q = real(t); if (t === "marketing_leads") { const sel = q.maybeSingle.bind(q); q.maybeSingle = (() => sel().then(r => { const seen = r.data ? { ...r.data } : r.data; if (reads++ === 0 && r.data) db.rows("marketing_leads")[0].status = "booked"; return { ...r, data: seen } })) as typeof q.maybeSingle } return q }) as typeof db.from
    await recordPaidSession(asDb(), session())
    expect(db.rows("marketing_leads")[0].status).toBe("paid_call")
    expect(db.rows("marketing_lead_events").map(e => e.kind)).not.toContain("stage_not_moved")
  })
  it("if the lead still cannot be moved, a line says so (never silent)", async () => {
    db.rows("marketing_sales").push(paidSale())
    const real = db.from.bind(db)
    db.from = ((t: string) => { const q = real(t); if (t === "marketing_leads") { const sel = q.maybeSingle.bind(q); q.maybeSingle = (() => sel().then(r => { const seen = r.data ? { ...r.data } : r.data; if (r.data) db.rows("marketing_leads")[0].status = db.rows("marketing_leads")[0].status === "booked" ? "showed" : "booked"; return { ...r, data: seen } })) as typeof q.maybeSingle } return q }) as typeof db.from
    await recordPaidSession(asDb(), session())
    expect(db.rows("marketing_sales")[0].status).toBe("paid")
    expect(db.rows("marketing_lead_events").map(e => e.kind)).toContain("stage_not_moved")
  })
  it("a lead already at the paid stage still has its leftover call back cleared", async () => {
    db.rows("marketing_leads")[0].status = "paid_call"
    db.rows("marketing_leads")[0].callback_at = "2026-10-20T09:00:00Z"
    db.rows("marketing_sales").push(paidSale())
    await recordPaidSession(asDb(), session())
    expect(db.rows("marketing_leads")[0].callback_at).toBeNull()
  })
  it("a payment link made while Antonio views as someone is tagged", async () => {
    await createSaleLink(asDb(), { ...ctx, viaViewAs: true }, LEAD, { kind: "strategic_call", amount: "1000", currency: "EUR" }, ok)
    expect(db.rows("marketing_lead_events").find(e => e.kind === "payment_link_created")?.data).toMatchObject({ via_view_as: true })
  })
  it("a database failure while recording is thrown, so Stripe retries the event", async () => {
    db.rows("marketing_sales").push(paidSale())
    const real = db.from.bind(db)
    db.from = ((t: string) => { const q = real(t); if (t === "marketing_sales") { const u = q.update.bind(q); q.update = ((p: Record<string, unknown>) => { if (p.status === "paid") db.failTables.add("marketing_sales"); return u(p) }) as typeof q.update } return q }) as typeof db.from
    await expect(recordPaidSession(asDb(), session())).rejects.toThrow(/could not record payment/)
  })
})

describe("recordRefund / recordDispute", () => {
  it("a full refund by payment id marks the sale refunded", async () => {
    db.rows("marketing_sales").push(paidSale({ status: "paid", stripe_payment_intent: "pi_1" }))
    expect(await recordRefund(asDb(), "pi_1", 100000)).toEqual({ recorded: true })
    expect(db.rows("marketing_sales")[0].status).toBe("refunded")
    expect(await recordRefund(asDb(), "pi_1", 100000)).toMatchObject({ recorded: false })
    expect(db.rows("marketing_lead_events").map(e => e.kind)).toEqual(["sale_refunded"])
  })
  it("a payment that is not a marketing sale is ignored", async () => {
    expect(await recordRefund(asDb(), "pi_unknown", 500)).toMatchObject({ recorded: false, reason: "not a marketing sale" })
    expect(await recordRefund(asDb(), null, 500)).toMatchObject({ recorded: false })
  })
  it("a dispute only adds a warning", async () => {
    db.rows("marketing_sales").push(paidSale({ status: "paid", stripe_payment_intent: "pi_1" }))
    await recordDispute(asDb(), "pi_1")
    expect(db.rows("marketing_sales")[0]).toMatchObject({ status: "paid" })
    expect(String(db.rows("marketing_sales")[0].needs_attention)).toMatch(/dispute/)
  })
})

describe("markPaidOut / applyTermsNow", () => {
  it("marks a paid, split sale as paid out once, with the reference", async () => {
    db.rows("marketing_sales").push(paidSale({ status: "paid" }))
    expect(await markPaidOut(asDb(), SALE, { reference: "WIRE-77", paidOn: "2026-10-22" }, "antonio")).toEqual({ ok: true })
    expect(db.rows("marketing_sales")[0]).toMatchObject({ paid_out_reference: "WIRE-77", paid_out_by: "antonio" })
    expect(await markPaidOut(asDb(), SALE, { reference: "WIRE-78", paidOn: "2026-10-22" }, "antonio")).toMatchObject({ ok: false, status: 409 })
  })
  it("refuses an empty reference, a bad date, an unpaid sale and a sale with no split", async () => {
    db.rows("marketing_sales").push(paidSale())
    expect(await markPaidOut(asDb(), SALE, { reference: " ", paidOn: "2026-10-22" }, "a")).toMatchObject({ ok: false, status: 400 })
    expect(await markPaidOut(asDb(), SALE, { reference: "x", paidOn: "nope" }, "a")).toMatchObject({ ok: false, status: 400 })
    expect(await markPaidOut(asDb(), SALE, { reference: "x", paidOn: "2026-10-22" }, "a")).toMatchObject({ ok: false, status: 409 })
    db.rows("marketing_sales")[0].status = "paid"; db.rows("marketing_sales")[0].seller_cents = null
    expect(await markPaidOut(asDb(), SALE, { reference: "x", paidOn: "2026-10-22" }, "a")).toMatchObject({ ok: false, status: 409 })
  })
  it("applies today's terms to a terms-not-set paid sale, once", async () => {
    db.rows("marketing_sales").push(paidSale({ status: "paid", seller_cents: null, td_cents: null, seller_pct: null, td_pct: null, paid_amount_cents: 100000 }))
    expect(await applyTermsNow(asDb(), SALE, "antonio", new Date("2026-10-30T00:00:00Z"))).toMatchObject({ ok: true, sellerCents: 80000, tdCents: 20000 })
    expect(db.rows("marketing_sales")[0]).toMatchObject({ seller_cents: 80000, term_id: "t1" })
    expect(await applyTermsNow(asDb(), SALE, "antonio")).toMatchObject({ ok: false, status: 409 })
  })
  it("with no terms set there is nothing to apply", async () => {
    TERMS = []
    db.rows("marketing_sales").push(paidSale({ status: "paid", seller_cents: null, td_cents: null }))
    expect(await applyTermsNow(asDb(), SALE, "antonio")).toMatchObject({ ok: false, status: 409 })
  })
})
