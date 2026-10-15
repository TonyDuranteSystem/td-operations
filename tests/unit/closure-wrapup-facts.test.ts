/**
 * Company Closure "Wrap-up" panel — the facts rules (lib/closure/wrapup-facts.ts). Slice 1 of the Wrap-up pop-up, dev job 5b136702.
 *
 * The payment cases below are the REAL production shapes the council found on 2026-10-15 (SupraEmerge: status Cancelled but
 * invoice_status Overdue; Fiscalot: status Cancelled but invoice_status Partial with $1,700 paid), not invented ones.
 */

import { describe, it, expect } from "vitest"
import {
  buildHeader,
  buildHolds,
  buildJobs,
  buildLease,
  buildMemberships,
  buildMoney,
  buildPeople,
  buildRegisteredAgent,
  buildRenewals,
  buildTax,
  classifyPayment,
  type RawAccount,
  type RawJob,
  type RawLease,
  type RawPayment,
  type StageOrders,
} from "@/lib/closure/wrapup-facts"
import { closingEmailRecipients } from "@/lib/closure/wrapup-email"

const TODAY = "2026-10-15"

function payment(over: Partial<RawPayment>): RawPayment {
  return {
    id: "p1",
    description: "Invoice",
    invoice_number: "INV-000001",
    status: "Pending",
    invoice_status: "Sent",
    total: 1000,
    amount: 1000,
    amount_paid: 0,
    amount_due: 1000,
    amount_currency: "USD",
    credit_remaining: null,
    ...over,
  }
}

function lease(over: Partial<RawLease>): RawLease {
  return { id: "l1", status: "signed", suite_number: "3D-245", term_end_date: "2026-12-31", ...over }
}

function account(over: Partial<RawAccount> = {}): RawAccount {
  return {
    id: "a1",
    company_name: "Northwind Ecom LLC",
    state_of_formation: "Wyoming",
    entity_type: "Single Member LLC",
    status: "Active",
    registered_agent_provider: "Harbor Compliance",
    suite_number: "3D-245",
    portal_tier: "active",
    ra_renewal_date: null,
    annual_report_due_date: null,
    cmra_renewal_date: null,
    ein_number: null,
    communication_email: null,
    ...over,
  }
}

function job(over: Partial<RawJob>): RawJob {
  return { id: "j1", service_type: "Banking", stage: "Application Submitted", status: "active", due_date: null, ...over }
}

/** Step numbers come from the step list, by step NAME (the job's own copy of the number is often empty or stale). */
const ORDERS: Record<string, StageOrders> = {
  Banking: { first: 1, byName: { "Data Collection": 1, "Application Submitted": 3 } },
  "State RA Renewal": { first: 1, byName: { Upcoming: 1 } },
  "State Annual Report": { first: 1, byName: { Upcoming: 1 } },
  "Tax Return": { first: -10, byName: { "Company Data Pending": -10, "Wizard Available": 40, "Extension Filed": 20, "TR Completed": 70, "TR Filed": 80, "Terminated - Non Payment": 90 } },
}

