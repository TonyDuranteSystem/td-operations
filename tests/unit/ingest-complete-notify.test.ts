/**
 * Unit tests for lib/jobs/ingest-complete-notify.ts
 *
 * Verifies the "statements ready" client notification:
 *  - fires ONLY when no other ingest job for the account+year is in flight
 *  - fires ONCE (idempotency marker in financials_meta.ready_notified)
 *  - skips when there is no completed submission
 *  - delegates to the shared action-required dispatch (Phase C 2026-07-02:
 *    chat + immediate email + bell/push; locale + deep link are the helper's
 *    job — see tests/unit/action-required.test.ts)
 *  - never throws (dispatch failure → not notified, no exception)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Fixtures {
  otherJobs: Array<{ id: string; payload: { tax_year?: number | string } | null }>
  submission: { id: string; financials_meta: Record<string, unknown> | null } | null
  dispatchResult: { dispatched: boolean; chat: string; notification: string; email: string }
}
const fixtures: Fixtures = {
  otherJobs: [],
  submission: { id: "sub-1", financials_meta: null },
  dispatchResult: { dispatched: true, chat: "ok", notification: "ok", email: "ok (1 sent)" },
}
const dispatches: Array<Record<string, unknown>> = []
const updates: Array<{ table: string; payload: Record<string, unknown> }> = []

function resolveFor(table: string, op: "select" | "insert" | "update") {
  if (table === "job_queue") return { data: fixtures.otherJobs, error: null }
  if (table === "tax_return_submissions") {
    if (op === "update") return { data: null, error: null }
    return { data: fixtures.submission, error: null }
  }
  return { data: null, error: null }
}

function makeBuilder(table: string) {
  const state: { table: string; op: "select" | "insert" | "update" } = { table, op: "select" }
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.in = chain
  b.neq = chain
  b.order = chain
  b.limit = chain
  b.update = (payload: Record<string, unknown>) => {
    state.op = "update"
    updates.push({ table, payload })
    return b
  }
  b.insert = () => {
    state.op = "insert"
    return b
  }
  b.maybeSingle = async () => resolveFor(state.table, state.op)
  b.single = async () => resolveFor(state.table, state.op)
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolveFor(state.table, state.op)).then(onFulfilled)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))
vi.mock("@/lib/portal/action-required", () => ({
  notifyClientActionRequired: vi.fn(async (params: Record<string, unknown>) => {
    dispatches.push(params)
    return fixtures.dispatchResult
  }),
}))

import { notifyIfIngestComplete } from "@/lib/jobs/ingest-complete-notify"

beforeEach(() => {
  fixtures.otherJobs = []
  fixtures.submission = { id: "sub-1", financials_meta: null }
  fixtures.dispatchResult = { dispatched: true, chat: "ok", notification: "ok", email: "ok (1 sent)" }
  dispatches.length = 0
  updates.length = 0
})

describe("notifyIfIngestComplete", () => {
  it("notifies (and marks) when this is the last ingest job for the year", async () => {
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(true)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].account_id).toBe("acct-1")
    expect(dispatches[0].link).toBe("/portal/tax-financials")
    const msg = dispatches[0].message as { en: string; it: string }
    expect(msg.en).toContain("bank statements")
    expect(msg.it).toContain("Buone notizie")
    // idempotency marker written back
    expect(updates.some(u => u.table === "tax_return_submissions" && (u.payload.financials_meta as Record<string, unknown>).ready_notified === true)).toBe(true)
  })

  it("does NOT notify when another ingest job for the same year is still in flight", async () => {
    fixtures.otherJobs = [{ id: "job-other", payload: { tax_year: 2025 } }]
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("more_pending")
    expect(dispatches).toHaveLength(0)
  })

  it("ignores in-flight jobs that belong to a DIFFERENT tax year", async () => {
    fixtures.otherJobs = [{ id: "job-other", payload: { tax_year: 2024 } }]
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(true)
    expect(dispatches).toHaveLength(1)
  })

  it("does not re-notify once the marker is set", async () => {
    fixtures.submission = { id: "sub-1", financials_meta: { ready_notified: true } }
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("already_notified")
    expect(dispatches).toHaveLength(0)
  })

  it("skips when there is no completed submission to attach to", async () => {
    fixtures.submission = null
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("no_submission")
  })

  it("never throws and reports a total dispatch failure", async () => {
    fixtures.dispatchResult = { dispatched: false, chat: "failed: boom", notification: "failed: boom", email: "failed: boom" }
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("insert_failed")
  })

  it("still notifies when only one channel fails (partial success)", async () => {
    fixtures.dispatchResult = { dispatched: true, chat: "failed: boom", notification: "ok", email: "ok (1 sent)" }
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(true)
  })
})
