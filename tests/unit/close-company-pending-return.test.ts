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
    onInsert: null as null | ((table: string) => void),
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
        state.onInsert?.(table)
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
      not(c: string, op: string, v: unknown) {
        if (op === "ilike") { const n = String(v).replace(/%/g, "").toLowerCase(); q.filters.push((r) => !String(r[c] ?? "").toLowerCase().includes(n)) }
        else if (op === "is") q.filters.push((r) => (r[c] ?? null) !== v)
        return api
      },
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

import { applyCompanyClosure, completePendingCompanyClosure, endClosingWait, readClosingBrief } from "@/lib/operations/close-company"

const ACC = "acc-1"
const JOB = "job-1"
const TOKEN = "carasso-2026"

function seed(over: Partial<Record<string, Row[]>> = {}) {
  h.state.tables = {
    accounts: [{ id: ACC, company_name: "Carasso LLC", status: "Active", portal_account: true, portal_tier: "active" }],
    service_deliveries: [
      { id: JOB, account_id: ACC, service_type: "Company Closure", status: "completed", stage: "Closing" },
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
  h.state.onInsert = null
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
    seed({ service_deliveries: [{ id: JOB, account_id: ACC, service_type: "Company Closure", status: "completed", stage: "Closing" }] })
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

describe("the wait is never just 'a note exists' (bug hunt 2026-11-19)", () => {
  beforeEach(() => seed())
  const hold = async () => { await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false }) }
  const fileTheReturn = () => { tableRow("service_deliveries", "sd-tax").status = "completed" }

  it("Go Back from Closing ends the wait: the return being filed later closes nothing, and the nightly jobs stop skipping the company", async () => {
    await hold()
    Object.assign(tableRow("service_deliveries", JOB), { status: "active", stage: "IRS Closure" }) // revertServiceDelivery
    fileTheReturn()
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r).toMatchObject({ waiting: false, lines: [], problems: [] })
    expect(tableRow("accounts", ACC).status).toBe("Active")
    const { findWaitingClosures } = await import("@/lib/closure/closing-wait")
    expect(await findWaitingClosures()).toEqual([])
  })

  it("a cancelled closure job ends the wait too", async () => {
    await hold()
    tableRow("service_deliveries", JOB).status = "cancelled"
    fileTheReturn()
    expect(await completePendingCompanyClosure({ accountId: ACC })).toMatchObject({ lines: [], problems: [] })
    expect(tableRow("accounts", ACC).status).toBe("Active")
  })

  it("finishing again WITHOUT closing (skip company close) ends the wait with a note — the explicit choice is never undone by the return", async () => {
    await hold()
    expect(await endClosingWait(JOB, "the job was finished without closing the company")).toBe(true)
    expect((h.state.tables.service_delivery_notes ?? []).some((n) => String(n.body).includes("CLOSING WAIT ENDED"))).toBe(true)
    fileTheReturn()
    expect(await completePendingCompanyClosure({ accountId: ACC })).toMatchObject({ lines: [], problems: [] })
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Active", portal_account: true })
  })

  it("ending a wait that does not exist writes nothing", async () => {
    expect(await endClosingWait(JOB, "x")).toBe(false)
    expect(notes()).toHaveLength(0)
  })

  it("a company brought back to Active after its closing is NOT closed again by a later tax return", async () => {
    await hold()
    fileTheReturn()
    await completePendingCompanyClosure({ accountId: ACC }) // closes it and ends the wait
    expect(tableRow("accounts", ACC).status).toBe("Closed")
    // reactivated, and a later Tax Return is filed
    tableRow("accounts", ACC).status = "Active"
    h.state.tables.service_deliveries.push({ id: "sd-tax-2027", account_id: ACC, service_type: "Tax Return", status: "completed", service_name: "Tax Return 2027 - Carasso LLC" })
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r).toMatchObject({ lines: [], problems: [] })
    expect(tableRow("accounts", ACC).status).toBe("Active")
    const { findWaitingClosures } = await import("@/lib/closure/closing-wait")
    expect(await findWaitingClosures()).toEqual([])
  })

  it("a wait that ended can start again: the newest note wins", async () => {
    await hold()
    await endClosingWait(JOB, "the job was finished without closing the company")
    await hold() // finished at Closing again, with the return still open
    const { findWaitingClosures } = await import("@/lib/closure/closing-wait")
    expect(await findWaitingClosures()).toEqual([{ accountId: ACC, closureJobId: JOB }])
  })

  it("a Tax Return parked at 'Terminated - Non Payment' is a dead end, not a return being worked on: it does not hold the closing", async () => {
    Object.assign(tableRow("service_deliveries", "sd-tax"), { stage: "Terminated - Non Payment", status: "active" })
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.waiting).toBe(false)
    expect(tableRow("accounts", ACC).status).toBe("Closed")
    expect(h.state.deactivated).toContain("sd-tax")
  })

  it("the return was filed WHILE the closing ran: the company is closed right there instead of waiting forever", async () => {
    // after the waiting note is written, the return reaches TR Filed (its completion hook found no note and did nothing)
    h.state.onInsert = (table) => { if (table === "service_delivery_notes") { tableRow("service_deliveries", "sd-tax").status = "completed"; h.state.onInsert = null } }
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.waiting).toBe(false)
    expect(tableRow("accounts", ACC)).toMatchObject({ status: "Closed", portal_tier: "inactive" })
    expect(followUps().length).toBeGreaterThan(0) // the job's own follow-up to-dos were still created, once
  })

  it("a problem while completing is written on the closure job too, where staff look — not only returned", async () => {
    await hold()
    fileTheReturn()
    const r = await completePendingCompanyClosure({ accountId: ACC })
    expect(r.problems.join(" ")).toMatch(/INV-000010.*still unpaid/)
    const problemNotes = (h.state.tables.service_delivery_notes ?? []).filter((n) => String(n.body).startsWith("CLOSURE PROBLEM"))
    expect(problemNotes).toHaveLength(1)
    expect(problemNotes[0].service_delivery_id).toBe(JOB)
  })

  it("the nightly sweep's view: a waiting company with no open return left is found and then completed", async () => {
    await hold()
    fileTheReturn()
    const { findWaitingClosures } = await import("@/lib/closure/closing-wait")
    const waiting = await findWaitingClosures()
    expect(waiting).toEqual([{ accountId: ACC, closureJobId: JOB }])
    await completePendingCompanyClosure({ accountId: waiting[0].accountId })
    expect(tableRow("accounts", ACC).status).toBe("Closed")
    expect(await findWaitingClosures()).toEqual([])
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
    expect(b!.pendingDeadlines).toBe(1) // the return's own tax deadline is not counted as cancelled
  })

  it("a company that is ALREADY Closed is only tidied, so nothing is promised as kept (the step cancels the return and its invoices)", async () => {
    tableRow("accounts", ACC).status = "Closed"
    const b = await readClosingBrief(JOB)
    expect(b!.alreadyClosed).toBe(true)
    expect(b!.keptReturns).toEqual([])
    expect(b!.openServices.map((s) => s.type).sort()).toEqual(["State RA Renewal", "Tax Return"])
    expect(b!.unpaid.count).toBe(2)
  })
})
