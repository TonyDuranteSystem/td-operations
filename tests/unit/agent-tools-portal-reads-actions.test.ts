/**
 * New AGENT_TOOLS added 2026-06-13 (reads + start the action rail):
 *   - portal_chat_inbox / portal_chat_read  (read-only)
 *   - update_deadline / send_team_message    (approval-rail actions)
 *
 * Verifies: tool definitions exist + are well-formed, the read tools are wired
 * into the worker's read surface (and thread-routing), the action tools are on
 * the approval allow-list (with constraints) but NOT in the worker's read set,
 * and the executeTool dispatch + handler validation behave correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Chainable supabase mock — terminal methods (maybeSingle/single) resolve from a
// per-test response map keyed by table; insert captures the row.
let responses: Record<string, { data?: unknown; error?: { message: string } | null; count?: number }>
let inserted: Record<string, Record<string, unknown>>

function builder() {
  const state = { table: "", op: "select" as "select" | "insert" | "update" }
  // For a select, return the configured response; for an insert, synthesize a
  // created row (with id) unless the test configured an explicit error — this is
  // what lets one table back both a "no existing row" lookup and an insert.
  const resolveSingle = () => {
    if (state.op === "insert") {
      const cfg = responses[state.table]
      return { data: (cfg?.data as unknown) ?? { id: `${state.table}-new`, created_at: "T" }, error: cfg?.error ?? null }
    }
    return responses[state.table] ?? { data: null }
  }
  const b: Record<string, (...a: unknown[]) => unknown> = {
    from: (t: unknown) => { state.table = String(t); state.op = "select"; return b },
    select: () => b, eq: () => b, is: () => b, not: () => b, order: () => b, limit: () => b,
    insert: (row: unknown) => { state.op = "insert"; inserted[state.table] = row as Record<string, unknown>; return b },
    update: (row: unknown) => { state.op = "update"; inserted[state.table] = row as Record<string, unknown>; return b },
    maybeSingle: async () => (state.op === "insert" ? resolveSingle() : responses[state.table] ?? { data: null }),
    single: async () => resolveSingle(),
    // Thenable: awaiting the builder directly (list / count queries) resolves the
    // configured response, defaulting to an empty list.
    then: (resolve: (v: unknown) => void) => resolve(responses[state.table] ?? { data: [], error: null }),
  }
  return b
}

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder().from(t) } }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))
vi.mock("@/lib/portal/web-push", () => ({ sendPushToAdmin: vi.fn().mockResolvedValue(undefined) }))

import { AGENT_TOOLS, executeTool } from "@/lib/ai-agent/tools"
import { WORKER_READ_ONLY_TOOL_NAMES } from "@/lib/ai-agent/worker-tools"
import { APPROVABLE_TOOL_NAMES, APPROVABLE_TOOL_CONSTRAINTS } from "@/lib/ai-agent/approvable-tools"
import { CRM_READ_TOOL_NAMES } from "@/lib/ai-agent/thread-routing"

beforeEach(() => { responses = {}; inserted = {} })

describe("new tool definitions", () => {
  it("all four are registered in AGENT_TOOLS and well-formed", () => {
    for (const name of ["portal_chat_inbox", "portal_chat_read", "update_deadline", "send_team_message"]) {
      const t = AGENT_TOOLS.find((x) => x.name === name)
      expect(t, `${name} missing from AGENT_TOOLS`).toBeDefined()
      expect(typeof t!.description).toBe("string")
      expect(t!.parameters).toBeTruthy()
    }
  })
})

describe("wiring: reads on the research surface, actions on the approval rail", () => {
  it("portal reads are in the worker read allow-list AND thread-routing CRM reads", () => {
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("portal_chat_inbox")).toBe(true)
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("portal_chat_read")).toBe(true)
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("recall_memories")).toBe(true)
    expect((CRM_READ_TOOL_NAMES as readonly string[]).includes("portal_chat_read")).toBe(true)
  })

  it("action tools are approvable (with constraints) and NOT in the read set", () => {
    for (const name of ["update_deadline", "send_team_message"]) {
      expect(APPROVABLE_TOOL_NAMES.has(name)).toBe(true)
      expect(APPROVABLE_TOOL_CONSTRAINTS[name]).toBeDefined()
      expect(WORKER_READ_ONLY_TOOL_NAMES.has(name)).toBe(false)
    }
  })
})

describe("portal_chat_read handler", () => {
  it("requires an account_id or contact_id", async () => {
    const r = await executeTool("portal_chat_read", {})
    expect(r).toContain("account_id or contact_id is required")
  })

  it("formats a thread when messages exist", async () => {
    responses.accounts = { data: { company_name: "Uxio Test LLC" } }
    responses.portal_messages = {
      data: [
        { id: "m2", sender_type: "client", message: "hi there", read_at: null, created_at: "2026-06-13T10:00:00Z", contacts: null },
        { id: "m1", sender_type: "admin", message: "hello", read_at: "x", created_at: "2026-06-13T09:00:00Z", contacts: null },
      ],
      error: null,
    }
    const r = await executeTool("portal_chat_read", { account_id: "acc-1" })
    expect(r).toContain("Uxio Test LLC")
    expect(r).toContain("hi there")
    expect(r).toContain("UNREAD")
  })
})

describe("update_deadline handler", () => {
  it("rejects when no id is given", async () => {
    const r = await executeTool("update_deadline", { status: "Filed" })
    expect(r).toContain("requires a deadline id")
  })

  it("rejects when there is nothing to update", async () => {
    const r = await executeTool("update_deadline", { id: "d-1" })
    expect(r).toContain("nothing to update")
  })

  it("updates and confirms when fields are provided", async () => {
    responses.deadlines = { data: { id: "d-1", deadline_type: "BOI", status: "Filed", due_date: "2026-07-01", accounts: { company_name: "Uxio Test LLC" } }, error: null }
    const r = await executeTool("update_deadline", { id: "d-1", status: "Filed", confirmation_number: "ABC123" })
    expect(r).toContain("✅ Deadline updated")
    expect(r).toContain("Uxio Test LLC")
    expect(inserted.deadlines).toMatchObject({ confirmation_number: "ABC123" })
    expect(inserted.deadlines.updated_at).toBeTruthy()
  })
})

describe("send_team_message handler", () => {
  it("requires a recipient", async () => {
    const r = await executeTool("send_team_message", { message: "check this" })
    expect(r).toContain("requires an account_id or a contact_id")
  })

  it("requires a non-empty message", async () => {
    const r = await executeTool("send_team_message", { account_id: "acc-1", message: "  " })
    expect(r).toContain("non-empty message")
  })

  it("posts an internal note (new thread) and never exposes it to the client", async () => {
    responses.accounts = { data: { company_name: "Uxio Test LLC" } }
    responses.internal_threads = { data: null } // no existing thread → create
    responses.internal_messages = { data: { id: "im-1", created_at: "T" }, error: null }
    const r = await executeTool("send_team_message", { account_id: "acc-1", message: "Check Delaware SOS" })
    expect(r).toContain("Internal team note posted")
    expect(r).toContain("Not visible to the client")
    expect(inserted.internal_messages).toMatchObject({ sender_name: "Claude", message: "Check Delaware SOS" })
  })
})