describe("buildLease (mirrors td_company_has_lease_in_force)", () => {
  it("a signed lease ending later is in force, with its end date", () => {
    const l = buildLease({ suite_number: "3D-245" }, [lease({})], TODAY)
    expect(l.inForce).toBe(true)
    expect(l.inForceUntil).toBe("2026-12-31")
    expect(l.suiteFreedAtClose).toBe(false)
  })
  it("a lease ending TODAY is still in force (the database compares >= today)", () => {
    expect(buildLease({ suite_number: "S" }, [lease({ term_end_date: TODAY })], TODAY).inForce).toBe(true)
  })
  it("a lease that ended yesterday is not in force, so closing frees the suite", () => {
    const l = buildLease({ suite_number: "S" }, [lease({ term_end_date: "2026-10-14" })], TODAY)
    expect(l.inForce).toBe(false)
    expect(l.suiteFreedAtClose).toBe(true)
  })
  it("sent and viewed leases count as in force; draft does not", () => {
    expect(buildLease({ suite_number: "S" }, [lease({ status: "sent" })], TODAY).inForce).toBe(true)
    expect(buildLease({ suite_number: "S" }, [lease({ status: "viewed" })], TODAY).inForce).toBe(true)
    expect(buildLease({ suite_number: "S" }, [lease({ status: "draft" })], TODAY).inForce).toBe(false)
  })
  it("a lease with no end date counts as in force and says so", () => {
    const l = buildLease({ suite_number: "S" }, [lease({ term_end_date: null })], TODAY)
    expect(l.inForce).toBe(true)
    expect(l.inForceHasNoEndDate).toBe(true)
    expect(l.inForceUntil).toBeNull()
  })
  it("a draft lease that names the suite is flagged (closing frees the suite while the draft still names it)", () => {
    const l = buildLease({ suite_number: "3D-242" }, [lease({ status: "draft", suite_number: "3D-242" })], TODAY)
    expect(l.draftNamesSuite).toBe(true)
    expect(l.suiteFreedAtClose).toBe(true)
    expect(l.draftCount).toBe(1)
  })
  it("no suite and no lease: nothing to free", () => {
    const l = buildLease({ suite_number: null }, [], TODAY)
    expect(l).toMatchObject({ suite: null, inForce: false, suiteFreedAtClose: false, draftCount: 0 })
  })
  it("an empty suite string is treated as no suite", () => {
    expect(buildLease({ suite_number: "  " }, [], TODAY).suite).toBeNull()
  })
})

describe("classifyPayment (which invoices are still owed)", () => {
  it("a normal overdue invoice is open and can be voided", () => {
    const i = classifyPayment(payment({ status: "Overdue", invoice_status: "Overdue" }))
    expect(i).toMatchObject({ kind: "overdue", canVoid: true, due: 1000 })
  })
  it("SupraEmerge shape: status Cancelled but invoice_status Overdue is STILL OWED", () => {
    const i = classifyPayment(payment({ status: "Cancelled", invoice_status: "Overdue", invoice_number: null, total: 1000, amount_paid: 0, amount_due: 1000 }))
    expect(i).not.toBeNull()
    expect(i?.kind).toBe("overdue")
  })
  it("Fiscalot shape: status Cancelled but invoice_status Partial with $1,700 paid is part-paid and cannot be voided", () => {
    const i = classifyPayment(payment({ status: "Cancelled", invoice_status: "Partial", total: 2200, amount_paid: 1700, amount_due: 500 }))
    expect(i).toMatchObject({ kind: "partial", paid: 1700, due: 500, canVoid: false })
  })
  it("a fully paid or cancelled invoice is not listed", () => {
    expect(classifyPayment(payment({ status: "Paid", invoice_status: "Paid" }))).toBeNull()
    expect(classifyPayment(payment({ status: "Cancelled", invoice_status: "Cancelled" }))).toBeNull()
    expect(classifyPayment(payment({ status: "Cancelled", invoice_status: null }))).toBeNull()
    expect(classifyPayment(payment({ status: "Waived", invoice_status: null }))).toBeNull()
  })
  it("money already received wins over an open-looking invoice_status (the 48 production rows)", () => {
    expect(classifyPayment(payment({ status: "Paid", invoice_status: "Sent" }))).toBeNull()
    expect(classifyPayment(payment({ status: "Refunded", invoice_status: "Overdue" }))).toBeNull()
  })
  it("a never-invoiced installment is listed on its own (Finance cannot show it)", () => {
    const i = classifyPayment(payment({ status: "Not Invoiced", invoice_status: null, invoice_number: null, description: "First Installment 2026" }))
    expect(i).toMatchObject({ kind: "not_invoiced", statusText: "Never invoiced", canVoid: true })
  })
  it("a draft invoice, a delinquent one and a pending one are each recognised", () => {
    expect(classifyPayment(payment({ status: "Pending", invoice_status: "Draft" }))?.kind).toBe("draft")
    expect(classifyPayment(payment({ status: "Delinquent", invoice_status: "Overdue" }))?.kind).toBe("overdue")
    expect(classifyPayment(payment({ status: "Delinquent", invoice_status: null }))?.kind).toBe("delinquent")
    expect(classifyPayment(payment({ status: "Pending", invoice_status: null }))?.kind).toBe("pending")
  })
  it("a credit note is never money the client owes", () => {
    expect(classifyPayment(payment({ status: "Paid", invoice_status: "Credit", total: -200, credit_remaining: 200 }))).toBeNull()
  })
  it("derives the amount due when the column is empty, and never goes negative", () => {
    expect(classifyPayment(payment({ amount_due: null, total: 500, amount_paid: 0 }))?.due).toBe(500)
    expect(classifyPayment(payment({ amount_due: null, total: 500, amount_paid: 800, invoice_status: "Partial" }))?.due).toBe(0)
  })
  it("keeps the invoice's own currency", () => {
    expect(classifyPayment(payment({ amount_currency: "EUR" }))?.currency).toBe("EUR")
    expect(classifyPayment(payment({ amount_currency: null }))?.currency).toBe("USD")
  })
})

