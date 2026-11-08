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
      { id: "p1", account_id: ACC, status: "Pending", invoice_status: "Draft", invoice_number: "INV-000001", amount: 120, amount_due: 120, amount_paid: 0, amount_currency: "USD", idempotency_key: "k1" },
      { id: "p2", account_id: ACC, status: "Overdue", invoice_status: "Sent", invoice_number: "INV-000002", amount: 80, amount_due: 80, amount_paid: 0, amount_currency: "EUR", idempotency_key: "k2" },
      { id: "p3", account_id: ACC, status: "Paid", invoice_status: "Paid", amount: 300, amount_due: 0, amount_paid: 300, amount_currency: "EUR" },
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
  h.state.logged = []
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
    expect(r.problems.join(" ")).toContain("could not cancel invoice INV-000001")
    expect(r.problems.join(" ")).toContain("boom payments:update")
    expect(tableRow("payments", "p1").status).toBe("Pending") // not silently reported as cancelled
    expect(tableRow("deadlines", "d1").status).toBe("Cancelled")
    expect(tableRow("accounts", ACC).status).toBe("Closed")
    expect(r.lines.join(" | ")).not.toContain("unpaid invoice")
  })

  it("cancels an unpaid invoice the way Finance's Void does: both status columns, the numbering slot freed, the client's copy rebuilt, the before-state recorded", async () => {
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.problems).toEqual([])
    for (const id of ["p1", "p2"]) {
      expect(tableRow("payments", id)).toMatchObject({ status: "Cancelled", invoice_status: "Cancelled", idempotency_key: null })
      expect(h.state.log).toContain(`mirror.status ${id} Cancelled`)
      expect(h.state.log).toContain(`mirror.sync ${id}`)
    }
    // a paid invoice is not touched, and its client copy is not rebuilt
    expect(tableRow("payments", "p3")).toMatchObject({ status: "Paid", invoice_status: "Paid" })
    expect(h.state.log).not.toContain("mirror.sync p3")
    // "Reactivate" in Finance reads pre_void_state back from the action log
    const p1 = h.state.logged.find((l) => l.record_id === "p1")
    expect(p1).toMatchObject({ table_name: "payments", details: { pre_void_state: { status: "Pending", invoice_status: "Draft", amount_due: 120, amount_paid: 0 } } })
  })

  it("a credit note is not voided like an invoice, even if it carries an open status", async () => {
    tableRow("payments", "p2").invoice_status = "Credit"
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(tableRow("payments", "p2")).toMatchObject({ status: "Overdue", invoice_status: "Credit" })
    expect(h.state.log).not.toContain("mirror.sync p2")
  })

  it("a PART-PAID invoice is NOT cancelled (the money received would sit on a cancelled invoice) — it stays open and is reported with its amounts; the plain unpaid one is cancelled", async () => {
    Object.assign(tableRow("payments", "p2"), { amount_paid: 30, amount_due: 50 }) // 80 EUR invoice, 30 received
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(tableRow("payments", "p2")).toMatchObject({ status: "Overdue", invoice_status: "Sent", amount_paid: 30 })
    expect(h.state.log).not.toContain("mirror.sync p2")
    expect(r.problems.join(" ")).toContain("invoice INV-000002 is part-paid (30 EUR received, 50 EUR still owed) — it was NOT cancelled: settle or refund it by hand")
    expect(tableRow("payments", "p1")).toMatchObject({ status: "Cancelled", invoice_status: "Cancelled" })
    expect(r.lines.join(" ")).toContain("Cancelled 1 unpaid invoice (120 USD)")
  })

  it("an unused credit note is left on the account and the result says so (not an error)", async () => {
    Object.assign(tableRow("payments", "p2"), { invoice_status: "Credit", amount: -25, amount_due: 0 })
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(tableRow("payments", "p2")).toMatchObject({ status: "Overdue", invoice_status: "Credit" })
    expect(r.problems).toEqual([])
    expect(r.lines.join(" ")).toContain("1 unused credit note stays on the account")
  })

  it("an invoice whose client copy could not be updated stays cancelled, and says so", async () => {
    h.state.failOn.add("mirror:status")
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(tableRow("payments", "p1")).toMatchObject({ status: "Cancelled", invoice_status: "Cancelled" })
    expect(r.problems.join(" ")).toContain("INV-000001 is cancelled but the client's copy of it could not be updated")
  })

  it("an unconfirmed bank-feed suggestion no longer points at a cancelled invoice; a confirmed match is left alone", async () => {
    seed({ td_bank_feeds: [{ id: "f1", matched_payment_id: "p1", status: "suggested", match_confidence: 0.6 }, { id: "f2", matched_payment_id: "p2", status: "matched", match_confidence: 1 }] })
    await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(tableRow("td_bank_feeds", "f1")).toMatchObject({ matched_payment_id: null, match_confidence: null })
    expect(tableRow("td_bank_feeds", "f2")).toMatchObject({ matched_payment_id: "p2", status: "matched" })
  })

  it("finishing again after a Go Back does NOT tick the open Harbor follow-up Done — it is real work nobody did yet", async () => {
    seed({
      tasks: [
        { id: "t-harbor", account_id: ACC, delivery_id: JOB, status: "To Do", task_title: "[CLOSURE] Remove RA on Harbor Compliance" },
        { id: "t-own", account_id: ACC, delivery_id: JOB, status: "To Do", task_title: "Company Closure card" },
      ],
    })
    tableRow("accounts", ACC).status = "Closed"
    const r = await applyCompanyClosure({ accountId: ACC, deliveryId: JOB, wrapUpStepExists: false })
    expect(r.alreadyClosed).toBe(true)
    expect(tableRow("tasks", "t-harbor").status).toBe("To Do")
    expect(tableRow("tasks", "t-own").status).toBe("Done")
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

  it("does not count a part-paid invoice or a credit note as 'unpaid invoices': the question sums what is still OWED and lists the others apart", async () => {
    Object.assign(tableRow("payments", "p1"), { amount_paid: 20, amount_due: 100 }) // 120 USD, 20 received
    Object.assign(tableRow("payments", "p2"), { invoice_status: "Credit", amount: -25, amount_due: 0 }) // an unused 25 EUR credit
    h.state.tables.payments.push({ id: "p4", account_id: ACC, status: "Pending", invoice_status: "Draft", invoice_number: "INV-000004", amount: 40, amount_due: 40, amount_paid: 0, amount_currency: "USD" })
    const b = await readClosingBrief(JOB)
    expect(b!.unpaid).toEqual({ count: 1, totals: { USD: 40 } })
    expect(b!.partPaid).toEqual([{ invoice: "INV-000001", paid: 20, owed: 100, currency: "USD" }])
    expect(b!.credits).toEqual({ count: 1, totals: { EUR: 25 } })
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
