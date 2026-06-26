/**
 * Unit tests for lib/jobs/ingest-complete-notify.ts
 *
 * Verifies the "statements ready" client notification:
 *  - fires ONLY when no other ingest job for the account+year is in flight
 *  - fires ONCE (idempotency marker in financials_meta.ready_notified)
 *  - skips when there is no completed submission
 *  - posts a system message in the client's locale
 *  - never throws (insert error → not notified, no exception)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Fixtures {
  otherJobs: Array<{ id: string; payload: { tax_year?: number | string } | null }>
  submission: { id: string; financials_meta: Record<string, unknown> | null } | null
  accountContacts: Array<{ contact_id: string | null; is_primary: boolean | null }>
  contactLanguage: string | null
  insertError: { message: string } | null
}
const fixtures: Fixtures = {
  otherJobs: [],
  submission: { id: "sub-1", financials_meta: null },
  accountContacts: [{ contact_id: "ctc-1", is_primary: true }],
  contactLanguage: null,
  insertError: null,
}
const inserts: Array<Record<string, unknown>> = []
const updates: Array<{ table: string; payload: Record<string, unknown> }> = []

function resolveFor(table: string, op: "select" | "insert" | "update") {
  if (table === "job_queue") return { data: fixtures.otherJobs, error: null }
  if (table === "tax_return_submissions") {
    if (op === "update") return { data: null, error: null }
    return { data: fixtures.submission, error: null }
  }
  if (table === "account_contacts") return { data: fixtures.accountContacts, error: null }
  if (table === "contacts") return { data: { language: fixtures.contactLanguage }, error: null }
  if (table === "portal_messages") return { data: null, error: fixtures.insertError }
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
  b.insert = (payload: Record<string, unknown>) => {
    state.op = "insert"
    if (table === "portal_messages") inserts.push(payload)
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

import { notifyIfIngestComplete } from "@/lib/jobs/ingest-complete-notify"

beforeEach(() => {
  fixtures.otherJobs = []
  fixtures.submission = { id: "sub-1", financials_meta: null }
  fixtures.accountContacts = [{ contact_id: "ctc-1", is_primary: true }]
  fixtures.contactLanguage = null
  fixtures.insertError = null
  inserts.length = 0
  updates.length = 0
})

describe("notifyIfIngestComplete", () => {
  it("notifies (and marks) when this is the last ingest job for the year", async () => {
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(true)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].sender_type).toBe("system")
    expect(String(inserts[0].message)).toContain("/portal/tax-financials")
    // idempotency marker written back
    expect(updates.some(u => u.table === "tax_return_submissions" && (u.payload.financials_meta as Record<string, unknown>).ready_notified === true)).toBe(true)
  })

  it("does NOT notify when another ingest job for the same year is still in flight", async () => {
    fixtures.otherJobs = [{ id: "job-other", payload: { tax_year: 2025 } }]
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("more_pending")
    expect(inserts).toHaveLength(0)
  })

  it("ignores in-flight jobs that belong to a DIFFERENT tax year", async () => {
    fixtures.otherJobs = [{ id: "job-other", payload: { tax_year: 2024 } }]
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(true)
    expect(inserts).toHaveLength(1)
  })

  it("does not re-notify once the marker is set", async () => {
    fixtures.submission = { id: "sub-1", financials_meta: { ready_notified: true } }
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("already_notified")
    expect(inserts).toHaveLength(0)
  })

  it("skips when there is no completed submission to attach to", async () => {
    fixtures.submission = null
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("no_submission")
  })

  it("uses Italian copy when the client's language is Italian", async () => {
    fixtures.contactLanguage = "Italian"
    await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(String(inserts[0].message)).toContain("Buone notizie")
  })

  it("never throws and reports insert failure", async () => {
    fixtures.insertError = { message: "boom" }
    const res = await notifyIfIngestComplete({ accountId: "acct-1", taxYear: 2025, selfJobId: "job-self" })
    expect(res.notified).toBe(false)
    expect(res.reason).toBe("insert_failed")
  })
})
