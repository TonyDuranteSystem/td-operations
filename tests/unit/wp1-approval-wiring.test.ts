/**
 * Hermes ↔ Claude bridge — WP1: approval confirmation code + Operating-Agent pull rail.
 *
 * Pins the WP1 contract:
 *   - approval_decide(approve) REQUIRES the row's 6-digit confirmation_code;
 *     wrong/missing code never moves the row. reject needs no code.
 *   - proposeAction mints a 6-digit code; the proposal formatter surfaces it.
 *   - hermes_heartbeat upserts a hermes_instances liveness row.
 *   - approval_claim atomically claims the oldest approved+unclaimed row
 *     (approved→executing), re-checks params integrity, or returns nothing.
 *   - approval_complete finalizes only a row still in 'executing' (idempotent),
 *     stamps executed_by from claimed_by, and emits the outcome notification.
 *
 * The notification graph (emitApprovalOutcome / sendApprovalNotification) is
 * mocked so these tests isolate the queue/decision/claim logic from the CRM +
 * agent_messages write path (that path is covered by approval-notifications.test).
 */

import { createHash } from "crypto"
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Stateful in-memory Supabase stand-in ─────────────────────────────────────
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables: Record<string, any[]> = { approval_queue: [], hermes_instances: [] }
  return { tables }
})