describe("buildMoney", () => {
  it("lists only what is still owed and sums unspent credit per currency", () => {
    const m = buildMoney([
      payment({ id: "a", status: "Overdue", invoice_status: "Overdue" }),
      payment({ id: "b", status: "Paid", invoice_status: "Paid" }),
      payment({ id: "c", status: "Paid", invoice_status: "Credit", total: -150, credit_remaining: 150 }),
      payment({ id: "d", status: "Paid", invoice_status: "Credit", total: -50, credit_remaining: 50 }),
      payment({ id: "e", status: "Paid", invoice_status: "Credit", total: -20, credit_remaining: 20, amount_currency: "EUR" }),
      payment({ id: "f", status: "Paid", invoice_status: "Credit", total: -9, credit_remaining: 0 }),
    ])
    expect(m.items.map((i) => i.id)).toEqual(["a"])
    expect(m.credit).toEqual([
      { currency: "USD", amount: 200 },
      { currency: "EUR", amount: 20 },
    ])
  })
  it("nothing owed and no credit is an empty result, not an error", () => {
    expect(buildMoney([])).toEqual({ items: [], credit: [] })
  })
})

describe("buildJobs / buildRenewals", () => {
  it("drops this closure job and finished jobs, keeps blocked and on-hold ones with a flag", () => {
    const jobs = buildJobs(
      [
        job({ id: "self", service_type: "Company Closure" }),
        job({ id: "done", status: "completed" }),
        job({ id: "cx", status: "cancelled" }),
        job({ id: "b", status: "blocked", service_type: "State RA Renewal", stage: "Upcoming" }),
        job({ id: "h", status: "on_hold" }),
        job({ id: "ok", status: "Active" }),
      ],
      ORDERS,
      "self",
    )
    expect(jobs.map((j) => j.id)).toEqual(["b", "h", "ok"])
    expect(jobs.find((j) => j.id === "b")).toMatchObject({ flag: "blocked", isRenewal: true, pastFirstStep: false })
    expect(jobs.find((j) => j.id === "h")?.flag).toBe("on_hold")
    expect(jobs.find((j) => j.id === "ok")?.flag).toBeNull()
  })
  it("marks a job already past its first step (it needs an explicit choice)", () => {
    const [banking] = buildJobs([job({ stage: "Application Submitted" })], ORDERS)
    expect(banking.pastFirstStep).toBe(true)
    const [tax] = buildJobs([job({ service_type: "Tax Return", stage: "Company Data Pending" })], ORDERS)
    expect(tax.pastFirstStep).toBe(false)
  })
  it("a job whose step name is not in the step list is not claimed to be past its first step", () => {
    expect(buildJobs([job({ stage: "A step that no longer exists" })], ORDERS)[0].pastFirstStep).toBe(false)
    expect(buildJobs([job({ stage: null })], ORDERS)[0].pastFirstStep).toBe(false)
    expect(buildJobs([job({ service_type: "Unknown Service" })], ORDERS)[0].pastFirstStep).toBe(false)
  })
  it("renewal dates are listed even when no job is open, and say so", () => {
    const jobs = buildJobs([job({ id: "ar", service_type: "State Annual Report", stage: "Upcoming" })], ORDERS)
    const r = buildRenewals(account({ ra_renewal_date: "2026-11-26", annual_report_due_date: "2026-12-08", cmra_renewal_date: "2027-01-05" }), jobs)
    expect(r.dates.map((d) => [d.key, d.hasOpenJob])).toEqual([
      ["ra", false],
      ["annual_report", true],
      ["cmra", false],
    ])
    expect(r.jobs).toHaveLength(1)
  })
  it("no renewal dates and no jobs is empty", () => {
    expect(buildRenewals(account(), [])).toEqual({ dates: [], jobs: [] })
  })
})

