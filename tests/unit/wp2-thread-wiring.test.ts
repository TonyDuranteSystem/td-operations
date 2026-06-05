/**
 * Hermes ↔ Claude bridge — WP2: thread/investigation wiring.
 *
 * Pins the WP2 contract at the MCP-tool layer:
 *   - thread_create opens a thread_summaries row with the chosen thread_type and
 *     prompt_version = WORKER_PROMPT_VERSION, and returns { thread_id, type, title }.
 *   - thread_create with account_id / contact_id records them in accounts_affected.
 *   - agent_msg_send persists an optional thread_id on the agent_messages row.
 *   - agent_msg_send WITHOUT thread_id still works (thread_id stored as null) —
 *     backward-compatible with every pre-WP2 caller.
 *
 * The thread row-creation logic itself (idempotency, type coercion, accounts
 * cleaning) is covered in thread-summaries.test.ts; here we assert the tools
 * wire those args through correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Stateful in-memory Supabase stand-in (thread_summaries + agent_messages) ──
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables: Record<string, any[]> = { thread_summaries: [], agent_messages: [] }
  return { tables }
})

vi.mock("@/lib/supabase-admin", () => {
  function builder(table: string) {
    const state: {
      op: "select" | "insert" | "update"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload?: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eqs: Array<[string, any]>
    } = { op: "select", eqs: [] }

    const store = () => (h.tables[table] ??= [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (r: any) => state.eqs.every(([k, v]) => r[k] === v)

    function run(): { data: unknown; error: null } {
      if (state.op === "insert") {
        const row = { ...state.payload }
        if (!("created_at" in row)) row.created_at = "2026-06-05T00:00:00Z"
        if (!("id" in row)) row.id = `id-${store().length + 1}`
        if (!("status" in row) && table === "agent_messages") row.status = "pending"
        store().push(row)
        return { data: row, error: null }
      }
      if (state.op === "update") {
        const hit = store().filter(matches)
        for (const r of hit) Object.assign(r, state.payload)
        return { data: hit, error: null }
      }
      return { data: store().filter(matches), error: null }
    }

    const api = {
      select: (_cols?: string) => api,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insert: (payload: any) => { state.op = "insert"; state.payload = payload; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (payload: any) => { state.op = "update"; state.payload = payload; return api },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq: (col: string, val: any) => { state.eqs.push([col, val]); return api },
      maybeSingle: async () => {
        const { data } = run()
        const arr = data as unknown[]
        return { data: Array.isArray(arr) ? (arr[0] ?? null) : (data ?? null), error: null }
      },
      single: async () => {
        const { data } = run()
        const arr = data as unknown[]
        return { data: Array.isArray(arr) ? (arr[0] ?? null) : (data ?? null), error: null }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: any) => void) => resolve(run()),
    }
    return api
  }

  return { supabaseAdmin: { from: (table: string) => builder(table) } }
})

// worker-tools pulls the notification graph at import — isolate it (we never call it here).
vi.mock("@/lib/ai-agent/approval-notifications", () => ({
  emitApprovalOutcome: vi.fn(async () => true),
  sendApprovalNotification: vi.fn(async () => true),
}))

import { registerAgentThreadTools } from "@/lib/mcp/tools/agent-threads"
import { registerAgentMessageTools } from "@/lib/mcp/tools/agent-messages"
import { WORKER_PROMPT_VERSION } from "@/lib/ai-agent/worker-tools"

// Capture every tool handler a register* fn wires up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlers(register: (s: any) => void): Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map: Record<string, any> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register({ tool: (name: string, _d: string, _s: any, fn: any) => { map[name] = fn } } as any)
  return map
}

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  h.tables.thread_summaries.length = 0
  h.tables.agent_messages.length = 0
  process.env = { ...ORIGINAL_ENV }
  delete process.env.CRON_SECRET // so agent_msg_send's direct trigger skips the network call
})

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"
const CONTACT_ID = "22222222-2222-4222-8222-222222222222"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─────────────────────────────────────────────────────────────────────────────
// thread_create
// ─────────────────────────────────────────────────────────────────────────────
describe("thread_create (WP2)", () => {
  it("creates a thread_summaries row with the chosen type + prompt_version, returns {thread_id,type,title}", async () => {
    const res = await handlers(registerAgentThreadTools).thread_create({
      type: "bug_report",
      title: "Lease render bug",
    })
    const out = JSON.parse(res.content[0].text)
    expect(out.thread_id).toMatch(UUID_RE)
    expect(out.type).toBe("bug_report")
    expect(out.title).toBe("Lease render bug")

    expect(h.tables.thread_summaries).toHaveLength(1)
    const row = h.tables.thread_summaries[0]
    expect(row.thread_id).toBe(out.thread_id)
    expect(row.thread_type).toBe("bug_report")
    expect(row.prompt_version).toBe(WORKER_PROMPT_VERSION)
    expect(row.accounts_affected).toBeNull() // none supplied
  })

  it("records account_id + contact_id in accounts_affected", async () => {
    const res = await handlers(registerAgentThreadTools).thread_create({
      type: "client_audit",
      account_id: ACCOUNT_ID,
      contact_id: CONTACT_ID,
    })
    const out = JSON.parse(res.content[0].text)
    expect(out.type).toBe("client_audit")
    const row = h.tables.thread_summaries.find((r) => r.thread_id === out.thread_id)
    expect(row.accounts_affected).toEqual([ACCOUNT_ID, CONTACT_ID])
  })

  it("records only account_id when contact_id is omitted", async () => {
    const res = await handlers(registerAgentThreadTools).thread_create({
      type: "investigation",
      account_id: ACCOUNT_ID,
    })
    const out = JSON.parse(res.content[0].text)
    const row = h.tables.thread_summaries.find((r) => r.thread_id === out.thread_id)
    expect(row.accounts_affected).toEqual([ACCOUNT_ID])
  })

  it("mints a distinct thread_id per call", async () => {
    const a = JSON.parse((await handlers(registerAgentThreadTools).thread_create({ type: "investigation" })).content[0].text)
    const b = JSON.parse((await handlers(registerAgentThreadTools).thread_create({ type: "investigation" })).content[0].text)
    expect(a.thread_id).not.toBe(b.thread_id)
    expect(h.tables.thread_summaries).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// agent_msg_send — thread_id passthrough
// ─────────────────────────────────────────────────────────────────────────────
describe("agent_msg_send — thread_id (WP2)", () => {
  const THREAD_ID = "33333333-3333-4333-8333-333333333333"

  it("stores thread_id on the agent_messages row when provided", async () => {
    const res = await handlers(registerAgentMessageTools).agent_msg_send({
      recipient: "claude",
      subject: "Follow-up",
      body: "Continue the investigation.",
      thread_id: THREAD_ID,
      as_party: "hermes",
    })
    expect(res.content[0].text).toContain("Message queued")
    expect(h.tables.agent_messages).toHaveLength(1)
    expect(h.tables.agent_messages[0].thread_id).toBe(THREAD_ID)
  })

  it("stores thread_id = null when omitted (backward compatible)", async () => {
    const res = await handlers(registerAgentMessageTools).agent_msg_send({
      recipient: "claude",
      subject: "One-shot",
      body: "Quick question.",
      as_party: "hermes",
    })
    expect(res.content[0].text).toContain("Message queued")
    expect(h.tables.agent_messages).toHaveLength(1)
    expect(h.tables.agent_messages[0].thread_id).toBeNull()
  })
})