vi.mock("@/lib/supabase-admin", () => {
  // A minimal chainable query builder supporting the shapes WP1 uses:
  //   select / insert / update / upsert, eq, is, order, limit, maybeSingle,
  //   single, and direct await (thenable).
  function builder(table: string) {
    const state: {
      op: "select" | "insert" | "update" | "upsert"
      cols?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload?: any
      onConflict?: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eqs: Array<[string, any]>
      isNulls: string[]
      order?: { col: string; asc: boolean }
      limit?: number
    } = { op: "select", eqs: [], isNulls: [] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = () => (h.tables[table] ??= [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (r: any) =>
      state.eqs.every(([k, v]) => r[k] === v) &&
      state.isNulls.every((k) => r[k] === null || r[k] === undefined)

    function run(): { data: unknown; error: null } {
      if (state.op === "insert") {
        const row = { ...state.payload }
        if (!("created_at" in row)) row.created_at = new Date().toISOString()
        if (!("id" in row)) row.id = `id-${store().length + 1}`
        store().push(row)
        return { data: row, error: null }
      }
      if (state.op === "upsert") {
        const key = state.onConflict ?? "id"
        const existing = store().find((r) => r[key] === state.payload[key])
        if (existing) {
          Object.assign(existing, state.payload)
          return { data: existing, error: null }
        }
        const row = { ...state.payload, created_at: new Date().toISOString() }
        store().push(row)
        return { data: row, error: null }
      }
      if (state.op === "update") {
        const hit = store().filter(matches)
        for (const r of hit) Object.assign(r, state.payload)
        return { data: hit, error: null }
      }
      // select
      let rows = store().filter(matches)
      if (state.order) {
        rows = rows.slice().sort((a, b) => {
          const av = a[state.order!.col]
          const bv = b[state.order!.col]
          return (av < bv ? -1 : av > bv ? 1 : 0) * (state.order!.asc ? 1 : -1)
        })
      }
      if (typeof state.limit === "number") rows = rows.slice(0, state.limit)
      return { data: rows, error: null }
    }

    const api = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: (cols?: string) => { state.op = state.op === "select" ? "select" : state.op; state.cols = cols; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: (payload: any) => { state.op = "insert"; state.payload = payload; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (payload: any) => { state.op = "update"; state.payload = payload; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upsert: (payload: any, opts?: { onConflict?: string }) => { state.op = "upsert"; state.payload = payload; state.onConflict = opts?.onConflict; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq: (col: string, val: any) => { state.eqs.push([col, val]); return api },
      is: (col: string, _val: null) => { state.isNulls.push(col); return api },
      order: (col: string, opts?: { ascending?: boolean }) => { state.order = { col, asc: opts?.ascending !== false }; return api },
      limit: (n: number) => { state.limit = n; return Promise.resolve(run()) },
      maybeSingle: async () => {
        const { data } = run()
        const arr = data as unknown[]
        const one = Array.isArray(arr) ? (arr[0] ?? null) : (data ?? null)
        return { data: one, error: null }
      },
      single: async () => {
        const { data } = run()
        const arr = data as unknown[]
        const one = Array.isArray(arr) ? (arr[0] ?? null) : (data ?? null)
        return { data: one, error: null }
      },
      // Thenable so `await builder…` (after .limit/.eq with no terminal) resolves.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: any) => void) => resolve(run()),
    }
    return api
  }

  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
    },
  }
})

// Isolate the notification path — assert it's called, don't run the CRM graph.
const emitApprovalOutcome = vi.fn(async () => true)
const sendApprovalNotification = vi.fn(async () => true)
vi.mock("@/lib/ai-agent/approval-notifications", () => ({
  emitApprovalOutcome: (...args: unknown[]) => emitApprovalOutcome(...(args as [])),
  sendApprovalNotification: (...args: unknown[]) => sendApprovalNotification(...(args as [])),
}))

import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"
import { proposeAction, generateConfirmationCode } from "@/lib/ai-agent/worker-tools"
import { formatApprovalProposal } from "@/lib/ai-agent/format-approval-proposal"
import { computeParamsHash } from "@/lib/ai-agent/approvable-tools"

// Capture every WP1 + existing tool handler registered by registerAgentApprovalTools.
function handlers(): Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map: Record<string, any> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAgentApprovalTools({ tool: (name: string, _d: string, _s: any, fn: any) => { map[name] = fn } } as any)
  return map
}

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  h.tables.approval_queue.length = 0
  h.tables.hermes_instances.length = 0
  emitApprovalOutcome.mockClear()
  sendApprovalNotification.mockClear()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.CRON_SECRET // so fireExecutorTrigger skips the network call
  delete process.env.APPROVAL_ENV
  process.env.NODE_ENV = "production"
  // The worker action rail is OFF by default (2026-07-10). This suite covers the
  // dormant-but-intact queue machinery, so switch it on to exercise proposeAction.
  process.env.WORKER_ACTIONS_ENABLED = "true"
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedApproval(row: Record<string, any>) {
  const base = {
    id: row.id ?? "00000000-0000-0000-0000-000000000001",
    tool_name: "update_account_notes",
    params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "X" },
    params_hash: computeParamsHash(row.params ?? { account_id: "a1111111-2222-4333-8444-555555555555", note: "X" }),
    rationale: "because",
    status: "pending",
    claimed_by: null,
    env: "production",
    thread_id: null,
    confirmation_code: null,
    created_at: "2026-06-04T00:00:00Z",
  }
  const merged = { ...base, ...row }
  // keep params_hash consistent unless the test overrode it explicitly
  if (row.params && !("params_hash" in row)) merged.params_hash = computeParamsHash(row.params)
  h.tables.approval_queue.push(merged)
  return merged
}

// ─────────────────────────────────────────────────────────────────────────────
// proposeAction — 6-digit confirmation code
// ─────────────────────────────────────────────────────────────────────────────

describe("generateConfirmationCode", () => {
  it("always returns exactly 6 digits", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateConfirmationCode()).toMatch(/^\d{6}$/)
    }
  })
})