describe("buildTax (Antonio's choice B: an open Tax Return keeps the company Active)", () => {
  const taxJob = (stage: string, over: Partial<RawJob> = {}) => buildJobs([job({ id: "t", service_type: "Tax Return", stage, ...over })], ORDERS)
  it("an open Tax Return job holds the closing", () => {
    const t = buildTax([{ tax_year: 2025, status: "Wizard Available", paid: false }], taxJob("Wizard Available"))
    expect(t.holdsClosing).toBe(true)
    expect(t.openJobs[0].label).toBe("Tax Return · Wizard Available")
  })
  it("TR Completed is NOT filed: it still holds the closing", () => {
    expect(buildTax([], taxJob("TR Completed")).holdsClosing).toBe(true)
  })
  it("a finished Tax Return job (TR Filed completes the job) does not hold the closing", () => {
    expect(buildTax([{ tax_year: 2025, status: "TR Filed", paid: true }], taxJob("TR Filed", { status: "completed" })).holdsClosing).toBe(false)
  })
  it("a terminated job is a dead end, not a return being worked on", () => {
    expect(buildTax([], taxJob("Terminated - Non Payment")).holdsClosing).toBe(false)
  })
  it("no jobs at all does not hold the closing", () => {
    expect(buildTax([], []).holdsClosing).toBe(false)
  })
})

describe("people, recipients and the registered agent", () => {
  it("an owner of another active company keeps their login; a sole owner keeps a personal area only", () => {
    const people = buildPeople([
      { contact_id: "c1", full_name: "Marco Rossi", email: "m@x.test", language: "Italian", role: "Owner", other_portal_companies: ["Orion Trading LLC"] },
      { contact_id: "c2", full_name: "Anna Bianchi", email: "a@x.test", language: "English", role: "Owner", other_portal_companies: [] },
    ])
    expect(people[0]).toMatchObject({ keepsLogin: true, emailLanguage: "it" })
    expect(people[1]).toMatchObject({ keepsLogin: false, emailLanguage: "en" })
  })
  it("client language is free text: Italian spellings all give an Italian email, anything else English", () => {
    const lang = (l: string | null) => buildPeople([{ contact_id: "c", full_name: "X", email: null, language: l, role: null, other_portal_companies: [] }])[0].emailLanguage
    expect(lang("it")).toBe("it")
    expect(lang("Italian")).toBe("it")
    expect(lang("italiano")).toBe("it")
    expect(lang("it-IT")).toBe("it")
    expect(lang("English")).toBe("en")
    expect(lang(null)).toBe("en")
  })
  it("closing email recipients are one per distinct address; people with no address are skipped", () => {
    const people = buildPeople([
      { contact_id: "c1", full_name: "Giulia", email: "g@x.test", language: "it", role: null, other_portal_companies: [] },
      { contact_id: "c2", full_name: "Giulia (dup)", email: "G@X.test", language: "it", role: null, other_portal_companies: [] },
      { contact_id: "c3", full_name: "Luca", email: null, language: "it", role: null, other_portal_companies: [] },
      { contact_id: "c4", full_name: "Paul", email: "p@x.test", language: "en", role: null, other_portal_companies: [] },
    ])
    expect(closingEmailRecipients(people).map((r) => [r.name, r.language])).toEqual([
      ["Giulia", "it"],
      ["Paul", "en"],
    ])
  })
  it("Harbor is recognised in any spelling; an empty provider is flagged missing", () => {
    expect(buildRegisteredAgent(account({ registered_agent_provider: "Harbor Compliance" }))).toMatchObject({ isHarbor: true, missing: false })
    expect(buildRegisteredAgent(account({ registered_agent_provider: "harbor compliance inc" })).isHarbor).toBe(true)
    expect(buildRegisteredAgent(account({ registered_agent_provider: "Registered Agents Inc" }))).toMatchObject({ isHarbor: false, missing: false })
    expect(buildRegisteredAgent(account({ registered_agent_provider: "  " }))).toMatchObject({ provider: null, missing: true })
  })
  it("the header names an unnamed company safely", () => {
    expect(buildHeader(account({ company_name: null })).companyName).toBe("Unnamed company")
  })
  it("memberships keep the stake and the parent's status", () => {
    expect(buildMemberships([{ company_name: "Salemark LLC", status: "Active", ownership_pct: 49 }])).toEqual([{ companyName: "Salemark LLC", status: "Active", ownershipPct: 49 }])
  })
})

