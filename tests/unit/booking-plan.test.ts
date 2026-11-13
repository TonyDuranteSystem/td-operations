import { describe, it, expect } from "vitest"
import { decideLinkPlan, parseMinutes, recorderFor, payModeFor, type LinkPlanInput, type LinkPlanResult } from "@/lib/booking/plan"
import type { KindRule } from "@/lib/booking/kinds"

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false },
}
const kind = (slug: keyof typeof META) => ({ slug, label: slug[0].toUpperCase() + slug.slice(1), metadata: META[slug] })
const base = (over: Partial<LinkPlanInput> = {}): LinkPlanInput => ({ person: { state: "new" }, kind: kind("lead"), minutes: 30, ...over })
const plan = (over: Partial<LinkPlanInput> = {}) => decideLinkPlan(base(over))
const errorsOf = (r: LinkPlanResult): string[] => ("errors" in r ? r.errors : [])
const okPlan = (over: Partial<LinkPlanInput> = {}) => {
  const r = plan(over)
  if (!r.ok) throw new Error(errorsOf(r).join(" | "))
  return r.plan
}

describe("parseMinutes", () => {
  it("accepts whole minutes 1-720, as a number or digits", () => {
    expect(parseMinutes(30)).toBe(30)
    expect(parseMinutes("45")).toBe(45)
    expect(parseMinutes(" 720 ")).toBe(720)
    expect(parseMinutes(1)).toBe(1)
  })
  it("refuses decimals, units, zero, too long, text, empty", () => {
    for (const bad of [45.5, "45.5", "45 min", 0, "0", 721, "1000", "", "abc", null, undefined, NaN, -5, "-5", "٣٠"]) expect(parseMinutes(bad)).toBeNull()
  })
})

describe("length: 30 = standard reusable link, any other = one-time", () => {
  it("30 minutes, free = reusable", () => {
    expect(okPlan({ minutes: 30 }).once).toBe(false)
    expect(okPlan({ minutes: "30" }).once).toBe(false)
  })
  it("45 minutes = one-time", () => {
    expect(okPlan({ minutes: 45 }).once).toBe(true)
  })
  it("a paid link is always one-time, even at 30 minutes", () => {
    expect(okPlan({ minutes: 30, kind: kind("client"), person: { state: "contact", established: true }, payment: { amount: "100", currency: "USD" } }).once).toBe(true)
  })
  it("a bad length is refused with a plain sentence", () => {
    const r = plan({ minutes: "45.5" })
    expect(r.ok).toBe(false)
    expect(errorsOf(r)[0]).toMatch(/whole number of minutes/)
  })
})

describe("what happens to the person's booking (recorder)", () => {
  const rules = Object.fromEntries(Object.entries(META).map(([k, v]) => [k, v as KindRule]))
  it("Client: a contact is attached, a new person becomes a lead, a lead is updated as today", () => {
    expect(recorderFor(rules.client, "contact")).toBe("attach")
    expect(recorderFor(rules.client, "new")).toBe("lead")
    expect(recorderFor(rules.client, "lead")).toBe("lead")
  })
  it("Lead: always the lead path", () => {
    for (const s of ["contact", "new", "lead"] as const) expect(recorderFor(rules.lead, s)).toBe("lead")
  })
  it("Private: nothing is saved, for anyone", () => {
    for (const s of ["contact", "new", "lead"] as const) expect(recorderFor(rules.private, s)).toBe("none")
  })
})

describe("template (derived, never chosen)", () => {
  it("the sales-questions template only for a NEW person, on a FREE call, of a kind that asks for it and makes a lead", () => {
    expect(okPlan({ person: { state: "new" }, kind: kind("lead") }).template).toBe("sales")
  })
  it("Client and Partner new people never get the sales questions", () => {
    expect(okPlan({ person: { state: "new" }, kind: kind("client") }).template).toBe("plain")
    expect(okPlan({ person: { state: "new" }, kind: kind("partner") }).template).toBe("plain")
  })
  it("a person already in the system never gets the sales questions", () => {
    expect(okPlan({ person: { state: "lead" }, kind: kind("lead") }).template).toBe("plain")
    expect(okPlan({ person: { state: "contact", established: true }, kind: kind("lead") }).template).toBe("plain")
  })
  it("a paid call never uses the sales template", () => {
    expect(okPlan({ person: { state: "new" }, kind: kind("lead"), payment: { amount: "100", currency: "USD" } }).template).toBe("plain")
  })
})

