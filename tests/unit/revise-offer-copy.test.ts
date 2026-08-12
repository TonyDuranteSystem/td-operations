import { describe, it, expect } from "vitest"
import { buildRevisedOfferInsert } from "@/lib/offers/revise-copy"

const seed = {
  finalToken: "client-2026-v2",
  newVersion: 2,
  offerDate: "2026-08-05",
  bankDetails: { beneficiary: "Tony Durante LLC" },
}

function fullOriginal(): Record<string, unknown> {
  return {
    token: "client-2026",
    client_name: "Client X",
    client_email: "x@example.com",
    language: "en",
    status: "viewed",
    payment_type: "bank_transfer",
    contract_type: "formation",
    services: [{ name: "Company Formation", price: "$1,500" }],
    cost_summary: [{ label: "Setup Fee", total: "$1,500" }],
    recurring_costs: [],
    bundled_pipelines: ["Company Formation"],
    bank_details: { beneficiary: "OLD" },
    lead_id: "lead-1",
    account_id: null,
    required_documents: null,
    issues: null,
    admin_notes: "note",
    currency: "USD",
    referrer_name: "Ref",
    referrer_type: "client",
    contact_id: "contact-1",
    entity_type: "Multi Member LLC",
    formation_state: "WY",
    card_fee_rate: 0,
    referrer_contact_id: "ref-contact-1",
    // fields that must NOT carry:
    selected_services: ["Company Formation"],
    payment_links: [{ url: "https://stripe/old" }],
    expires_at: "2026-09-01",
    view_count: 7,
    viewed_at: "2026-08-01",
    access_code: "old-code",
    version: 1,
    superseded_by: null,
    partner_id: "partner-1",
    referrer_commission_pct: 10,
  }
}

describe("buildRevisedOfferInsert — WS-B copy-list triage (dev job c0a61e44)", () => {
  it("carries the five triaged deal facts to v2 — the silent-drop regression test", () => {
    const out = buildRevisedOfferInsert(fullOriginal(), seed)
    expect(out.contact_id).toBe("contact-1")
    expect(out.entity_type).toBe("Multi Member LLC")
    expect(out.formation_state).toBe("WY")
    // card_fee_rate 0 is a REAL pinned value (a waived deal) — must survive, not be nulled
    expect(out.card_fee_rate).toBe(0)
    expect(out.referrer_contact_id).toBe("ref-contact-1")
  })

  it("normalizes a legacy/invalid stored formation_state instead of propagating it", () => {
    const orig = { ...fullOriginal(), formation_state: "TX" }
    expect(buildRevisedOfferInsert(orig, seed).formation_state).toBe(null)
    const orig2 = { ...fullOriginal(), formation_state: "wyoming" }
    expect(buildRevisedOfferInsert(orig2, seed).formation_state).toBe("WY")
  })

  it("a pre-WS-B original (no state, no pinned fields) revises without crash — nulls, not defaults", () => {
    const orig = fullOriginal()
    delete orig.formation_state
    delete orig.card_fee_rate
    delete orig.referrer_contact_id
    delete orig.contact_id
    const out = buildRevisedOfferInsert(orig, seed)
    expect(out.formation_state).toBe(null)
    expect(out.card_fee_rate).toBe(null)
    expect(out.referrer_contact_id).toBe(null)
    expect(out.contact_id).toBe(null)
    expect(out.version).toBe(2)
    expect(out.status).toBe("draft")
  })

  it("deliberate drops stay dropped: client selections, payment links, expiry, counters, identity, partner economics", () => {
    const out = buildRevisedOfferInsert(fullOriginal(), seed)
    expect(out).not.toHaveProperty("selected_services")
    expect(out).not.toHaveProperty("payment_links")
    expect(out).not.toHaveProperty("expires_at")
    expect(out).not.toHaveProperty("viewed_at")
    expect(out).not.toHaveProperty("access_code")
    expect(out).not.toHaveProperty("superseded_by")
    expect(out).not.toHaveProperty("partner_id")
    expect(out).not.toHaveProperty("referrer_commission_pct")
    expect(out.view_count).toBe(0)
  })

  it("new identity comes from the seed: token, version, fresh offer date, resolved bank details", () => {
    const out = buildRevisedOfferInsert(fullOriginal(), seed)
    expect(out.token).toBe("client-2026-v2")
    expect(out.version).toBe(2)
    expect(out.offer_date).toBe("2026-08-05")
    expect(out.bank_details).toEqual({ beneficiary: "Tony Durante LLC" })
  })
})

describe("WS-A: credit display scalars carry to v2", () => {
  it("a revised offer keeps showing the client's already-paid credit", () => {
    const orig = { ...fullOriginal(), credit_amount: 257, credit_payment_id: "cn-1", credit_kind: "paid_call" }
    const out = buildRevisedOfferInsert(orig, seed)
    expect(out.credit_amount).toBe(257)
    expect(out.credit_payment_id).toBe("cn-1")
    // without this the wording silently degrades from "Already paid — Strategy
    // Call" to the neutral "Credit applied" on the revised version
    expect(out.credit_kind).toBe("paid_call")
  })
  it("an offer with no credit revises to nulls, not undefined", () => {
    const out = buildRevisedOfferInsert(fullOriginal(), seed)
    expect(out.credit_amount).toBe(null)
    expect(out.credit_payment_id).toBe(null)
    expect(out.credit_kind).toBe(null)
  })
})

describe("WS-C: the payment plan survives a revision, triggers and all", () => {
  /** Domenico's agreement: EUR1,250 on signing, EUR1,250 when his bank account opens. */
  const plan = [
    { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" }, internal_label: "on signing" },
    { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "event", event: "bank_account_opened" } },
  ]

  it("carries the plan to v2 — dropping it would turn a two-part deal back into one bill", () => {
    const out = buildRevisedOfferInsert({ ...fullOriginal(), payment_plan: plan }, seed)
    expect(out.payment_plan).toEqual(plan)
  })

  it("⛔ THE TRIGGER SURVIVES — a flattened plan loses the answer to 'when is part two due?'", () => {
    // The real regression risk is not losing the column, it is keeping the AMOUNTS while the
    // trigger degrades to a bare number or a stringified blob. Then the schedule has nothing to
    // show the client and the mint action has nothing to wait for, while the totals still look
    // right — the same shape of silent damage the pinned card-fee rate suffered.
    const out = buildRevisedOfferInsert({ ...fullOriginal(), payment_plan: plan }, seed)
    const copied = out.payment_plan as typeof plan
    expect(copied[0].trigger).toEqual({ kind: "signing" })
    expect(copied[1].trigger).toEqual({ kind: "event", event: "bank_account_opened" })
    expect(copied[1].trigger.event).toBe("bank_account_opened")
    expect(typeof copied[1].trigger).toBe("object")
    // and the staff-only label is not promoted or lost silently
    expect(copied[0].internal_label).toBe("on signing")
  })

  it("an ordinary single-payment offer revises to null, not undefined", () => {
    const out = buildRevisedOfferInsert(fullOriginal(), seed)
    expect(out.payment_plan).toBe(null)
    // null is what the column means by "one invoice for the whole fee" — undefined would be
    // omitted from the insert and read the same, but only by accident.
    expect("payment_plan" in out).toBe(true)
  })
})
