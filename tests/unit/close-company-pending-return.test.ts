/**
 * Dev job 0a60f416, part C — a Tax Return still to be filed HOLDS a company's closing (Antonio's rule: choice B of 2026-10-15, and Carasso). Same small in-memory
 * database as close-company.test.ts, with the one extra filter the new code uses (`not ... ilike`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    log: [] as string[],
    failOn: new Set<string>(),
    deactivated: [] as string[],
    tierSyncs: [] as string[],
    logged: [] as Array<Record<string, unknown>>,
  }
  function from(table: string) {
    const q = { op: "select" as "select" | "update" | "insert", patch: {} as Row, rows: [] as Row[], filters: [] as Array<(r: Row) => boolean>, head: false, count: false }
    const rowsOf = () => (state.tables[table] ??= [])
    const matches = () => rowsOf().filter((r) => q.filters.every((f) => f(r)))
    function exec(single: boolean) {
      const key = `${table}:${q.op}`
      if (state.failOn.has(key)) return Promise.resolve({ data: null, error: { message: `boom ${key}` }, count: null })
      if (q.op === "insert") {
        for (const r of q.rows) rowsOf().push({ ...r })
        state.log.push(`${table}.insert x${q.rows.length}`)
        return Promise.resolve({ data: q.rows, error: null, count: null })
      }
      const hit = matches()
      if (q.op === "update") {
        for (const r of hit) Object.assign(r, q.patch)
        state.log.push(`${table}.update ${JSON.stringify(q.patch)} x${hit.length}`)
        return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null, count: hit.length })
      }
      if (q.head) return Promise.resolve({ data: null, error: null, count: hit.length })
      const data = hit.map((r) => ({ ...r }))
      return Promise.resolve({ data: single ? (data[0] ?? null) : data, error: null, count: q.count ? hit.length : null })
    }
    const api: Record<string, unknown> = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) q.head = true; if (opts?.count) q.count = true; return api },
      update(patch: Row) { q.op = "update"; q.patch = patch; return api },
      insert(rows: Row | Row[]) { q.op = "insert"; q.rows = Array.isArray(rows) ? rows : [rows]; return api },
      eq(c: string, v: unknown) { q.filters.push((r) => r[c] === v); return api },
      neq(c: string, v: unknown) { q.filters.push((r) => r[c] !== v); return api },
      not(c: string, op: string, pat: string) { const n = pat.replace(/%/g, "").toLowerCase(); if (op === "ilike") q.filters.push((r) => !String(r[c] ?? "").toLowerCase().includes(n)); return api },
      in(c: string, vs: unknown[]) { q.filters.push((r) => vs.includes(r[c])); return api },
      is(c: string, v: unknown) { q.filters.push((r) => (r[c] ?? null) === v); return api },
      ilike(c: string, pat: string) { const n = pat.replace(/%/g, "").toLowerCase(); q.filters.push((r) => String(r[c] ?? "").toLowerCase().includes(n)); return api },
      order() { return api },
      limit() { return api },
      maybeSingle() { return exec(true) },
      single() { return exec(true) },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return exec(false).then(res, rej) },
    }
    return api
  }
  return { state, from }
})

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => h.from(t) } }))
vi.mock("@/lib/operations/service-delivery", () => ({
  deactivateSD: vi.fn(async (p: { delivery_id: string }) => {
    h.state.deactivated.push(p.delivery_id)
    const sd = (h.state.tables.service_deliveries ?? []).find((r) => r.id === p.delivery_id)
    if (sd) sd.status = "cancelled"
    h.state.log.push(`deactivateSD ${p.delivery_id}`)
    return { success: true, outcome: "deactivated", delivery_id: p.delivery_id }
  }),
}))
vi.mock("@/lib/operations/task", () => ({
  updateTasksBulk: vi.fn(async (p: { ids: string[]; patch: Row }) => {
    for (const r of h.state.tables.tasks ?? []) if (p.ids.includes(r.id as string)) Object.assign(r, p.patch)
    h.state.log.push(`tasks.bulk ${JSON.stringify(p.patch)} x${p.ids.length}`)
    return { success: true, outcome: "updated" }
  }),
}))
vi.mock("@/lib/operations/sync-tier", () => ({
  syncContactTiersForAccount: vi.fn(async (accountId: string) => {
    h.state.tierSyncs.push(accountId)
    h.state.log.push(`tiers ${accountId}`)
    return []
  }),
}))

vi.mock("@/lib/portal/td-invoice", () => ({
  syncTDInvoiceStatus: vi.fn(async (id: string, status: string) => {
    if (h.state.failOn.has("mirror:status")) throw new Error("boom mirror:status")
    h.state.log.push(`mirror.status ${id} ${status}`)
  }),
}))
vi.mock("@/lib/portal/td-invoice-mirror", () => ({
  syncTDInvoiceMirror: vi.fn(async (id: string) => {
    h.state.log.push(`mirror.sync ${id}`)
    return { changed: true }
  }),
}))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn((p: Record<string, unknown>) => { h.state.logged.push(p) }) }))

import { applyCompanyClosure, completePendingCompanyClosure, readClosingBrief } from "@/lib/operations/close-company"

const ACC = "acc-1"
const JOB = "job-1"
const TOKEN = "carasso-2026"

function seed(over: Partial<Record<string, Row[]>> = {}) {
  h.state.tables = {
    accounts: [{ id: ACC, company_name: "Carasso LLC", status: "Active", portal_account: true, portal_tier: "active" }],
    service_deliveries: [
      { id: JOB, account_id: ACC, service_type: "Company Closure", status: "active" },
      { id: "sd-ra", account_id: ACC, service_type: "State RA Renewal", status: "active" },
      { id: "sd-tax", account_id: ACC, service_type: "Tax Return", status: "active", service_name: "Tax Return 2026 - Carasso LLC", source_offer_token: TOKEN },
    ],
    deadlines: [
      { id: "d-tax", account_id: ACC, status: "Pending", deadline_type: "Tax Filing" },
      { id: "d-ar", account_id: ACC, status: "Pending", deadline_type: "Annual Report" },
    ],
    payments: [
      { id: "p-part", account_id: ACC, status: "Pending", invoice_status: "Draft", invoice_number: "INV-000010", amount: 600, amount_due: 600, amount_paid: 0, amount_currency: "USD", tranche_offer_token: TOKEN },
      { id: "p-other", account_id: ACC, status: "Pending", invoice_status: "Draft", invoice_number: "INV-000011", amount: 120, amount_due: 120, amount_paid: 0, amount_currency: "USD", tranche_offer_token: null },
    ],
    tasks: [
      { id: "t-own", account_id: ACC, delivery_id: JOB, status: "To Do", task_title: "Company Closure card" },
      { id: "t-tax", account_id: ACC, delivery_id: "sd-tax", status: "To Do", task_title: "Tax Return" },
      { id: "t-other", account_id: ACC, delivery_id: null, status: "In Progress", task_title: "Unrelated work" },
    ],
    account_contacts: [{ account_id: ACC, contact_id: "c1", ended_at: null }],
    lease_agreements: [{ id: "l1", account_id: ACC, status: "signed" }],
    service_delivery_notes: [],
    ...over,
  } as Record<string, Row[]>
  h.state.log = []
  h.state.failOn = new Set()
  h.state.deactivated = []
  h.state.tierSyncs = []
  h.state.logged = []
}

const tableRow = (t: string, id: string) => (h.state.tables[t] ?? []).find((r) => r.id === id)!
const notes = () => (h.state.tables.service_delivery_notes ?? []).filter((n) => String(n.body).includes("CLOSING WAITS"))
const followUps = () => (h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]"))

describe("a Tax Return still to be filed holds the closing", () => {
  beforeEach(() => seed())

  it("keeps the tax return, its tax deadline, its to-do and the unpaid invoice of its offer; does the rest; leaves the company open with the portal on", async () => {
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems).toEqual([])
    expect(r.waiting).toBe(true)

    // only the renewal is cancelled — the tax return stays open
    expect(h.state.deactivated).toEqual(["sd-ra"])
    expect(tableRow("service_deliveries", "sd-tax").status).toBe("active")

    // the tax deadline stays, the other deadline is cancelled
    expect(tableRow("deadlines", "d-tax").status).toBe("Pending")
    expect(tableRow("deadlines", "d-ar").status).toBe("Cancelled")

    // the invoice of the tax return's offer stays; an unrelated unpaid invoice is cancelled as before
    expect(tableRow("payments", "p-part").status).toBe("Pending")
    expect(tableRow("payments", "p-other").status).toBe("Cancelled")

    // the return's own to-do stays; unrelated work is cancelled; the job's own is done
    expect(tableRow("tasks", "t-tax").status).toBe("To Do")
    expect(tableRow("tasks", "t-other").status).toBe("Cancelled")
    expect(tableRow("tasks", "t-own").status).toBe("Done")

    // the company is NOT closed and the portal stays on; nobody's portal level is recomputed
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Active", portal_account: true, portal_tier: "active" })
    expect(h.state.tierSyncs).toEqual([])
    expect(r.lines.join(" | ")).toMatch(/stays open \(portal on\) until Tax Return 2026 is filed/)
    expect(r.lines.join(" | ")).toMatch(/1 unpaid invoice of the tax return's offer stays open/)
  })

  it("leaves one marker note on the closure job and creates the closure's own follow-up to-dos — and a second finish adds neither again", async () => {
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(notes()).toHaveLength(1)
    expect(notes()[0].service_delivery_id).toBe(JOB)
    const created = followUps().length
    expect(created).toBeGreaterThan(0) // the lease to cancel (and the registered agent) — about the job, not the company's status

    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(notes()).toHaveLength(1)
    expect(followUps()).toHaveLength(created)
  })

  it("a read error while looking for the tax return stops everything — nothing is changed", async () => {
    h.state.failOn.add("service_deliveries:select")
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems.join(" ")).toMatch(/could not check for an open tax return/)
    expect(r.problems.join(" ")).toMatch(/nothing was changed/)
    expect(tableRow("accounts", ACC).status).toBe("Active")
    expect(tableRow("payments", "p-other").status).toBe("Pending")
  })

  it("a company with NO open tax return closes exactly as before", async () => {
    seed({ service_deliveries: [{ id: JOB, account_id: ACC, service_type: "Company Closure", status: "active" }] })
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.waiting).toBe(false)
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Closed", portal_account: false, portal_tier: "inactive" })
    expect(notes()).toHaveLength(0)
    expect(tableRow("payments", "p-part").status).toBe("Cancelled")
  })

  it("a FINISHED tax return does not hold the closing", async () => {
    seed()
    tableRow("service_deliveries", "sd-tax").status = "completed"
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.waiting).toBe(false)
    expect(tableRow("accounts", ACC).status).toBe("Closed")
  })

  it("a company that is already Closed is only tidied — an open tax return is cancelled as before, nothing waits", async () => {
    seed()
    tableRow("accounts", ACC).status = "Closed"
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.waiting).toBe(false)
    expect(h.state.deactivated.sort()).toEqual(["sd-ra", "sd-tax"])
  })
})

describe("completePendingCompanyClosure — when the final tax return is done", () => {
  beforeEach(() => seed())

  const hold = async () => { await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false }) }

  it("closes the company, turns the portal off, and does not create the follow-up to-dos a second time", async () => {
    await hold()
    const followUpsBefore = followUps().length
    tableRow("service_deliveries", "sd-tax").status = "completed" // TR Filed
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.lines[0]).toMatch(/final tax return is done/)
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Closed", portal_account: false, portal_tier: "inactive" })
    expect(h.state.tierSyncs).toEqual([ACC])
    expect(followUps()).toHaveLength(followUpsBefore)
    // the unpaid part of the filed return's offer is REPORTED, never cancelled behind staff's back (the unrelated one was cancelled when the job finished)
    expect(tableRow("payments", "p-part").status).toBe("Pending")
    expect(r.problems.join(" ")).toMatch(/INV-000010.*still unpaid.*NOT cancelled/)
  })

  it("closes the company when the tax return is cancelled by hand too", async () => {
    await hold()
    tableRow("service_deliveries", "sd-tax").status = "cancelled"
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.problems).toHaveLength(1) // only the still-unpaid part of the offer, reported
    expect(r.problems[0]).toMatch(/still unpaid/)
    expect(tableRow("accounts", ACC).status).toBe("Closed")
  })

  it("keeps waiting while ANOTHER tax return of the company is still open", async () => {
    await hold()
    h.state.tables.service_deliveries.push({ id: "sd-tax-2", account_id: ACC, service_type: "Tax Return", status: "on_hold", service_name: "Tax Return 2027 - Carasso LLC" })
    tableRow("service_deliveries", "sd-tax").status = "completed"
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.waiting).toBe(true)
    expect(r.lines.join(" ")).toMatch(/still waiting for Tax Return 2027/)
    expect(tableRow("accounts", ACC).status).toBe("Active")
  })

  it("does NOTHING for a company nobody asked to wait — a tax return finishing in normal life closes nothing", async () => {
    // a closure job exists (e.g. finished with "skip company close") but left no marker
    tableRow("service_deliveries", "sd-tax").status = "completed"
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r).toMatchObject({ waiting: false, lines: [], problems: [] })
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Active", portal_account: true })
  })

  it("does nothing for a company that has no closure job at all", async () => {
    seed({ service_deliveries: [{ id: "sd-tax", account_id: ACC, service_type: "Tax Return", status: "completed" }] })
    expect(await completePendingCompanyClosure({ accountId: ACC })).toMatchObject({ lines: [], problems: [] })
    expect(tableRow("accounts", ACC).status).toBe("Active")
  })

  it("is idempotent: a second call on a company that is already Closed does nothing", async () => {
    await hold()
    tableRow("service_deliveries", "sd-tax").status = "completed"
    await completePendingCompanyClosure({ accountId: ACC })
    const logLength = h.state.log.length
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.lines).toEqual([])
    expect(h.state.log).toHaveLength(logLength)
  })

  it("a read error is reported, never thrown, and changes nothing", async () => {
    await hold()
    tableRow("service_deliveries", "sd-tax").status = "completed"
    h.state.failOn.add("accounts:select")
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.problems.join(" ")).toMatch(/could not complete the company's closing/)
    expect(tableRow("accounts", ACC).status).toBe("Active")
  })
})

describe("the ask-first question tells the truth about a held closing", () => {
  beforeEach(() => seed())
  it("lists the tax return as kept, not as cancelled, and leaves its invoice out of the unpaid count", async () => {
    const b = await readClosingBrief(JOB)
    expect(b!.keptReturns).toEqual(["Tax Return 2026"])
    expect(b!.openServices.map((s) => s.type)).toEqual(["State RA Renewal"])
    expect(b!.unpaid.count).toBe(1) // only the unrelated invoice
    expect(b!.openTasks).toBe(1) // the return's own to-do is not counted
  })
})
