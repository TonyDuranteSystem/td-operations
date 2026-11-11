import { describe, it, expect } from "vitest"
import { validatePaymentPlan, clientFacingPartLabel } from "@/lib/offers/payment-plan"
import { computePlanStatus, type TrancheInvoiceRow } from "@/lib/offers/payment-plan-state"
import { classifyPlanPart, stepReached, stepKey, type OfferJob, type StepOrders } from "@/lib/plan-invoices/classify"
import { defaultStepWording, stepOptionsForServices, STEP_TRIGGER_SERVICE_TYPES } from "@/lib/plan-invoices/steps"

/**
 * "Invoices to raise" (dev job ae3c19db): nothing is raised by itself; a person clicks when the Calendar says a part is due.
 * These tests pin WHEN a later part is due — a date, a step reached, a draft nobody sent — and when it is only coming up.
 */
const row = (over: Partial<TrancheInvoiceRow>): TrancheInvoiceRow => ({
  id: "i", invoice_number: "INV-1", invoice_status: "Sent", amount_paid: 0, amount: 1900, tranche_seq: 2, due_date: null, ...over,
})
const planOf = (second: Record<string, unknown>) =>
  validatePaymentPlan([
    { seq: 1, amount: 1900, currency: "EUR", trigger: { kind: "signing" } },
    { seq: 2, amount: 1900, currency: "EUR", trigger: second },
  ]).plan!
const STEPS: StepOrders = new Map([
  [stepKey("Company Formation", "Articles Received"), 4],
  [stepKey("Company Formation", "EIN Received"), 8],
])
const job = (over: Partial<OfferJob>): OfferJob => ({ service_type: "Company Formation", stage_order: 2, status: "active", source_offer_token: "tok", ...over })
const classify = (second: Record<string, unknown>, rows: TrancheInvoiceRow[], jobs: OfferJob[], today = "2026-11-20") => {
  const plan = planOf(second)
  const status = computePlanStatus(plan, [row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1900 }), ...rows])
  return classifyPlanPart({ status: status.parts[1], todayIso: today, offerToken: "tok", jobs, stepOrders: STEPS, totalParts: 2 })
}

describe("a part with a DATE", () => {
  const dated = { kind: "date", date: "2026-11-27" }
  it("is coming up before the day, due on the day, and due (late) after it", () => {
    expect(classify(dated, [], [], "2026-11-26")).toMatchObject({ due: false, text: "Due 27 Nov 2026" })
    expect(classify(dated, [], [], "2026-11-27")).toMatchObject({ due: true, reason: { kind: "date", daysLate: 0 }, text: "Due today (27 Nov 2026)" })
    expect(classify(dated, [], [], "2026-11-30")).toMatchObject({ due: true, reason: { kind: "date", daysLate: 3 }, text: "Due 27 Nov 2026 — 3 days late" })
  })
  it("says '1 day late' in the singular", () => {
    expect(classify(dated, [], [], "2026-11-28")?.text).toBe("Due 27 Nov 2026 — 1 day late")
  })
  it("is not listed once an invoice was sent (or paid): nothing is left to raise", () => {
    expect(classify(dated, [row({ invoice_status: "Sent" })], [], "2026-12-30")).toBeNull()
    expect(classify(dated, [row({ invoice_status: "Paid", amount_paid: 1900 })], [], "2026-12-30")).toBeNull()
  })
  it("a cancelled / voided invoice releases the part: it is listed again", () => {
    expect(classify(dated, [row({ invoice_status: "Voided" })], [], "2026-12-01")).toMatchObject({ due: true })
  })
})

describe("a part waiting for a STEP (when the EIN arrives)", () => {
  const ein = { kind: "step", service_type: "Company Formation", stage: "EIN Received", label: "After the EIN arrives" }
  it("is coming up while the offer's job is before the step", () => {
    expect(classify(ein, [], [job({ stage_order: 2 })])).toMatchObject({ due: false, text: 'Waiting for "EIN Received" of Company Formation', stepNotFound: false })
    expect(classify(ein, [], [job({ stage_order: 7 })])?.due).toBe(false)
  })
  it("is due the moment the job reaches the step — or goes past it, or is completed", () => {
    expect(classify(ein, [], [job({ stage_order: 8 })])).toMatchObject({ due: true, reason: { kind: "step", stage: "EIN Received" } })
    expect(classify(ein, [], [job({ stage_order: 9 })])?.due).toBe(true)
    expect(classify(ein, [], [job({ stage_order: 3, status: "completed" })])?.due).toBe(true)
  })
  it("only the job that came from THIS offer counts (another client's job, or a cancelled one, never does)", () => {
    expect(classify(ein, [], [job({ stage_order: 8, source_offer_token: "someone-else" })])?.due).toBe(false)
    expect(classify(ein, [], [job({ stage_order: 8, status: "cancelled" })])?.due).toBe(false)
    expect(classify(ein, [], [job({ stage_order: 8, service_type: "ITIN" })])?.due).toBe(false)
  })
  it("a step that is not in the step list any more is flagged, never guessed", () => {
    const gone = { kind: "step", service_type: "Company Formation", stage: "Renamed Step" }
    expect(classify(gone, [], [job({ stage_order: 8 })])).toMatchObject({ due: false, stepNotFound: true })
  })
  it("with no job from the offer yet it is simply waiting", () => {
    expect(classify(ein, [], [])?.due).toBe(false)
  })
})

