/**
 * What "Closing" does to a company (lib/operations/close-company.ts) — against a small in-memory database, so the order, the money
 * rules and the "finish twice" case are really exercised. Company Closure Part C, dev job a6bbea09.
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

import { applyCompanyClosure, readClosingBrief } from "@/lib/operations/close-company"

const ACC = "acc-1"
const JOB = "job-1"

function seed(over: Partial<Record<string, Row[]>> = {}) {
  h.state.tables = {
    accounts: [{ id: ACC, company_name: "Epsilon LLC", status: "Active", portal_account: true, portal_tier: "active" }],
    service_deliveries: [
      { id: JOB, account_id: ACC, service_type: "Company Closure", status: "active" },
      { id: "sd-ra", account_id: ACC, service_type: "State RA Renewal", status: "active" },
      { id: "sd-tax", account_id: ACC, service_type: "Tax Return", status: "on_hold" },
      { id: "sd-bank", account_id: ACC, service_type: "Banking", status: "blocked" },
      { id: "sd-done", account_id: ACC, service_type: "ITIN", status: "completed" },
      { id: "sd-other", account_id: "other-acc", service_type: "Tax Return", status: "active" },
    ],
    deadlines: [{ id: "d1", account_id: ACC, status: "Pending" }, { id: "d2", account_id: ACC, status: "Filed" }, { id: "d3", account_id: "other-acc", status: "Pending" }],
    payments: [
      { id: "p1", account_id: ACC, status: "Pending", amount: 120, amount_currency: "USD" },
      { id: "p2", account_id: ACC, status: "Overdue", amount: 80, amount_currency: "EUR" },
      { id: "p3", account_id: ACC, status: "Paid", amount: 300, amount_currency: "EUR" },
    ],
    tasks: [
      { id: "t-own", account_id: ACC, delivery_id: JOB, status: "To Do", task_title: "Company Closure card" },
      { id: "t-other", account_id: ACC, delivery_id: null, status: "In Progress", task_title: "Unrelated work" },
      { id: "t-done", account_id: ACC, delivery_id: null, status: "Done", task_title: "Already done" },
    ],
    account_contacts: [{ account_id: ACC, contact_id: "c1", ended_at: null }, { account_id: ACC, contact_id: "c2", ended_at: null }, { account_id: ACC, contact_id: "c3", ended_at: "2026-01-01" }],
    lease_agreements: [{ id: "l1", account_id: ACC, status: "signed" }],
    service_delivery_notes: [{ service_delivery_id: JOB, body: "Closure wizard: package filed. CHECK: linked to A, client wrote B." }],
    ...over,
  } as Record<string, Row[]>
  h.state.log = []
  h.state.failOn = new Set()
  h.state.deactivated = []
  h.state.tierSyncs = []
}

const idx = (needle: string) => h.state.log.findIndex((l) => l.startsWith(needle))
const tableRow = (t: string, id: string) => (h.state.tables[t] ?? []).find((r) => r.id === id)!

describe("applyCompanyClosure", () => {
  beforeEach(() => seed())

  it("closes the company and everything that goes with it, and touches nothing of another company", async () => {
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems).toEqual([])
    expect(r.alreadyClosed).toBe(false)

    // the other open services — active, ON HOLD and BLOCKED — are cancelled; a finished one and another company's are not; the job itself is not
    expect(h.state.deactivated.sort()).toEqual(["sd-bank", "sd-ra", "sd-tax"])
    expect(tableRow("service_deliveries", JOB).status).toBe("active")
    expect(tableRow("service_deliveries", "sd-done").status).toBe("completed")
    expect(tableRow("service_deliveries", "sd-other").status).toBe("active")

    expect(tableRow("deadlines", "d1").status).toBe("Cancelled")
    expect(tableRow("deadlines", "d2").status).toBe("Filed")
    expect(tableRow("deadlines", "d3").status).toBe("Pending")

    // unpaid invoices cancelled, a paid one never touched
    expect(tableRow("payments", "p1").status).toBe("Cancelled")
    expect(tableRow("payments", "p2").status).toBe("Cancelled")
    expect(tableRow("payments", "p3").status).toBe("Paid")

    // the job's own to-do is Done; unrelated work is CANCELLED, not made to look done
    expect(tableRow("tasks", "t-own").status).toBe("Done")
    expect(tableRow("tasks", "t-other").status).toBe("Cancelled")
    expect(tableRow("tasks", "t-done").status).toBe("Done")

    const acct = tableRow("accounts", ACC)
    expect(acct).toMatchObject({ status: "Closed", portal_account: false, portal_tier: "inactive" })
    expect(h.state.tierSyncs).toEqual([ACC])
  })

  it("sets the company to Closed only AFTER the clean-up steps, and recomputes the people's level after that", async () => {
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    const closeAt = idx("accounts.update")
    expect(closeAt).toBeGreaterThan(-1)
    for (const earlier of ["deactivateSD", "deadlines.update", "payments.update", "tasks.bulk"]) expect(idx(earlier), earlier).toBeLessThan(closeAt)
    expect(idx("tiers ")).toBeGreaterThan(closeAt)
  })

  it("leaves the Harbor follow-up and — because the company has a lease — the lease follow-up; never the QuickBooks or e-mail ones", async () => {
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    const cards = (h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]")).map((t) => t.task_title)
    expect(cards).toEqual(["[CLOSURE] Remove RA on Harbor Compliance", "[CLOSURE] Cancel CMRA mailing address / lease"])
    expect(r.lines.join(" | ")).toContain("Created 2 closure to-dos")
    // the follow-ups are created after the sweep, so they stay open
    expect((h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]")).every((t) => t.status === "To Do")).toBe(true)
  })

  it("a company without a lease gets only the Harbor follow-up", async () => {
    seed({ lease_agreements: [{ id: "l0", account_id: ACC, status: "draft" }] })
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect((h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]")).map((t) => t.task_title)).toEqual(["[CLOSURE] Remove RA on Harbor Compliance"])
  })

  it("finishing twice: the second run closes nothing again and creates no second set of follow-ups", async () => {
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    const cardsAfterFirst = (h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]")).length
    h.state.log = []
    const second = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(second.alreadyClosed).toBe(true)
    expect(second.problems).toEqual([])
    expect((h.state.tables.tasks ?? []).filter((t) => String(t.task_title).startsWith("[CLOSURE]")).length).toBe(cardsAfterFirst)
    expect(h.state.log.some((l) => l.startsWith("accounts.update"))).toBe(false)
    expect(h.state.tierSyncs).toEqual([ACC]) // only the first run recomputed the levels
  })

  it("an already-Closed company is only tidied: what is still open for it is cancelled, it is not closed again", async () => {
    seed()
    tableRow("accounts", ACC).status = "Closed"
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.alreadyClosed).toBe(true)
    expect(tableRow("payments", "p1").status).toBe("Cancelled")
    expect(h.state.log.some((l) => l.startsWith("accounts.update"))).toBe(false)
    expect((h.state.tables.tasks ?? []).some((t) => String(t.task_title).startsWith("[CLOSURE]"))).toBe(false)
  })

  it("a step that fails is REPORTED, does not stop the others, and the company is still closed", async () => {
    h.state.failOn.add("payments:update")
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems.join(" ")).toContain("could not cancel the company's unpaid invoices")
    expect(r.problems.join(" ")).toContain("boom payments:update")
    expect(tableRow("payments", "p1").status).toBe("Pending") // not silently reported as cancelled
    expect(tableRow("deadlines", "d1").status).toBe("Cancelled")
    expect(tableRow("accounts", ACC).status).toBe("Closed")
    expect(r.lines.join(" | ")).not.toContain("unpaid invoice")
  })

  it("when the company itself cannot be set to Closed it says so, creates no follow-ups and recomputes no levels", async () => {
    h.state.failOn.add("accounts:update")
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems.join(" ")).toContain("could NOT set the company to Closed")
    expect(r.lines.join(" | ")).not.toContain("Account → Closed")
    expect(tableRow("accounts", ACC).status).toBe("Active")
    expect(h.state.tierSyncs).toEqual([])
    expect((h.state.tables.tasks ?? []).some((t) => String(t.task_title).startsWith("[CLOSURE]"))).toBe(false)
  })

  it("a status it cannot read stops before changing anything", async () => {
    h.state.failOn.add("accounts:select")
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems.join(" ")).toContain("could not check the company's status")
    expect(h.state.log).toEqual([])
    expect(tableRow("payments", "p1").status).toBe("Pending")
  })
})

describe("readClosingBrief (the facts the question shows)", () => {
  beforeEach(() => seed())

  it("names the company and counts exactly what the closing step would cancel", async () => {
    const b = await readClosingBrief(JOB)
    expect(b).not.toBeNull()
    expect(b!.companyName).toBe("Epsilon LLC")
    expect(b!.alreadyClosed).toBe(false)
    expect(b!.openServices.map((s) => s.type).sort()).toEqual(["Banking", "State RA Renewal", "Tax Return"])
    expect(b!.pendingDeadlines).toBe(1)
    expect(b!.unpaid).toEqual({ count: 2, totals: { USD: 120, EUR: 80 } })
    expect(b!.openTasks).toBe(1) // the unrelated one; the job's own card is not counted
    expect(b!.members).toBe(2) // the person who left is not counted
    expect(b!.hasLease).toBe(true)
    expect(b!.checkNote).toBe("linked to A, client wrote B.")
  })

  it("returns nothing for a job with no company", async () => {
    seed({ service_deliveries: [{ id: JOB, account_id: null, service_type: "Company Closure", status: "active" }] })
    expect(await readClosingBrief(JOB)).toBeNull()
  })

  it("reads the fact that the company is already Closed", async () => {
    tableRow("accounts", ACC).status = "Closed"
    expect((await readClosingBrief(JOB))!.alreadyClosed).toBe(true)
  })

  it("throws on a read error instead of showing a half-empty question", async () => {
    h.state.failOn.add("payments:select")
    await expect(readClosingBrief(JOB)).rejects.toThrow(/could not read payments/)
  })
})