describe("money", () => {
  const paid = (amount: unknown, currency: unknown = "USD", person: LinkPlanInput["person"] = { state: "new" }) =>
    plan({ person, kind: kind("lead"), minutes: 45, payment: { amount, currency } })
  it("uses the same amount parser as the CRM payment-link maker", () => {
    const r = paid("397.50")
    expect(r.ok && r.plan.payment?.amountCents).toBe(39750)
    expect(paid("397,5").ok).toBe(true)
  })
  it("refuses what that parser refuses: 7 digits, above 50,000, zero, negative, thousands separators, text", () => {
    for (const bad of ["1234567", "50001", "0", "-5", "1.234,50", "1,234", "abc", "", "397 USD", null]) expect(paid(bad).ok).toBe(false)
  })
  it("at least 0.50 (Stripe's smallest charge)", () => {
    expect(paid("0.49").ok).toBe(false)
    expect(paid("0.50").ok).toBe(true)
  })
  it("USD or EUR only (capitals and stray spaces do not matter)", () => {
    expect(paid("100", "eur").ok).toBe(true)
    expect(paid("100", " usd ").ok).toBe(true)
    for (const bad of ["GBP", "", "US", null, 5]) expect(paid("100", bad).ok).toBe(false)
  })
  it("a typo like 3970 for 397 asks for a confirmation tick (above 2,000)", () => {
    const r = paid("3970")
    expect(r.ok && r.needsConfirm).toBe(true)
    const r2 = plan({ minutes: 45, payment: { amount: "3970", currency: "USD", confirmed: true } })
    expect(r2.ok && r2.needsConfirm).toBe(false)
    const r3 = paid("397")
    expect(r3.ok && r3.needsConfirm).toBe(false)
  })
  it("pay mode: new person and lead = credit; established client = revenue only; not-established contact = credit; unknown = revenue only", () => {
    expect(payModeFor({ state: "new" })).toBe("credit")
    expect(payModeFor({ state: "lead" })).toBe("credit")
    expect(payModeFor({ state: "contact", established: true })).toBe("revenue_only")
    expect(payModeFor({ state: "contact", established: false })).toBe("credit")
    expect(payModeFor({ state: "contact" })).toBe("revenue_only")
  })
  it("the pay mode is carried by the plan", () => {
    const r = plan({ person: { state: "contact", established: true }, kind: kind("client"), minutes: 45, payment: { amount: "300", currency: "USD" } })
    expect(r.ok && r.plan.payment).toMatchObject({ amountCents: 30000, currency: "USD", payMode: "revenue_only" })
  })
  it("a paid link cannot use a kind that saves nothing", () => {
    const r = plan({ person: { state: "new" }, kind: kind("private"), minutes: 45, payment: { amount: "100", currency: "USD" } })
    expect(r.ok).toBe(false)
    expect(errorsOf(r).join(" ")).toMatch(/saves nothing/)
  })
  it("a payment description over 80 characters is refused", () => {
    expect(plan({ minutes: 45, payment: { amount: "100", currency: "USD", label: "x".repeat(81) } }).ok).toBe(false)
  })
})

describe("referrer", () => {
  const ref = { eligible: true, hasCode: true, contactId: "c1", code: "ABC-2026" }
  it("allowed for a NEW person whose booking makes a lead", () => {
    expect(okPlan({ person: { state: "new" }, kind: kind("lead"), referrer: ref }).referrer).toEqual({ contactId: "c1", code: "ABC-2026" })
  })
  it("refused for a person already in the system", () => {
    expect(plan({ person: { state: "lead" }, referrer: ref }).ok).toBe(false)
    expect(plan({ person: { state: "contact", established: true }, kind: kind("client"), referrer: ref }).ok).toBe(false)
  })
  it("refused when the kind saves nothing", () => {
    expect(plan({ person: { state: "new" }, kind: kind("private"), referrer: ref }).ok).toBe(false)
  })
  it("refused when the referrer is not eligible (a partner, a test person, a merged contact) or has no code", () => {
    expect(plan({ referrer: { ...ref, eligible: false } }).ok).toBe(false)
    expect(plan({ referrer: { ...ref, hasCode: false, code: null } }).ok).toBe(false)
  })
})

describe("kinds that need setup are refused", () => {
  it("no rule, bad rule", () => {
    expect(plan({ kind: { slug: "x", label: "X", metadata: null } }).ok).toBe(false)
    expect(plan({ kind: { slug: "x", label: "X", metadata: { existing_person: "attach" } } }).ok).toBe(false)
  })
  it("reports every problem at once, not only the first", () => {
    const r = plan({ kind: { slug: "x", label: "X", metadata: null }, minutes: "no" })
    expect(errorsOf(r).length).toBeGreaterThanOrEqual(2)
  })
})

describe("the snapshot is pinned on the plan", () => {
  it("carries the kind's slug, label and rule", () => {
    const p = okPlan({ kind: kind("partner"), person: { state: "contact", established: true } })
    expect(p.snapshot).toMatchObject({ v: 1, kind_slug: "partner", kind_label: "Partner", rule: META.partner })
    expect(p.recorder).toBe("attach")
  })
})