describe("buildHolds (what would keep the Close button off)", () => {
  const ok = <T,>(data: T) => ({ ok: true as const, data })
  it("a section that could not be read holds the closing and says so (fail closed, never 'nothing owed')", () => {
    const holds = buildHolds({ tax: { ok: false, error: "boom" }, money: { ok: false, error: "boom" } })
    expect(holds).toHaveLength(2)
    expect(holds.join(" ")).toMatch(/Could not check the tax return/)
    expect(holds.join(" ")).toMatch(/Could not check the payments/)
  })
  it("names the open Tax Return and counts the unpaid items", () => {
    const tax = ok(buildTax([], buildJobs([job({ service_type: "Tax Return", stage: "Extension Filed" })], ORDERS)))
    const money = ok(buildMoney([payment({ status: "Overdue", invoice_status: "Overdue" }), payment({ id: "p2", status: "Pending", invoice_status: "Sent" })]))
    const holds = buildHolds({ tax, money })
    expect(holds[0]).toMatch(/Tax Return · Extension Filed/)
    expect(holds[1]).toMatch(/2 unpaid or uninvoiced items/)
  })
  it("every other section that could not be read holds the closing too (never 'nothing found' next to a red box)", () => {
    const holds = buildHolds({
      tax: ok(buildTax([], [])),
      money: ok(buildMoney([])),
      lease: { ok: false, error: "x" },
      renewals: { ok: false, error: "x" },
      jobs: { ok: false, error: "x" },
      people: { ok: false, error: "x" },
      memberOf: { ok: false, error: "x" },
    })
    expect(holds).toHaveLength(5)
    expect(holds.join(" ")).toMatch(/lease/)
    expect(holds.join(" ")).toMatch(/owners/)
    expect(holds.join(" ")).toMatch(/companies this one belongs to/)
  })
  it("sections that loaded fine add nothing", () => {
    expect(buildHolds({ tax: ok(buildTax([], [])), money: ok(buildMoney([])), lease: ok({}), renewals: ok({}), jobs: ok([]), people: ok([]), memberOf: ok([]) })).toEqual([])
  })
  it("nothing found means no holds", () => {
    expect(buildHolds({ tax: ok(buildTax([], [])), money: ok(buildMoney([])) })).toEqual([])
  })
  it("one unpaid item reads in the singular", () => {
    expect(buildHolds({ tax: ok(buildTax([], [])), money: ok(buildMoney([payment({ status: "Overdue", invoice_status: "Overdue" })])) })[0]).toMatch(/1 unpaid or uninvoiced item must/)
  })
})
