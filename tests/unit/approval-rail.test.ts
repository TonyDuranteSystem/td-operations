/**
 * Hermes ↔ Claude bridge — Phase 2, Slice 1: action-authorization rail.
 *
 * Pairs with:
 *   - lib/ai-agent/approvable-tools.ts  (pure: allow-list, hash, schema validation)
 *   - lib/ai-agent/worker-tools.ts      (proposeAction — QUEUES, never executes)
 *   - lib/mcp/tools/agent-approvals.ts  (approval_list — read-only)
 *
 * These tests pin the Slice 1 contract: a proposal is validated and queued as a
 * pending row, malformed/disallowed proposals are rejected with no insert,
 * idempotency returns the existing row, and NOTHING executes.
 */

import { createHash } from "crypto"
import { describe, it, expect, beforeEach, vi } from "vitest"

// Stateful in-memory stand-in for the approval_queue table. Hoisted so the
// vi.mock factory (which is hoisted above imports) can reference it.
const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any[] = []
  return { store }
})

vi.mock("@/lib/supabase-admin", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeQuery(filter: Record<string, any>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matches = (r: any) => Object.entries(filter).every(([k, v]) => r[k] === v)
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eq: (col: string, val: any) => makeQuery({ ...filter, [col]: val }),
      maybeSingle: async () => ({ data: h.store.find(matches) ?? null, error: null }),
      order: () => ({
        limit: async () => ({
          data: h.store
            .filter(matches)
            .slice()
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
          error: null,
        }),
      }),
    }
  }

  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== "approval_queue") throw new Error(`unexpected table ${table}`)
        return {
          select: () => makeQuery({}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          insert: (row: Record<string, any>) => ({
            select: () => ({
              single: async () => {
                if (row.idempotency_key && h.store.find((r) => r.idempotency_key === row.idempotency_key)) {
                  return { data: null, error: { code: "23505", message: "duplicate key" } }
                }
                const newRow = {
                  id: `id-${h.store.length + 1}`,
                  created_at: `2026-06-04T00:00:0${h.store.length}Z`,
                  ...row,
                }
                h.store.push(newRow)
                return { data: newRow, error: null }
              },
            }),
          }),
        }
      },
    },
  }
})

import {
  APPROVABLE_TOOL_NAMES,
  isApprovableTool,
  computeParamsHash,
  validateToolParams,
  APPROVABLE_TOOL_CONSTRAINTS,
} from "@/lib/ai-agent/approvable-tools"
import { proposeAction } from "@/lib/ai-agent/worker-tools"
import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"
import { AGENT_TOOLS } from "@/lib/ai-agent/tools"

beforeEach(() => {
  h.store.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
// Pure layer: approvable-tools.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("approvable-tools — allow-list", () => {
  it("contains exactly the 12 expected action tools", () => {
    expect(APPROVABLE_TOOL_NAMES.size).toBe(12)
  })

  it("every approvable name resolves to a real AGENT_TOOLS entry", () => {
    const realNames = new Set(AGENT_TOOLS.map((t) => t.name))
    for (const name of APPROVABLE_TOOL_NAMES) {
      expect(realNames.has(name), `approvable tool "${name}" not in AGENT_TOOLS`).toBe(true)
    }
  })

  it("every approvable name has constraint metadata", () => {
    for (const name of APPROVABLE_TOOL_NAMES) {
      expect(APPROVABLE_TOOL_CONSTRAINTS[name], `no constraints for "${name}"`).toBeDefined()
      expect(APPROVABLE_TOOL_CONSTRAINTS[name].surface.length).toBeGreaterThan(0)
    }
  })

  it("flags send_email as external + irreversible and advance_service_stage as cascading", () => {
    expect(APPROVABLE_TOOL_CONSTRAINTS.send_email.external).toBe(true)
    expect(APPROVABLE_TOOL_CONSTRAINTS.send_email.irreversible).toBe(true)
    expect(APPROVABLE_TOOL_CONSTRAINTS.advance_service_stage.cascades).toBe(true)
  })

  it("isApprovableTool is true for approvable, false for read tools", () => {
    expect(isApprovableTool("send_email")).toBe(true)
    expect(isApprovableTool("search_accounts")).toBe(false)
    expect(isApprovableTool("totally_made_up")).toBe(false)
  })
})

