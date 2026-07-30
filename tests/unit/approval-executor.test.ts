/**
 * Hermes ↔ Claude bridge — Phase 2, Slice 2: decision + execution rail.
 *
 * Pins the Slice 2 contract:
 *   - approved row → atomic claim → execute → 'executed' + result + outcome callback
 *   - approval_decide(reject) → 'rejected' + outcome callback
 *   - pending past expires_at → scan → 'expired' + outcome callback
 *   - claiming the same row twice → the second claim gets 0 rows (no double-exec)
 *   - params_hash mismatch → 'failed', action NEVER executed, callback written
 *   - error-shaped executeTool result → 'failed' (not 'executed')
 *   - kill switch off → runApprovalExecutor returns {disabled:true}, executes nothing
 *   - executing > 10 min → recovered back to 'approved'
 *
 * supabaseAdmin and executeTool are mocked; computeParamsHash is the real one so
 * the integrity check is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createHash } from "crypto"

// Hoisted shared state: an in-memory two-table store + a controllable executeTool.
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: { approval_queue: any[]; agent_messages: any[]; hermes_instances: any[] } = { approval_queue: [], agent_messages: [], hermes_instances: [] }
  const tool = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    impl: (async (_name: string, _params: any) => "{}") as (name: string, params: unknown) => Promise<string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    calls: [] as Array<{ name: string; params: any }>,
  }
  return { store, tool }
})

vi.mock("@/lib/ai-agent/tools", () => ({
  AGENT_TOOLS: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeTool: async (name: string, params: any) => {
    h.tool.calls.push({ name, params })
    return h.tool.impl(name, params)
  },
}))

vi.mock("@/lib/supabase-admin", () => {
  // Chainable query builder over h.store. Supports the exact call shapes used by
  // approval-executor.ts, approval-callback.ts and approval_decide.
  function from(table: "approval_queue" | "agent_messages" | "hermes_instances") {
    const st = {
      op: "select" as "select" | "update" | "insert",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: [] as Array<{ kind: "eq" | "lt" | "gt"; col: string; val: any }>,
      cols: null as string | null,
      ord: null as { col: string; asc: boolean } | null,
      lim: null as number | null,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (): any[] => (h.store[table] ??= [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = (): any[] =>
      rows().filter((r) =>
        st.filters.every((f) => {
          const v = r[f.col]
          if (f.kind === "eq") return v === f.val
          if (f.kind === "lt") return v != null && v < f.val
          if (f.kind === "gt") return v != null && v > f.val
          return true
        }),
      )
    const run = () => {
      if (st.op === "update") {
        const ms = matched()
        ms.forEach((r) => Object.assign(r, st.set))
        return { data: st.cols ? ms.map((r) => ({ ...r })) : null, error: null }
      }
      if (st.op === "insert") {
        const r = { id: `row-${rows().length + 1}`, created_at: `2026-06-04T00:00:0${rows().length}Z`, ...st.row }
        rows().push(r)
        return { data: st.cols ? { ...r } : r, error: null }
      }
      let out = matched().map((r) => ({ ...r }))
      if (st.ord) {
        const { col, asc } = st.ord
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (st.lim != null) out = out.slice(0, st.lim)
      return { data: out, error: null }
    }
    const api = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update(set: any) { st.op = "update"; st.set = set; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert(row: any) { st.op = "insert"; st.row = row; return api },
      select(cols?: string) { st.cols = cols ?? "*"; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq(col: string, val: any) { st.filters.push({ kind: "eq", col, val }); return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lt(col: string, val: any) { st.filters.push({ kind: "lt", col, val }); return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gt(col: string, val: any) { st.filters.push({ kind: "gt", col, val }); return api },
      order(col: string, opts?: { ascending?: boolean }) { st.ord = { col, asc: opts ? opts.ascending !== false : true }; return api },
      limit(n: number) { st.lim = n; return Promise.resolve(run()) },
      maybeSingle: async () => { const { data, error } = run(); return { data: Array.isArray(data) ? (data[0] ?? null) : data, error } },
      single: async () => { const { data, error } = run(); return { data: Array.isArray(data) ? (data[0] ?? null) : data, error } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(resolve: (v: any) => void, reject: (e: unknown) => void) { try { resolve(run()) } catch (e) { reject(e) } },
    }
    return api
  }
  return { supabaseAdmin: { from } }
})

import {
  claimApproval,
  executeApproval,
  executeClaimedRow,
  recoverStuckExecuting,
  runExecutorScan,
  runApprovalExecutor,
  interpretToolResult,
  serverShouldBackstop,
  BACKUP_GRACE_MS,
  LONG_STRAND_MS,
} from "@/lib/ai-agent/approval-executor"
import { computeParamsHash } from "@/lib/ai-agent/approvable-tools"
import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedApproval(over: Record<string, any>) {
  const params = over.params ?? {}
  const row = {
    id: over.id ?? `ap-${h.store.approval_queue.length + 1}`,
    requested_by: "worker",
    tool_name: over.tool_name ?? "create_task",
    params,
    params_hash: over.params_hash ?? computeParamsHash(params),
    rationale: null,
    status: over.status ?? "approved",
    decided_by: null,
    decided_at: null,
    confirmation_code: over.confirmation_code ?? "424242",
    claimed_at: over.claimed_at ?? null,
    claimed_by: over.claimed_by ?? null,
    executed_at: null,
    result: null,
    error_text: null,
    idempotency_key: null,
    // Phase D lane tag — defaults to the pinned test lane so the executor's
    // env filter matches. Override with { env: '...' } to test cross-lane skip.
    env: over.env ?? TEST_LANE,
    expires_at: over.expires_at ?? "2099-01-01T00:00:00Z",
    created_at: over.created_at ?? `2026-06-04T00:00:0${h.store.approval_queue.length}Z`,
    updated_at: "2026-06-04T00:00:00Z",
  }
  h.store.approval_queue.push(row)
  return row
}

const ORIGINAL_ENV = { ...process.env }
const TEST_LANE = "test-lane"

beforeEach(() => {
  h.store.approval_queue.length = 0
  h.store.agent_messages.length = 0
  h.store.hermes_instances.length = 0
  h.tool.calls.length = 0
  h.tool.impl = async () => JSON.stringify({ ok: true })
  process.env.APPROVAL_RAIL_ENABLED = "true"
  process.env.APPROVAL_ENV = TEST_LANE // pin the executor's lane deterministically
  delete process.env.CRON_SECRET // approve path skips the fetch trigger when unset
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureDecideHandler(): (args: any) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any
  const fakeServer = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: (name: string, _desc: string, _schema: any, fn: any) => {
      if (name === "approval_decide") handler = fn
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  registerAgentApprovalTools(fakeServer)
  return handler
}

// ─────────────────────────────────────────────────────────────────────────────
// interpretToolResult
// ─────────────────────────────────────────────────────────────────────────────

describe("interpretToolResult", () => {
  it("treats an {error} object as a failure", () => {
    const r = interpretToolResult(JSON.stringify({ error: "boom" }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe("boom")
  })

  it("treats a normal object as a successful result", () => {
    const r = interpretToolResult(JSON.stringify({ id: "x", created: true }))
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ id: "x", created: true })
  })

  it("wraps a non-JSON string as { text }", () => {
    const r = interpretToolResult("plain text reply")
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ text: "plain text reply" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("executeApproval — happy path", () => {
  it("claims, executes, marks executed with result, and writes an outcome callback", async () => {
    const row = seedApproval({ tool_name: "create_task", params: { task_title: "Call client" }, status: "approved" })
    h.tool.impl = async () => JSON.stringify({ task_id: "t-1", created: true })

    const res = await executeApproval(row.id)
    expect(res.status).toBe("executed")

    const stored = h.store.approval_queue[0]
    expect(stored.status).toBe("executed")
    expect(stored.claimed_by).toBe("approval-executor")
    expect(stored.executed_at).toBeTruthy()
    expect(stored.result).toEqual({ task_id: "t-1", created: true })

    // executeTool actually called with the stored params
    expect(h.tool.calls).toHaveLength(1)
    expect(h.tool.calls[0]).toEqual({ name: "create_task", params: { task_title: "Call client" } })

    // outcome callback to Hermes
    expect(h.store.agent_messages).toHaveLength(1)
    const cb = h.store.agent_messages[0]
    expect(cb.sender).toBe("worker")
    expect(cb.recipient).toBe("hermes")
    expect(cb.status).toBe("done")
    expect(cb.context_json).toEqual({ approval_id: row.id, tool_name: "create_task", outcome_status: "executed" })
  })

  it("REFUSES send_email from an approval — every email must go through the confirm card", async () => {
    // The executor dispatches by tool name straight to the raw implementation,
    // bypassing the worker's freeze/card gate entirely. Dormant while the action
    // rail is off, listed so switching the rail on cannot silently open it.
    const row = seedApproval({ tool_name: "send_email", params: { to: "a@b.c", subject: "S", body: "B" } })
    const res = await executeApproval(row.id)
    expect(res.status).not.toBe("executed")
    expect(String(h.store.approval_queue[0].error_text ?? "")).toMatch(/cannot be executed from an approval/i)
  })

  it("marks 'failed' (not executed) when executeTool returns an error-shaped result", async () => {
    // NOT send_email: that tool is now refused from an approval outright (every
    // email must go through the worker's confirm card), so it can no longer stand
    // in for "a tool whose implementation errors".
    const row = seedApproval({ tool_name: "create_task", params: { title: "T" } })
    h.tool.impl = async () => JSON.stringify({ error: "SMTP refused" })

    const res = await executeApproval(row.id)
    expect(res.status).toBe("failed")
    expect(h.store.approval_queue[0].status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toContain("SMTP refused")
    expect(h.store.agent_messages[0].context_json.outcome_status).toBe("failed")
  })

  it("executes when stored params come back in a DIFFERENT key order (JSONB round-trip)", async () => {
    // Regression for the Slice 2 sandbox E2E bug: the proposal is stored as
    // JSONB, which reorders object keys. The executor recomputes the hash over
    // the reordered params — it must still match. params_hash is computed from
    // the ORIGINAL key order; the row's params are in a DIFFERENT order.
    const original = { task_title: "Reordered", account_id: "acc-1", priority: "medium" }
    const hash = computeParamsHash(original)
    const reordered = { priority: "medium", account_id: "acc-1", task_title: "Reordered" }
    const row = seedApproval({ tool_name: "create_task", params: reordered, params_hash: hash, status: "approved" })
    h.tool.impl = async () => JSON.stringify({ success: true, task: { id: "t-9" } })

    const res = await executeApproval(row.id)
    expect(res.status).toBe("executed") // would be 'failed/integrity' before the canonical-hash fix
    expect(h.tool.calls).toHaveLength(1)
  })

  it("marks 'failed' when executeTool throws", async () => {
    const row = seedApproval({ tool_name: "create_task", params: { task_title: "X" } })
    h.tool.impl = async () => { throw new Error("network down") }

    const res = await executeApproval(row.id)
    expect(res.status).toBe("failed")
    expect(h.store.approval_queue[0].status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toContain("network down")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — atomic claim
// ─────────────────────────────────────────────────────────────────────────────

describe("claimApproval — atomic, single-winner", () => {
  it("the second claim of the same row gets 0 rows (no double execution)", async () => {
    const row = seedApproval({ status: "approved" })

    const first = await claimApproval(row.id)
    expect(first).not.toBeNull()
    expect(h.store.approval_queue[0].status).toBe("executing")

    const second = await claimApproval(row.id)
    expect(second).toBeNull() // already executing → WHERE status='approved' matches nothing
  })

  it("executeApproval on a non-approved row is skipped without calling executeTool", async () => {
    const row = seedApproval({ status: "pending" }) // not approved
    const res = await executeApproval(row.id)
    expect(res.status).toBe("skipped")
    expect(h.tool.calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integrity — params_hash mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("executeApproval — params_hash integrity", () => {
  it("does NOT execute and marks 'failed' when the stored hash doesn't match the params", async () => {
    const row = seedApproval({
      tool_name: "send_email",
      params: { to: "a@b.c", subject: "S", body: "B" },
      params_hash: "deadbeef-not-the-real-hash",
      status: "approved",
    })

    const res = await executeApproval(row.id)
    expect(res.status).toBe("failed")
    expect(res.reason).toBe("integrity")
    expect(h.tool.calls).toHaveLength(0) // action NEVER ran
    expect(h.store.approval_queue[0].status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toBe("params_hash integrity mismatch")
    expect(h.store.agent_messages[0].context_json.outcome_status).toBe("failed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reject — approval_decide
// ─────────────────────────────────────────────────────────────────────────────

describe("approval_decide(reject)", () => {
  it("flips pending→rejected and writes an outcome callback with the note", async () => {
    const row = seedApproval({ tool_name: "send_email", status: "pending" })
    const handler = captureDecideHandler()

    const res = await handler({ id: row.id, decision: "reject", note: "wrong recipient" })
    expect(res.content[0].text).toContain("Rejected")

    const stored = h.store.approval_queue[0]
    expect(stored.status).toBe("rejected")
    expect(stored.decided_by).toBe("antonio")
    expect(stored.decided_at).toBeTruthy()

    expect(h.store.agent_messages).toHaveLength(1)
    const cb = h.store.agent_messages[0]
    expect(cb.reply).toContain("rejected: wrong recipient")
    expect(cb.context_json.outcome_status).toBe("rejected")
  })

  it("is a no-op on a row that is not pending", async () => {
    const row = seedApproval({ status: "approved" })
    const handler = captureDecideHandler()
    const res = await handler({ id: row.id, decision: "reject" })
    expect(res.content[0].text).toContain("not pending")
    expect(h.store.approval_queue[0].status).toBe("approved") // unchanged
    expect(h.store.agent_messages).toHaveLength(0)
  })
})

describe("approval_decide(approve)", () => {
  it("flips pending→approved with the matching confirmation code (executor fired separately; trigger skipped without CRON_SECRET)", async () => {
    const row = seedApproval({ tool_name: "create_task", status: "pending", confirmation_code: "424242" })
    const handler = captureDecideHandler()
    const res = await handler({ id: row.id, decision: "approve", confirmation_code: "424242" })
    expect(res.content[0].text).toContain("Approved")
    expect(h.store.approval_queue[0].status).toBe("approved")
    expect(h.store.approval_queue[0].decided_by).toBe("antonio")
  })

  it("rejects an approve with the wrong confirmation code — row stays pending (WP1)", async () => {
    const row = seedApproval({ tool_name: "create_task", status: "pending", confirmation_code: "424242" })
    const handler = captureDecideHandler()
    const res = await handler({ id: row.id, decision: "approve", confirmation_code: "999999" })
    expect(res.content[0].text).toContain("Invalid confirmation code")
    expect(h.store.approval_queue[0].status).toBe("pending")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Expiry sweep
// ─────────────────────────────────────────────────────────────────────────────

describe("expiry sweep (runExecutorScan)", () => {
  it("expires pending rows past expires_at and writes a callback", async () => {
    const row = seedApproval({ status: "pending", expires_at: "2020-01-01T00:00:00Z" })

    const result = await runExecutorScan()
    expect(result.expired).toBe(1)
    expect(h.store.approval_queue[0].status).toBe("expired")
    // Phase B: expiry flips notification_sent so the retry sweep won't duplicate it.
    expect(h.store.approval_queue[0].notification_sent).toBe(true)

    const cb = h.store.agent_messages.find((m) => m.context_json?.approval_id === row.id)
    expect(cb).toBeTruthy()
    expect(cb.context_json.outcome_status).toBe("expired")
  })

  it("does not expire a pending row whose expires_at is in the future", async () => {
    seedApproval({ status: "pending", expires_at: "2099-01-01T00:00:00Z" })
    const result = await runExecutorScan()
    expect(result.expired).toBe(0)
    expect(h.store.approval_queue[0].status).toBe("pending")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Crash recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("recoverStuckExecuting", () => {
  it("re-claims rows stuck in 'executing' for > 10 min back to 'approved'", async () => {
    seedApproval({ status: "executing", claimed_at: "2020-01-01T00:00:00Z", claimed_by: "approval-executor" })

    const recovered = await recoverStuckExecuting()
    expect(recovered).toBe(1)
    const stored = h.store.approval_queue[0]
    expect(stored.status).toBe("approved")
    expect(stored.claimed_at).toBeNull()
    expect(stored.claimed_by).toBeNull()
  })

  it("leaves a freshly-claimed 'executing' row alone", async () => {
    const fresh = new Date().toISOString()
    seedApproval({ status: "executing", claimed_at: fresh, claimed_by: "approval-executor" })
    const recovered = await recoverStuckExecuting()
    expect(recovered).toBe(0)
    expect(h.store.approval_queue[0].status).toBe("executing")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Kill switch
// ─────────────────────────────────────────────────────────────────────────────

describe("kill switch", () => {
  it("runApprovalExecutor returns {disabled:true} and executes nothing when APPROVAL_RAIL_ENABLED is unset", async () => {
    delete process.env.APPROVAL_RAIL_ENABLED
    const row = seedApproval({ status: "approved" })

    const result = await runApprovalExecutor({ id: row.id })
    expect(result.disabled).toBe(true)
    expect(h.tool.calls).toHaveLength(0)
    expect(h.store.approval_queue[0].status).toBe("approved") // untouched
  })

  it("runApprovalExecutor executes in direct mode when the switch is 'true'", async () => {
    process.env.APPROVAL_RAIL_ENABLED = "true"
    const row = seedApproval({ status: "approved", tool_name: "create_task", params: { task_title: "Y" } })

    const result = await runApprovalExecutor({ id: row.id })
    expect(result.disabled).toBeUndefined()
    expect(result.mode).toBe("direct")
    expect(h.store.approval_queue[0].status).toBe("executed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase D — env lane isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("env lane isolation", () => {
  it("direct claim SKIPS a row whose env != the executor's lane (action never runs)", async () => {
    const row = seedApproval({ status: "approved", env: "other-lane", tool_name: "create_task", params: { task_title: "X" } })
    const result = await executeApproval(row.id)
    expect(result.status).toBe("skipped")
    expect(h.tool.calls).toHaveLength(0)
    expect(h.store.approval_queue[0].status).toBe("approved") // untouched
  })

  it("scan only executes rows in the executor's own lane", async () => {
    seedApproval({ id: "mine", status: "approved", env: TEST_LANE, params: { task_title: "mine" } })
    seedApproval({ id: "theirs", status: "approved", env: "other-lane", params: { task_title: "theirs" } })

    const res = await runExecutorScan()
    expect(res.executed).toBe(1)
    const byId = Object.fromEntries(h.store.approval_queue.map((r) => [r.id, r.status]))
    expect(byId.mine).toBe("executed")
    expect(byId.theirs).toBe("approved") // other lane left alone
  })

  it("claim matches a same-lane row (the default 'production'-style case)", async () => {
    const row = seedApproval({ status: "approved", env: TEST_LANE, params: { task_title: "Z" } })
    const result = await executeApproval(row.id)
    expect(result.status).toBe("executed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP3 — serverShouldBackstop (pure decision)
// ─────────────────────────────────────────────────────────────────────────────

describe("serverShouldBackstop (WP3)", () => {
  const NOW = Date.parse("2026-06-05T12:00:00Z")
  const freshBeat = (msAgo: number) => new Date(NOW - msAgo).toISOString()

  it("does NOT back up a row approved within the grace window (Mac Mini gets first dibs)", () => {
    const row = { decided_at: new Date(NOW - 60_000).toISOString() } // 1 min ago < 3 min grace
    // even with an OFFLINE primary, the grace window protects a just-approved row
    expect(serverShouldBackstop(row, null, NOW)).toBe(false)
  })

  it("backs up after grace when the primary is stale/offline", () => {
    const row = { decided_at: new Date(NOW - (BACKUP_GRACE_MS + 60_000)).toISOString() }
    // no instance row → treated as stale
    expect(serverShouldBackstop(row, null, NOW)).toBe(true)
  })

  it("does NOT back up after grace when the primary is fresh (healthy Mac Mini keeps the row)", () => {
    const row = { decided_at: new Date(NOW - (BACKUP_GRACE_MS + 60_000)).toISOString() }
    const instance = { instance_id: "hermes-mac-mini", last_heartbeat: freshBeat(30_000), status: "online" }
    expect(serverShouldBackstop(row, instance, NOW)).toBe(false)
  })

  it("long-strand failsafe: backs up a very old row even if the primary looks fresh", () => {
    const row = { decided_at: new Date(NOW - (LONG_STRAND_MS + 60_000)).toISOString() }
    const instance = { instance_id: "hermes-mac-mini", last_heartbeat: freshBeat(10_000), status: "online" }
    expect(serverShouldBackstop(row, instance, NOW)).toBe(true)
  })

  it("falls back to created_at when decided_at is missing", () => {
    const row = { decided_at: null, created_at: new Date(NOW - (BACKUP_GRACE_MS + 60_000)).toISOString() }
    expect(serverShouldBackstop(row, null, NOW)).toBe(true)
  })

  it("treats an unparseable/absent reference time as eligible (never strands a malformed row)", () => {
    expect(serverShouldBackstop({ decided_at: null, created_at: null }, null, NOW)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP3 — runExecutorScan defers to a healthy Mac Mini
// ─────────────────────────────────────────────────────────────────────────────

describe("runExecutorScan — server is BACKUP (WP3)", () => {
  it("DEFERS an approved row (past grace) when the Mac Mini is online (does not execute)", async () => {
    // primary heartbeat is fresh → server defers even though grace has elapsed
    h.store.hermes_instances.push({ instance_id: "hermes-mac-mini", last_heartbeat: new Date().toISOString(), status: "online" })
    // approved well past the grace window, but the primary is healthy → not stranded
    const pastGrace = new Date(Date.now() - (BACKUP_GRACE_MS + 60_000)).toISOString()
    seedApproval({ status: "approved", decided_at: pastGrace, created_at: pastGrace, params: { task_title: "primary" } })

    const res = await runExecutorScan()
    expect(res.executed).toBe(0)
    expect(res.deferred).toBe(1)
    expect(h.store.approval_queue[0].status).toBe("approved") // untouched — Mac Mini's to claim
    expect(h.tool.calls).toHaveLength(0)
  })

  it("BACKS UP an old approved row when the Mac Mini is offline", async () => {
    // no hermes_instances row → primary is stale → server backs up old rows
    seedApproval({
      status: "approved",
      decided_at: "2020-01-01T00:00:00Z", // ancient → past grace + strand
      created_at: "2020-01-01T00:00:00Z",
      params: { task_title: "stranded" },
    })

    const res = await runExecutorScan()
    expect(res.executed).toBe(1)
    expect(res.deferred).toBe(0)
    expect(h.store.approval_queue[0].status).toBe("executed")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP3 — executeClaimedRow (the approval_execute engine)
// ─────────────────────────────────────────────────────────────────────────────

describe("executeClaimedRow (WP3)", () => {
  it("runs an 'executing' row, marks executed, stamps executed_by from claimed_by, notifies", async () => {
    const row = seedApproval({ status: "executing", claimed_by: "hermes-mac-mini", tool_name: "create_task", params: { task_title: "Run me" } })
    h.tool.impl = async () => JSON.stringify({ task_id: "t-1", created: true })

    const res = await executeClaimedRow(row.id)
    expect(res.status).toBe("executed")

    const stored = h.store.approval_queue[0]
    expect(stored.status).toBe("executed")
    expect(stored.executed_by).toBe("hermes-mac-mini")
    expect(stored.executed_at).toBeTruthy()
    expect(stored.result).toEqual({ task_id: "t-1", created: true })
    expect(h.tool.calls).toEqual([{ name: "create_task", params: { task_title: "Run me" } }])

    const cb = h.store.agent_messages[0]
    expect(cb.context_json).toEqual({ approval_id: row.id, tool_name: "create_task", outcome_status: "executed" })
  })

  it("is a no-op (skipped) on a row that is NOT executing — never runs the tool", async () => {
    const row = seedApproval({ status: "approved", params: { task_title: "X" } }) // not yet claimed
    const res = await executeClaimedRow(row.id)
    expect(res.status).toBe("skipped")
    expect(h.tool.calls).toHaveLength(0)
    expect(h.store.approval_queue[0].status).toBe("approved")
  })

  it("marks 'failed' (never runs) on a params_hash integrity mismatch", async () => {
    const row = seedApproval({
      status: "executing",
      claimed_by: "hermes-mac-mini",
      tool_name: "send_email",
      params: { to: "a@b.c", subject: "S", body: "B" },
      params_hash: "deadbeef-not-the-real-hash",
    })
    const res = await executeClaimedRow(row.id)
    expect(res.status).toBe("failed")
    expect(res.reason).toBe("integrity")
    expect(h.tool.calls).toHaveLength(0)
    expect(h.store.approval_queue[0].status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toBe("params_hash integrity mismatch")
  })

  it("marks 'failed' on an error-shaped executeTool result", async () => {
    const row = seedApproval({ status: "executing", claimed_by: "hermes-mac-mini", tool_name: "create_task", params: { title: "T" } })
    h.tool.impl = async () => JSON.stringify({ error: "SMTP refused" })
    const res = await executeClaimedRow(row.id)
    expect(res.status).toBe("failed")
    expect(h.store.approval_queue[0].status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toContain("SMTP refused")
  })

  it("marks 'failed' when executeTool throws", async () => {
    const row = seedApproval({ status: "executing", claimed_by: "hermes-mac-mini", tool_name: "create_task", params: { task_title: "X" } })
    h.tool.impl = async () => { throw new Error("network down") }
    const res = await executeClaimedRow(row.id)
    expect(res.status).toBe("failed")
    expect(h.store.approval_queue[0].error_text).toContain("network down")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WP3 — approval_execute MCP tool (kill-switch gate + dispatch)
// ─────────────────────────────────────────────────────────────────────────────

function captureExecuteHandler(): (args: { id: string }) => Promise<{ content: Array<{ text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAgentApprovalTools({ tool: (name: string, _d: string, _s: any, fn: any) => { if (name === "approval_execute") handler = fn } } as any)
  return handler
}

describe("approval_execute MCP tool (WP3)", () => {
  it("executes a claimed row when APPROVAL_RAIL_ENABLED is 'true'", async () => {
    process.env.APPROVAL_RAIL_ENABLED = "true"
    const row = seedApproval({ status: "executing", claimed_by: "hermes-mac-mini", tool_name: "create_task", params: { task_title: "Go" } })
    h.tool.impl = async () => JSON.stringify({ ok: true })
    const res = await captureExecuteHandler()({ id: row.id })
    expect(res.content[0].text).toContain("Executed proposal")
    expect(h.store.approval_queue[0].status).toBe("executed")
  })

  it("is DISABLED (runs nothing) when the kill switch is off — ONE master switch", async () => {
    delete process.env.APPROVAL_RAIL_ENABLED
    const row = seedApproval({ status: "executing", claimed_by: "hermes-mac-mini", params: { task_title: "Go" } })
    const res = await captureExecuteHandler()({ id: row.id })
    expect(res.content[0].text).toContain("Approval rail disabled")
    expect(h.tool.calls).toHaveLength(0)
    expect(h.store.approval_queue[0].status).toBe("executing") // untouched
  })

  it("reports a clear no-op when the row is not in 'executing'", async () => {
    process.env.APPROVAL_RAIL_ENABLED = "true"
    const row = seedApproval({ status: "approved", params: { task_title: "Go" } })
    const res = await captureExecuteHandler()({ id: row.id })
    expect(res.content[0].text).toContain("not executed")
    expect(h.tool.calls).toHaveLength(0)
  })
})

// Sanity: hash helper agrees with the executor's integrity check.
describe("computeParamsHash sanity", () => {
  it("matches a raw SHA-256 of JSON.stringify", () => {
    const p = { a: 1, b: "x" }
    expect(computeParamsHash(p)).toBe(createHash("sha256").update(JSON.stringify(p)).digest("hex"))
  })
})
