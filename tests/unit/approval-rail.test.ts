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
import { proposeAction, batchPropose } from "@/lib/ai-agent/worker-tools"
import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"
import { AGENT_TOOLS } from "@/lib/ai-agent/tools"

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  h.store.length = 0
  process.env = { ...ORIGINAL_ENV }
})

// ─────────────────────────────────────────────────────────────────────────────
// Pure layer: approvable-tools.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("approvable-tools — allow-list", () => {
  it("contains exactly the 14 expected action tools", () => {
    // 12 original + update_deadline + send_team_message (2026-06-13).
    expect(APPROVABLE_TOOL_NAMES.size).toBe(14)
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
  it("matches a SHA-256 of the KEY-CANONICAL JSON of params", () => {
    const params = { to: "a@b.c", subject: "Hi", body: "Hello" }
    // canonical = keys sorted: { body, subject, to }
    const canonical = JSON.stringify({ body: "Hello", subject: "Hi", to: "a@b.c" })
    const expected = createHash("sha256").update(canonical).digest("hex")
    expect(computeParamsHash(params)).toBe(expected)
  })

  it("is deterministic for the same params and differs for different params", () => {
    const a = computeParamsHash({ x: 1 })
    expect(computeParamsHash({ x: 1 })).toBe(a)
    expect(computeParamsHash({ x: 2 })).not.toBe(a)
  })

  it("is INDEPENDENT of object key order (JSONB round-trip safety)", () => {
    // Regression for the Slice 2 E2E bug: Postgres JSONB reorders keys, so the
    // hash must not depend on insertion order or the integrity check fails on
    // every real action.
    const a = computeParamsHash({ task_title: "X", account_id: "a", priority: "medium" })
    const b = computeParamsHash({ priority: "medium", account_id: "a", task_title: "X" })
    expect(a).toBe(b)
  })

  it("is independent of key order in nested objects too", () => {
    const a = computeParamsHash({ outer: { x: 1, y: 2 }, z: 3 })
    const b = computeParamsHash({ z: 3, outer: { y: 2, x: 1 } })
    expect(a).toBe(b)
  })

  it("still distinguishes arrays by element order (order is meaningful there)", () => {
    expect(computeParamsHash({ list: [1, 2] })).not.toBe(computeParamsHash({ list: [2, 1] }))
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

  it("persists an optional thread_id on the queued row", async () => {
    const out = await proposeAction({
      tool_name: "create_task",
      params: { task_title: "Threaded" },
      thread_id: "11111111-2222-3333-4444-555555555555",
    })
    expect(out).toContain("queued for approval")
    expect(h.store).toHaveLength(1)
    expect(h.store[0].thread_id).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("stores thread_id = null when omitted", async () => {
    await proposeAction({ tool_name: "create_task", params: { task_title: "No thread" } })
    expect(h.store[0].thread_id).toBeNull()
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase D — env lane tag + batch grouping
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeAction — env lane tag (Phase D)", () => {
  it("stamps env from APPROVAL_ENV when set", async () => {
    process.env.APPROVAL_ENV = "staging"
    await proposeAction({ tool_name: "create_task", params: { task_title: "X" } })
    expect(h.store[0].env).toBe("staging")
  })

  it("falls back to NODE_ENV / 'production' when APPROVAL_ENV is unset", async () => {
    delete process.env.APPROVAL_ENV
    process.env.NODE_ENV = "production"
    await proposeAction({ tool_name: "create_task", params: { task_title: "Y" } })
    expect(h.store[0].env).toBe("production")
  })
})

describe("batchPropose (Phase D)", () => {
  it("mints ONE batch_id shared by every proposal in the batch", async () => {
    const res = await batchPropose([
      { tool_name: "create_task", params: { task_title: "A" } },
      { tool_name: "create_task", params: { task_title: "B" } },
      { tool_name: "update_account_notes", params: { account_id: "acc", note: "n" } },
    ])
    expect(res.count).toBe(3)
    expect(h.store).toHaveLength(3)
    const batchIds = new Set(h.store.map((r) => r.batch_id))
    expect(batchIds.size).toBe(1)
    expect([...batchIds][0]).toBe(res.batch_id)
    expect(res.batch_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("reuses a supplied batch_id", async () => {
    const fixed = "11111111-1111-4111-8111-111111111111"
    const res = await batchPropose([{ tool_name: "create_task", params: { task_title: "A" } }], { batch_id: fixed })
    expect(res.batch_id).toBe(fixed)
    expect(h.store[0].batch_id).toBe(fixed)
  })

  it("still validates each proposal — a bad tool_name yields an error string, no row", async () => {
    const res = await batchPropose([
      { tool_name: "create_task", params: { task_title: "ok" } },
      { tool_name: "not_a_tool", params: {} },
    ])
    expect(res.count).toBe(2)
    expect(res.results[1]).toContain("not an approvable action")
    expect(h.store).toHaveLength(1) // only the valid one inserted
  })
})

describe("approval_list — batch_id filter (Phase D)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function captureHandler(): (args: any) => Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handler: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAgentApprovalTools({ tool: (n: string, _d: string, _s: any, fn: any) => { if (n === "approval_list") handler = fn } } as any)
    return handler
  }

  it("restricts results to one batch_id", async () => {
    const batch = await batchPropose([
      { tool_name: "create_task", params: { task_title: "in-batch-1" } },
      { tool_name: "create_task", params: { task_title: "in-batch-2" } },
    ])
    await proposeAction({ tool_name: "create_task", params: { task_title: "solo" } })

    const handler = captureHandler()
    const res = await handler({ status: "pending", batch_id: batch.batch_id, limit: 20 })
    const rows = JSON.parse(res.content[0].text)
    expect(rows).toHaveLength(2)
    expect(rows.every((r: { batch_id: string }) => r.batch_id === batch.batch_id)).toBe(true)
  })
})