describe("approvable-tools — computeParamsHash", () => {
  it("matches a SHA-256 of JSON.stringify(params)", () => {
    const params = { to: "a@b.c", subject: "Hi", body: "Hello" }
    const expected = createHash("sha256").update(JSON.stringify(params)).digest("hex")
    expect(computeParamsHash(params)).toBe(expected)
  })

  it("is deterministic for the same params and differs for different params", () => {
    const a = computeParamsHash({ x: 1 })
    expect(computeParamsHash({ x: 1 })).toBe(a)
    expect(computeParamsHash({ x: 2 })).not.toBe(a)
  })
})

describe("approvable-tools — validateToolParams", () => {
  it("accepts valid params for a known tool", () => {
    const r = validateToolParams("send_email", { to: "a@b.c", subject: "S", body: "B" })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it("rejects when a required param is missing", () => {
    const r = validateToolParams("send_email", { subject: "S", body: "B" }) // no `to`
    expect(r.ok).toBe(false)
    expect(r.errors.join(" ")).toContain("to")
  })

  it("rejects a wrong param type", () => {
    const r = validateToolParams("create_task", { task_title: 123 }) // should be string
    expect(r.ok).toBe(false)
  })

  it("rejects an enum violation", () => {
    const r = validateToolParams("update_task", { task_id: "x", status: "Bogus" })
    expect(r.ok).toBe(false)
  })

  it("rejects an unknown tool", () => {
    const r = validateToolParams("nope", {})
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// proposeAction — QUEUES, never executes
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeAction", () => {
  it("queues a valid proposal as a pending row with the correct params_hash", async () => {
    const params = { to: "client@x.com", subject: "Docs", body: "Please send your docs." }
    const out = await proposeAction({ tool_name: "send_email", params, rationale: "client asked" })

    expect(out).toContain("queued for approval")
    expect(out).toContain("NOT executed")
    expect(h.store).toHaveLength(1)
    expect(h.store[0].status).toBe("pending")
    expect(h.store[0].tool_name).toBe("send_email")
    expect(h.store[0].requested_by).toBe("worker")
    expect(h.store[0].params_hash).toBe(computeParamsHash(params))
    expect(h.store[0].rationale).toBe("client asked")
  })

  it("rejects a tool_name not in the allow-list — no insert", async () => {
    const out = await proposeAction({ tool_name: "drop_database", params: {} })
    expect(out).toContain("not an approvable action")
    expect(h.store).toHaveLength(0)
  })

  it("rejects a read tool (search_accounts) — proposals are for actions only", async () => {
    const out = await proposeAction({ tool_name: "search_accounts", params: {} })
    expect(out).toContain("not an approvable action")
    expect(h.store).toHaveLength(0)
  })

  it("rejects invalid params for an approvable tool — no insert", async () => {
    const out = await proposeAction({ tool_name: "send_email", params: { subject: "S" } }) // missing to + body
    expect(out).toContain("Invalid params")
    expect(h.store).toHaveLength(0)
  })

  it("idempotency: same key twice returns the existing row, no duplicate", async () => {
    const params = { account_id: "acc-1", note: "called client" }
    const first = await proposeAction({
      tool_name: "update_account_notes",
      params,
      idempotency_key: "k-123",
    })
    expect(first).toContain("queued for approval")
    expect(h.store).toHaveLength(1)

    const second = await proposeAction({
      tool_name: "update_account_notes",
      params,
      idempotency_key: "k-123",
    })
    expect(second).toContain("Duplicate idempotency_key")
    expect(second).toContain("returning existing")
    expect(h.store).toHaveLength(1) // no new row
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// approval_list — read-only MCP tool
// ─────────────────────────────────────────────────────────────────────────────

describe("approval_list MCP tool", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function captureHandler(): (args: any) => Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handler: any
    const fakeServer = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, _desc: string, _schema: any, fn: any) => {
        if (name === "approval_list") handler = fn
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    registerAgentApprovalTools(fakeServer)
    return handler
  }

  it("returns pending rows newest-first", async () => {
    await proposeAction({ tool_name: "create_task", params: { task_title: "First" } })
    await proposeAction({ tool_name: "create_task", params: { task_title: "Second" } })

    const handler = captureHandler()
    const res = await handler({ status: "pending", limit: 20 })
    const text = res.content[0].text
    const rows = JSON.parse(text)
    expect(rows).toHaveLength(2)
    // newest-first: "Second" was inserted later (larger created_at)
    expect(rows[0].params.task_title).toBe("Second")
    expect(rows.every((r: { status: string }) => r.status === "pending")).toBe(true)
  })

  it("returns an empty message when no proposals match the status", async () => {
    const handler = captureHandler()
    const res = await handler({ status: "approved", limit: 20 })
    expect(res.content[0].text).toContain("No proposals")
  })
})
