/**
 * Hermes ↔ Claude bridge — Phase B: safety + notifications.
 *
 * Pins the Phase B contract (lib/ai-agent/approval-notifications.ts):
 *   - sendApprovalNotification mirrors a proposal/outcome into the CRM team chat
 *     (internal_threads + internal_messages), reusing ONE dedicated system thread,
 *     and NEVER throws (best-effort).
 *   - emitApprovalOutcome writes the Hermes callback, flips notification_sent on
 *     success, and mirrors to the CRM chat; leaves notification_sent=FALSE when
 *     the callback fails (so the sweep retries).
 *   - runNotificationSweep re-notifies terminal rows still notification_sent=FALSE,
 *     and skips already-notified + non-terminal rows.
 *   - proposeAction fires a propose notification on a fresh insert.
 *
 * A controllable in-memory multi-table store stands in for supabaseAdmin. Tools
 * are NOT mocked so proposeAction runs its real allow-list + schema validation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: Record<string, any[]> = {}
  const ctl = {
    throwTables: new Set<string>(), // from(table) throws — simulates an unavailable table
    insertErrorTables: new Set<string>(), // insert returns { error } — simulates a write failure
  }
  return { store, ctl }
})

vi.mock("@/lib/supabase-admin", () => {
  function from(table: string) {
    if (h.ctl.throwTables.has(table)) throw new Error(`table ${table} unavailable`)
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
        if (h.ctl.insertErrorTables.has(table)) return { data: null, error: { message: `insert into ${table} failed` } }
        const r = { id: `${table}-${rows().length + 1}`, created_at: `2026-06-04T00:00:0${rows().length}Z`, ...st.row }
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
  sendApprovalNotification,
  emitApprovalOutcome,
  runNotificationSweep,
} from "@/lib/ai-agent/approval-notifications"
import { proposeAction } from "@/lib/ai-agent/worker-tools"

const SYSTEM_THREAD_TITLE = "🤖 Approval Rail (system)"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedApproval(over: Record<string, any>) {
  const row = {
    id: over.id ?? `ap-${(h.store.approval_queue ??= []).length + 1}`,
    tool_name: over.tool_name ?? "update_account_notes",
    params: over.params ?? { account_id: "a1111111-2222-4333-8444-555555555555", note: "x" },
    rationale: over.rationale ?? null,
    status: over.status ?? "executed",
    notification_sent: over.notification_sent ?? false,
    result: over.result ?? null,
    error_text: over.error_text ?? null,
    expires_at: over.expires_at ?? "2099-01-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-06-04T00:00:00Z",
  }
  ;(h.store.approval_queue ??= []).push(row)
  return row
}

beforeEach(() => {
  for (const k of Object.keys(h.store)) delete h.store[k]
  h.ctl.throwTables.clear()
  h.ctl.insertErrorTables.clear()
  // Worker action rail is OFF by default (2026-07-10); this suite exercises the
  // dormant-but-intact proposeAction machinery, so switch it on for these tests.
  process.env.WORKER_ACTIONS_ENABLED = "true"
})

// ─────────────────────────────────────────────────────────────────────────────
// sendApprovalNotification — CRM team-chat mirror
// ─────────────────────────────────────────────────────────────────────────────

describe("sendApprovalNotification", () => {
  it("creates the system thread and writes a formatted 'proposed' message", async () => {
    const ok = await sendApprovalNotification(
      { id: "11111111-2222-3333-4444-555555555555", tool_name: "update_account_notes", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Call client" }, rationale: "asked" },
      "proposed",
    )
    expect(ok).toBe(true)

    const threads = h.store.internal_threads ?? []
    expect(threads).toHaveLength(1)
    expect(threads[0].title).toBe(SYSTEM_THREAD_TITLE)
    expect(threads[0].account_id ?? null).toBeNull()
    expect(threads[0].contact_id ?? null).toBeNull()

    const msgs = h.store.internal_messages ?? []
    expect(msgs).toHaveLength(1)
    expect(msgs[0].thread_id).toBe(threads[0].id)
    expect(msgs[0].sender_name).toBe("Approval Rail")
    expect(msgs[0].message).toContain("New action proposed — awaiting approval")
    expect(msgs[0].message).toContain("Append note to account")
  })

  it("reuses the SAME system thread across calls (no duplicate threads)", async () => {
    const row = { id: "aaaaaaaa-0000-0000-0000-000000000000", tool_name: "update_account_notes", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "x" } }
    await sendApprovalNotification(row, "proposed")
    await sendApprovalNotification(row, "executed", "done")
    await sendApprovalNotification(row, "failed", "boom")

    expect(h.store.internal_threads).toHaveLength(1)
    expect(h.store.internal_messages).toHaveLength(3)
    expect(h.store.internal_messages[1].message).toContain("✅ Action executed")
    expect(h.store.internal_messages[2].message).toContain("❌ Action failed")
  })

  it("never throws and returns false when the team-chat tables are unavailable", async () => {
    h.ctl.throwTables.add("internal_threads")
    const ok = await sendApprovalNotification(
      { id: "x", tool_name: "update_account_notes", params: {} },
      "executed",
      "done",
    )
    expect(ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emitApprovalOutcome — Hermes callback + notification_sent + CRM mirror
// ─────────────────────────────────────────────────────────────────────────────

describe("emitApprovalOutcome", () => {
  it("writes the Hermes callback, flips notification_sent, and mirrors to CRM chat", async () => {
    const row = seedApproval({ tool_name: "send_email", status: "executed", params: { to: "a@b.c", subject: "S", body: "B" } })

    const ok = await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "executed",
      summary: "Proposal send_email executed successfully.",
      row: { id: row.id, tool_name: row.tool_name, params: row.params },
    })
    expect(ok).toBe(true)

    // a) Hermes callback in agent_messages
    const cb = (h.store.agent_messages ?? [])[0]
    expect(cb.sender).toBe("worker")
    expect(cb.recipient).toBe("hermes")
    expect(cb.context_json.outcome_status).toBe("executed")

    // b) notification_sent flipped on the approval row
    expect(h.store.approval_queue[0].notification_sent).toBe(true)

    // c) CRM team-chat mirror
    expect((h.store.internal_messages ?? [])[0].message).toContain("✅ Action executed")
  })

  it("leaves notification_sent FALSE and returns false when the Hermes callback fails", async () => {
    const row = seedApproval({ status: "executed" })
    h.ctl.insertErrorTables.add("agent_messages") // writeOutcomeCallback insert fails

    const ok = await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "executed",
      summary: "x",
    })
    expect(ok).toBe(false)
    expect(h.store.approval_queue[0].notification_sent).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runNotificationSweep — retry safety net
// ─────────────────────────────────────────────────────────────────────────────

describe("runNotificationSweep", () => {
  it("re-notifies a terminal row whose first callback never set notification_sent", async () => {
    const row = seedApproval({ tool_name: "update_account_notes", status: "executed", notification_sent: false })

    const n = await runNotificationSweep()
    expect(n).toBe(1)
    expect(h.store.approval_queue[0].notification_sent).toBe(true)
    // a fresh callback was written
    const cb = (h.store.agent_messages ?? []).find((m) => m.context_json?.approval_id === row.id)
    expect(cb).toBeTruthy()
    expect(cb.context_json.outcome_status).toBe("executed")
  })

  it("skips rows that are already notified", async () => {
    seedApproval({ status: "executed", notification_sent: true })
    const n = await runNotificationSweep()
    expect(n).toBe(0)
    expect(h.store.agent_messages ?? []).toHaveLength(0)
  })

  it("skips non-terminal rows even when notification_sent is false", async () => {
    seedApproval({ status: "pending", notification_sent: false })
    seedApproval({ status: "approved", notification_sent: false })
    seedApproval({ status: "executing", notification_sent: false })
    const n = await runNotificationSweep()
    expect(n).toBe(0)
  })

  it("derives the right summary for a failed row from error_text", async () => {
    seedApproval({ tool_name: "send_email", status: "failed", notification_sent: false, error_text: "SMTP refused" })
    await runNotificationSweep()
    const cb = (h.store.agent_messages ?? [])[0]
    expect(cb.reply).toContain("failed")
    expect(cb.reply).toContain("SMTP refused")
  })

  it("processes a mix: notifies the two terminal-unnotified rows, leaves the rest", async () => {
    seedApproval({ status: "executed", notification_sent: false })
    seedApproval({ status: "rejected", notification_sent: false })
    seedApproval({ status: "executed", notification_sent: true })
    seedApproval({ status: "pending", notification_sent: false })

    const n = await runNotificationSweep()
    expect(n).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// proposeAction — propose notification fires on a fresh insert
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeAction propose notification (deliverable #4)", () => {
  it("writes a 'New action proposed' message to the CRM team chat on a fresh proposal", async () => {
    const out = await proposeAction({
      tool_name: "update_account_notes",
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Follow up with client" },
      rationale: "client requested a follow-up",
    })
    expect(out).toContain("Action proposed and queued for approval")

    const msgs = h.store.internal_messages ?? []
    expect(msgs).toHaveLength(1)
    expect(msgs[0].message).toContain("New action proposed — awaiting approval")
    expect(msgs[0].message).toContain("Append note to account")
  })

  it("does NOT send a propose notification when the proposal is rejected by validation", async () => {
    const out = await proposeAction({ tool_name: "not_a_real_tool", params: {} })
    expect(out).toContain("is not an approvable action")
    expect(h.store.internal_messages ?? []).toHaveLength(0)
  })
})