describe("'When I say so' and drafts", () => {
  it("a manual part is never due by itself — it waits, with the author's reason, and can be raised any time", () => {
    const c = classify({ kind: "manual", label: "when the bank account opens" }, [], [job({ stage_order: 8 })], "2099-01-01")
    expect(c).toMatchObject({ due: false })
    expect(c?.text).toBe("Waiting: when the bank account opens")
  })
  it("a part raised as a Draft is DUE: the client was never told, a person still has to send it", () => {
    const c = classify({ kind: "date", date: "2026-11-27" }, [row({ invoice_status: "Draft", invoice_number: "INV-9" })], [], "2026-11-01")
    expect(c).toMatchObject({ due: true, reason: { kind: "draft", invoiceNumber: "INV-9" } })
    expect(c?.text).toContain("draft")
  })
  it("part 1 (signing) is never listed", () => {
    const plan = planOf({ kind: "manual", label: "x" })
    const status = computePlanStatus(plan, [])
    expect(classifyPlanPart({ status: status.parts[0], todayIso: "2026-11-20", offerToken: "tok", jobs: [], stepOrders: STEPS, totalParts: 2 })).toBeNull()
  })
})

describe("stepReached", () => {
  it("unknown step → found false", () => {
    expect(stepReached({ jobs: [], offerToken: "tok", serviceType: "Company Formation", stage: "Nope", stepOrders: STEPS })).toEqual({ reached: false, found: false })
  })
  it("matches service and step names case-insensitively", () => {
    expect(stepReached({ jobs: [job({ stage_order: 8 })], offerToken: "tok", serviceType: "company formation", stage: "ein received", stepOrders: STEPS })).toEqual({ reached: true, found: true })
  })
})

describe("the 'step' trigger in the plan itself", () => {
  const base = [{ seq: 1, amount: 1900, currency: "EUR", trigger: { kind: "signing" } }]
  it("is accepted with a service and a step, and keeps them (and the client's words)", () => {
    const v = validatePaymentPlan([...base, { seq: 2, amount: 1900, currency: "EUR", trigger: { kind: "step", service_type: " Company Formation ", stage: "EIN Received", label: " After the EIN arrives " } }])
    expect(v.ok).toBe(true)
    expect(v.plan![1].trigger).toEqual({ kind: "step", service_type: "Company Formation", stage: "EIN Received", label: "After the EIN arrives" })
  })
  it("is refused without the service or the step", () => {
    const v = validatePaymentPlan([...base, { seq: 2, amount: 1900, currency: "EUR", trigger: { kind: "step", service_type: "Company Formation" } }])
    expect(v.ok).toBe(false)
    expect(v.errors.join(" ")).toContain("needs the service and the step")
  })
  it("the client reads the author's own words, joined like a manual part", () => {
    const part = planOf({ kind: "step", service_type: "Company Formation", stage: "EIN Received", label: "After the EIN arrives" })[1]
    expect(clientFacingPartLabel(part, 2)).toBe("Part 2 of 2, due After the EIN arrives")
  })
  it("a step part with no words falls back to the generic sentence (never an empty line)", () => {
    const part = planOf({ kind: "step", service_type: "Company Formation", stage: "EIN Received" })[1]
    expect(clientFacingPartLabel(part, 2)).toBe("Part 2 of 2, due when the agreed step is complete")
  })
})

describe("steps offered by the offer builder", () => {
  const ALL = [
    { service_type: "Company Formation", stage_name: "EIN Received", stage_order: 8 },
    { service_type: "Company Formation", stage_name: "Filed with State", stage_order: 3 },
    { service_type: "ITIN", stage_name: "Application Sent", stage_order: 2 },
    { service_type: "Tax Return", stage_name: "Filed", stage_order: 5 },
  ]
  it("only services in THIS offer, only services whose job is tied to the offer, in step order", () => {
    expect(stepOptionsForServices(ALL, ["Company Formation"]).map((o) => o.stage_name)).toEqual(["Filed with State", "EIN Received"])
    expect(stepOptionsForServices(ALL, ["Tax Return"])).toEqual([])
    expect(stepOptionsForServices(ALL, ["company formation", "ITIN"]).map((o) => o.service_type)).toEqual(["Company Formation", "Company Formation", "ITIN"])
  })
  it("the allowed list is exactly the services whose jobs carry the offer", () => {
    expect([...STEP_TRIGGER_SERVICE_TYPES]).toEqual(["Company Formation", "ITIN"])
  })
  it("default client wording", () => {
    expect(defaultStepWording("Company Formation", "EIN Received")).toBe("after the EIN arrives")
    expect(defaultStepWording("Company Formation", "Articles Received")).toContain("Articles of Organization")
    expect(defaultStepWording("ITIN", "Application Sent")).toBe('after the "Application Sent" step')
  })
})
