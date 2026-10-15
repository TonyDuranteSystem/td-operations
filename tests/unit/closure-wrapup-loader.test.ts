/**
 * Company Closure "Wrap-up" panel — the server loader (lib/closure/wrapup-facts-load.ts) against an in-memory fake database.
 *
 * The council's light review (2026-10-15) found the first tests only grepped the source: nothing ran the loader. These do. They pin:
 * every section fails on its own and CLOSED (an unreadable section is a red error and a hold, never "nothing found"); the "keeps their
 * login" and "part of another company" derivations; a truncated payment list is refused; the person variant reports a failed read;
 * a malformed or missing job id is a 404; and the company's EIN never leaves the loader.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

type Row = Record<string, unknown>
let db: Record<string, Row[] | { error: string }> = {}

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let single = false
  let lim = Infinity
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
    is: (c: string, v: null) => (filters.push((r) => (r[c] ?? null) === v), q),
    ilike: (c: string, pat: string) => {
      const want = pat.replace(/\\(.)/g, "$1").toLowerCase()
      filters.push((r) => String(r[c] ?? "").toLowerCase() === want)
      return q
    },
    order: () => q,
    limit: (n: number) => ((lim = n), q),
    maybeSingle: () => ((single = true), q),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const t = db[table]
      let result: unknown
      if (!t) result = { data: [], error: null }
      else if (!Array.isArray(t)) result = { data: null, error: { message: t.error } }
      else {
        const rows = t.filter((r) => filters.every((f) => f(r))).slice(0, lim)
        result = { data: single ? (rows[0] ?? null) : rows, error: null }
      }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return q
}

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => from(t) } }))

import { loadWrapUpFacts } from "@/lib/closure/wrapup-facts-load"
import type { WrapUpCompanyFacts, WrapUpPersonFacts } from "@/lib/closure/wrapup-facts"

const JOB = "11111111-1111-4111-8111-111111111111"
const ACCT = "22222222-2222-4222-8222-222222222222"
const EIN_WITH_DASH = "98-7000001"
const EIN_DIGITS = "987000001"

const account = (over: Row = {}): Row => ({
  id: ACCT,
  company_name: "Verde Studio LLC",
  state_of_formation: "Delaware",
  entity_type: "Multi Member LLC",
  status: "Active",
  registered_agent_provider: "Harbor Compliance",
  suite_number: "3D-310",
  portal_tier: "active",
  ra_renewal_date: "2026-07-03",
  annual_report_due_date: null,
  cmra_renewal_date: null,
  ein_number: EIN_WITH_DASH,
  communication_email: null,
  ...over,
})

function seedCompany() {
  db = {
    service_deliveries: [
      { id: JOB, service_type: "Company Closure", status: "active", stage: "Wrap-up", account_id: ACCT, contact_id: "c1", source_closure_token: null, due_date: null },
      { id: "j-tax", service_type: "Tax Return One-Time", status: "active", stage: "Wizard Available", account_id: ACCT, due_date: null },
      { id: "j-bank", service_type: "Banking", status: "on_hold", stage: "Application Submitted", account_id: ACCT, due_date: null },
      { id: "j-ra", service_type: "State RA Renewal", status: "blocked", stage: "Upcoming", account_id: ACCT, due_date: null },
      { id: "j-old", service_type: "Banking", status: "completed", stage: "Done", account_id: ACCT, due_date: null },
    ],
    pipeline_stages: [
      { service_type: "Tax Return One-Time", stage_name: "Payment Pending", stage_order: 0 },
      { service_type: "Tax Return One-Time", stage_name: "Wizard Available", stage_order: 2 },
      { service_type: "Banking", stage_name: "Data Collection", stage_order: 1 },
      { service_type: "Banking", stage_name: "Application Submitted", stage_order: 3 },
      { service_type: "State RA Renewal", stage_name: "Upcoming", stage_order: 1 },
    ],
    accounts: [
      account(),
      { id: "other-active", company_name: "Studio Nova LLC", status: "Active" },
      { id: "other-closed", company_name: "Old Closed LLC", status: "Closed" },
      { id: "parent", company_name: "Parent Holdings LLC", status: "Active" },
    ],
    lease_agreements: [{ id: "l1", account_id: ACCT, status: "signed", suite_number: "3D-310", term_end_date: "2999-01-01" }],
    payments: [
      { id: "p1", account_id: ACCT, description: "2nd installment", status: "Overdue", invoice_status: "Overdue", total: 1000, amount: 1000, amount_paid: 0, amount_due: 1000, amount_currency: "USD", credit_remaining: null },
      { id: "p2", account_id: ACCT, description: "Paid already", status: "Paid", invoice_status: "Paid", total: 50, amount: 50, amount_paid: 50, amount_due: 0, amount_currency: "USD", credit_remaining: null },
    ],
    tax_returns: [{ account_id: ACCT, tax_year: 2025, status: "Wizard Available", paid: false }],
    account_contacts: [
      { account_id: ACCT, contact_id: "c1", role: "Owner", ended_at: null },
      { account_id: ACCT, contact_id: "c2", role: "Owner", ended_at: null },
      { account_id: ACCT, contact_id: "c3", role: "Owner", ended_at: "2026-01-01" },
      { account_id: "other-active", contact_id: "c1", ended_at: null },
      { account_id: "other-closed", contact_id: "c2", ended_at: null },
    ],
    contacts: [
      { id: "c1", full_name: "Giulia Verdi", email: "g@x.test", language: "Italian" },
      { id: "c2", full_name: "Paul Meyer", email: null, language: "English" },
    ],
    members: [
      { id: "m1", account_id: "parent", member_type: "company", company_name: "Some other spelling", ein: EIN_WITH_DASH, ownership_pct: 49, end_date: null },
      { id: "m2", account_id: "parent", member_type: "company", company_name: "verde studio llc", ein: null, ownership_pct: 10, end_date: null },
      { id: "m3", account_id: "parent", member_type: "company", company_name: "Verde Studio LLC", ein: null, ownership_pct: 5, end_date: "2020-01-01" },
      { id: "m4", account_id: ACCT, member_type: "company", company_name: "Verde Studio LLC", ein: EIN_WITH_DASH, ownership_pct: 100, end_date: null },
    ],
  }
}

beforeEach(() => {
  db = {}
})

describe("loadWrapUpFacts: job checks", () => {
  it("a malformed id is a 404, not a database error", async () => {
    expect(await loadWrapUpFacts("not-a-uuid")).toEqual({ ok: false, status: 404, error: "Job not found." })
  })
  it("a job that does not exist is a 404", async () => {
    db = { service_deliveries: [] }
    expect(await loadWrapUpFacts(JOB)).toMatchObject({ ok: false, status: 404 })
  })
  it("a job that is not a Company Closure is refused with a message", async () => {
    db = { service_deliveries: [{ id: JOB, service_type: "Banking", status: "active", account_id: ACCT, contact_id: null, source_closure_token: null }] }
    expect(await loadWrapUpFacts(JOB)).toEqual({ ok: false, status: 400, error: "This is not a Company Closure job." })
  })
  it("a failed read of the job is a 500 with the reason, never an empty panel", async () => {
    db = { service_deliveries: { error: "connection reset" } }
    expect(await loadWrapUpFacts(JOB)).toMatchObject({ ok: false, status: 500 })
  })
})

describe("loadWrapUpFacts: company facts", () => {
  it("builds every section from the rows", async () => {
    seedCompany()
    const r = await loadWrapUpFacts(JOB)
    expect(r.ok).toBe(true)
    const f = (r as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.variant).toBe("company")
    expect(f.header.companyName).toBe("Verde Studio LLC")
    expect(f.registeredAgent).toMatchObject({ isHarbor: true, missing: false })
    // lease
    expect(f.lease).toMatchObject({ ok: true, data: { inForce: true, suite: "3D-310" } })
    // jobs: this closure job and the finished one are not listed; step numbers come from the step list by name
    const jobs = f.jobs.ok === true ? f.jobs.data : []
    expect(jobs.map((j) => j.id).sort()).toEqual(["j-bank", "j-ra", "j-tax"])
    expect(jobs.find((j) => j.id === "j-bank")).toMatchObject({ flag: "on_hold", pastFirstStep: true })
    expect(jobs.find((j) => j.id === "j-ra")).toMatchObject({ flag: "blocked", pastFirstStep: false })
    // the one-time tax return holds the closing, like the yearly one
    expect(f.tax).toMatchObject({ ok: true, data: { holdsClosing: true } })
    // money: only the overdue invoice
    expect(f.money.ok === true ? f.money.data.items.map((i) => i.id) : null).toEqual(["p1"])
    expect(f.holds.join(" ")).toMatch(/Tax Return/)
    expect(f.holds.join(" ")).toMatch(/1 unpaid or uninvoiced item must/)
  })

  it("an owner of another ACTIVE company keeps their login; one whose other company is Closed does not; ended links are not owners", async () => {
    seedCompany()
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    const people = f.people.ok === true ? f.people.data : []
    expect(people.map((p) => p.name).sort()).toEqual(["Giulia Verdi", "Paul Meyer"])
    expect(people.find((p) => p.name === "Giulia Verdi")).toMatchObject({ keepsLogin: true, otherCompanies: ["Studio Nova LLC"], emailLanguage: "it" })
    expect(people.find((p) => p.name === "Paul Meyer")).toMatchObject({ keepsLogin: false, email: null })
  })

  it("'part of another company' matches by EIN (dash or not) AND by name, drops ended stakes and the company itself", async () => {
    seedCompany()
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    const stakes = f.memberOf.ok === true ? f.memberOf.data : []
    expect(stakes.map((s) => s.ownershipPct).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 49])
    expect(stakes.every((s) => s.companyName === "Parent Holdings LLC")).toBe(true)
  })

  it("matches an EIN stored without the dash", async () => {
    seedCompany()
    ;(db.members as Row[])[0].ein = EIN_DIGITS
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect((f.memberOf.ok === true ? f.memberOf.data : []).some((s) => s.ownershipPct === 49)).toBe(true)
  })

  it("never returns the company's EIN", async () => {
    seedCompany()
    const r = await loadWrapUpFacts(JOB)
    const text = JSON.stringify(r)
    expect(text).not.toContain(EIN_WITH_DASH)
    expect(text).not.toContain(EIN_DIGITS)
  })

  it("each section fails on its own and CLOSED: an unreadable payments table is an error and a hold, the rest still loads", async () => {
    seedCompany()
    db.payments = { error: "timeout" }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.money.ok).toBe(false)
    expect(f.money.ok === false ? f.money.error : "").toMatch(/Couldn't check the payments/)
    expect(f.holds.join(" ")).toMatch(/Could not check the payments/)
    expect(f.lease.ok).toBe(true)
    expect(f.tax.ok).toBe(true)
  })

  it("a failed read of the owners holds the closing too (not only money and tax)", async () => {
    seedCompany()
    db.contacts = { error: "boom" }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.people.ok).toBe(false)
    expect(f.holds.join(" ")).toMatch(/Could not check the owners/)
  })

  it("a failed read of the open services fails the renewals and the tax return with it (they depend on it)", async () => {
    seedCompany()
    // the closure job itself is read first; break only the list of the company's services by making pipeline_stages unreadable
    db.pipeline_stages = { error: "boom" }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.jobs.ok).toBe(false)
    expect(f.renewals.ok).toBe(false)
    expect(f.tax.ok).toBe(false)
    expect(f.holds.join(" ")).toMatch(/Could not check the tax return/)
  })

  it("a payment list that was cut short is refused, not judged 'nothing owed'", async () => {
    seedCompany()
    db.payments = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, account_id: ACCT, description: "x", status: "Paid", invoice_status: "Paid", total: 1, amount: 1, amount_paid: 1, amount_due: 0, amount_currency: "USD", credit_remaining: null }))
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.money.ok).toBe(false)
    expect(f.money.ok === false ? f.money.error : "").toMatch(/more than 1000 payments/)
  })

  it("a company with no tax return, no jobs and nothing owed has no holds", async () => {
    seedCompany()
    db.service_deliveries = [{ id: JOB, service_type: "Company Closure", status: "active", stage: "Wrap-up", account_id: ACCT, contact_id: "c1", source_closure_token: null }]
    db.payments = []
    db.tax_returns = []
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpCompanyFacts }).facts
    expect(f.holds).toEqual([])
  })
})

describe("loadWrapUpFacts: closure with no company record (person variant)", () => {
  const personJob = (token: string | null) => ({ id: JOB, service_type: "Company Closure", status: "active", stage: "Wrap-up", account_id: null, contact_id: "c1", source_closure_token: token })

  it("reads the form this job was created from, not the person's other closure form", async () => {
    db = {
      service_deliveries: [personJob("tok-b")],
      contacts: [{ id: "c1", full_name: "Patrick Veg", email: "p@x.test", language: "English" }],
      closure_submissions: [
        { token: "tok-a", contact_id: "c1", created_at: "2026-09-01", submitted_data: { llc_name: "First LLC", llc_state: "Delaware" } },
        { token: "tok-b", contact_id: "c1", created_at: "2026-06-01", submitted_data: { llc_name: "Doctor Veg LLC", llc_state: "Delaware", tax_returns_filed: "Yes", tax_returns_years: "2023 2024" } },
      ],
      account_contacts: [{ account_id: "new-co", contact_id: "c1", ended_at: null }],
      accounts: [{ id: "new-co", company_name: "DoctorGut LLC", status: "Active" }],
    }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpPersonFacts }).facts
    expect(f.variant).toBe("person")
    expect(f.closureCompanyName).toBe("Doctor Veg LLC")
    expect(f.returnsFiledText).toBe("Yes · 2023 2024")
    expect(f.personCompanies).toEqual([{ name: "DoctorGut LLC", status: "Active" }])
    expect(f.readFailed).toBe(false)
  })

  it("without a token it falls back to the newest form", async () => {
    db = {
      service_deliveries: [personJob(null)],
      contacts: [{ id: "c1", full_name: "P", email: null, language: null }],
      closure_submissions: [
        { token: "a", contact_id: "c1", created_at: "2026-09-01", submitted_data: { llc_name: "Newest LLC" } },
        { token: "b", contact_id: "c1", created_at: "2026-06-01", submitted_data: { llc_name: "Older LLC" } },
      ],
    }
    // the fake does not sort; the loader asks for newest-first, so the first stored row stands in for it
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpPersonFacts }).facts
    expect(f.closureCompanyName).toBe("Newest LLC")
  })

  it("a failed read says the facts are incomplete instead of showing 'none'", async () => {
    db = {
      service_deliveries: [personJob("t")],
      contacts: [{ id: "c1", full_name: "P", email: null, language: null }],
      closure_submissions: { error: "boom" },
    }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpPersonFacts }).facts
    expect(f.readFailed).toBe(true)
  })

  it("a job with no contact at all is an empty person view, not a crash", async () => {
    db = { service_deliveries: [{ ...personJob(null), contact_id: null }] }
    const f = ((await loadWrapUpFacts(JOB)) as { ok: true; facts: WrapUpPersonFacts }).facts
    expect(f).toMatchObject({ variant: "person", person: null, personCompanies: [], readFailed: false })
  })
})