describe("proposeAction — confirmation code (WP1)", () => {
  it("mints a 6-digit confirmation_code on the queued row", async () => {
    const out = await proposeAction({ tool_name: "update_account_notes", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Coded" } })
    expect(out).toContain("queued for approval")
    expect(out).toMatch(/confirmation_code=\d{6}/)
    expect(h.tables.approval_queue).toHaveLength(1)
    expect(h.tables.approval_queue[0].confirmation_code).toMatch(/^\d{6}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// formatApprovalProposal — surfaces the code + APPROVE <id> <code>
// ─────────────────────────────────────────────────────────────────────────────

describe("formatApprovalProposal — confirmation code (WP1)", () => {
  it("renders the 🔑 code line and APPROVE <short-id> <code>", () => {
    const text = formatApprovalProposal({
      id: "abcdef12-0000-0000-0000-000000000000",
      tool_name: "update_account_notes",
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Do it" },
      rationale: "needed",
      confirmation_code: "123456",
    })
    expect(text).toContain("🔑 Code: 123456")
    expect(text).toContain("To approve: APPROVE abcdef12 123456")
  })

  it("falls back to <code> placeholder when the row has no code", () => {
    const text = formatApprovalProposal({
      id: "abcdef12-0000-0000-0000-000000000000",
      tool_name: "update_account_notes",
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Do it" },
    })
    expect(text).not.toContain("🔑 Code:")
    expect(text).toContain("To approve: APPROVE abcdef12 <code>")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// approval_decide — confirmation code gate
// ─────────────────────────────────────────────────────────────────────────────

describe("approval_decide — confirmation code (WP1)", () => {
  const ID = "11111111-1111-4111-8111-111111111111"

  it("approves when the confirmation code matches", async () => {
    seedApproval({ id: ID, status: "pending", confirmation_code: "654321" })
    const res = await handlers().approval_decide({ id: ID, decision: "approve", confirmation_code: "654321" })
    expect(res.content[0].text).toContain("Approved proposal")
    expect(h.tables.approval_queue[0].status).toBe("approved")
  })

  it("rejects an approve with the WRONG code — row stays pending, never runs", async () => {
    seedApproval({ id: ID, status: "pending", confirmation_code: "654321" })
    const res = await handlers().approval_decide({ id: ID, decision: "approve", confirmation_code: "000000" })
    expect(res.content[0].text).toContain("Invalid confirmation code")
    expect(h.tables.approval_queue[0].status).toBe("pending")
  })

  it("rejects an approve with NO code", async () => {
    seedApproval({ id: ID, status: "pending", confirmation_code: "654321" })
    const res = await handlers().approval_decide({ id: ID, decision: "approve" })
    expect(res.content[0].text).toContain("Confirmation code required")
    expect(h.tables.approval_queue[0].status).toBe("pending")
  })

  it("reject works with no code", async () => {
    seedApproval({ id: ID, status: "pending", confirmation_code: "654321" })
    const res = await handlers().approval_decide({ id: ID, decision: "reject", note: "not now" })
    expect(res.content[0].text).toContain("Rejected proposal")
    expect(h.tables.approval_queue[0].status).toBe("rejected")
    expect(emitApprovalOutcome).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hermes_heartbeat
// ─────────────────────────────────────────────────────────────────────────────

describe("hermes_heartbeat (WP1)", () => {
  it("creates a row on first beat, then updates it on the next", async () => {
    const beat = handlers().hermes_heartbeat
    const r1 = await beat({ instance_id: "hermes-mac-mini" })
    const out1 = JSON.parse(r1.content[0].text)
    expect(out1.ok).toBe(true)
    expect(out1.instance_id).toBe("hermes-mac-mini")
    expect(h.tables.hermes_instances).toHaveLength(1)
    expect(h.tables.hermes_instances[0].status).toBe("online")

    const firstBeat = h.tables.hermes_instances[0].last_heartbeat
    await beat({ instance_id: "hermes-mac-mini" })
    expect(h.tables.hermes_instances).toHaveLength(1) // upsert, not a 2nd row
    expect(h.tables.hermes_instances[0].last_heartbeat).not.toBe(undefined)
    void firstBeat
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// approval_claim
// ─────────────────────────────────────────────────────────────────────────────

describe("approval_claim (WP1)", () => {
  it("claims the oldest approved+unclaimed row and sets it executing", async () => {
    seedApproval({ id: "aaaa1111-1111-4111-8111-111111111111", status: "approved", created_at: "2026-06-04T00:00:02Z", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "newer" } })
    seedApproval({ id: "bbbb2222-2222-4222-8222-222222222222", status: "approved", created_at: "2026-06-04T00:00:01Z", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "older" } })

    const res = await handlers().approval_claim({ instance_id: "hermes-1" })
    const claimed = JSON.parse(res.content[0].text)
    // oldest (created earlier) wins
    expect(claimed.id).toBe("bbbb2222-2222-4222-8222-222222222222")
    expect(claimed.tool_name).toBe("update_account_notes")
    expect(claimed.confirmation_code !== undefined).toBe(true)

    const row = h.tables.approval_queue.find((r) => r.id === claimed.id)
    expect(row.status).toBe("executing")
    expect(row.claimed_by).toBe("hermes-1")
    expect(row.claimed_at).toBeTruthy()
  })

  it("returns 'nothing to claim' when no approved rows exist", async () => {
    seedApproval({ status: "pending", confirmation_code: "111111" }) // pending, not claimable
    const res = await handlers().approval_claim({ instance_id: "hermes-1" })
    expect(res.content[0].text).toContain("Nothing to claim")
  })

  it("fails the row (never executed) when params_hash no longer matches", async () => {
    seedApproval({
      id: "cccc3333-3333-4333-8333-333333333333",
      status: "approved",
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "tampered" },
      params_hash: "deadbeef-not-the-real-hash",
    })
    const res = await handlers().approval_claim({ instance_id: "hermes-1" })
    expect(res.content[0].text).toContain("integrity")
    const row = h.tables.approval_queue[0]
    expect(row.status).toBe("failed")
    expect(row.error_text).toBe("integrity")
    expect(emitApprovalOutcome).toHaveBeenCalledTimes(1)
    expect(emitApprovalOutcome.mock.calls[0][0]).toMatchObject({ status: "failed" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// approval_complete
// ─────────────────────────────────────────────────────────────────────────────

describe("approval_complete (WP1)", () => {
  const ID = "dddd4444-4444-4444-8444-444444444444"

  it("finalizes an executing row as executed + stamps executed_by from claimed_by + notifies", async () => {
    seedApproval({ id: ID, status: "executing", claimed_by: "hermes-9" })
    const res = await handlers().approval_complete({ id: ID, status: "executed", result: { ok: 1 } })
    expect(res.content[0].text).toContain("marked executed")
    const row = h.tables.approval_queue[0]
    expect(row.status).toBe("executed")
    expect(row.executed_by).toBe("hermes-9")
    expect(row.executed_at).toBeTruthy()
    expect(row.result).toEqual({ ok: 1 })
    expect(row.notification_sent).toBe(false) // set false in the patch; emit flips it via its own path
    expect(emitApprovalOutcome).toHaveBeenCalledTimes(1)
    expect(emitApprovalOutcome.mock.calls[0][0]).toMatchObject({ id: ID, status: "executed" })
  })

  it("is a no-op on a row that is NOT executing (idempotent)", async () => {
    seedApproval({ id: ID, status: "executed", claimed_by: "hermes-9" })
    const res = await handlers().approval_complete({ id: ID, status: "failed", error_text: "late" })
    expect(res.content[0].text).toContain("not 'executing'")
    expect(h.tables.approval_queue[0].status).toBe("executed") // unchanged
    expect(emitApprovalOutcome).not.toHaveBeenCalled()
  })
})

// sanity: hash helper used in seeds matches the canonical SHA-256 the rail uses
describe("seed hash sanity", () => {
  it("computeParamsHash is SHA-256 of canonical JSON", () => {
    const p = { account_id: "a1111111-2222-4333-8444-555555555555", note: "X" }
    const expected = createHash("sha256").update(JSON.stringify({ account_id: "a1111111-2222-4333-8444-555555555555", note: "X" })).digest("hex")
    expect(computeParamsHash(p)).toBe(expected)
  })
})
