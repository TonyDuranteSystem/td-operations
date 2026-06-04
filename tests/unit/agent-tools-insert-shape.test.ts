/**
 * Regression guard for AI-agent write-tool insert shapes (lib/ai-agent/tools.ts).
 *
 * Why this exists: `tasks.attachments` is `jsonb NOT NULL` with no DB default, so
 * any insert that omits it throws `23502` against the real DB. The mocked-Supabase
 * unit tests can't see a NOT-NULL constraint, so this test asserts the insert
 * PAYLOAD instead — it pins the columns the DB requires (attachments) and the
 * Part-1 enum normalization (priority/category) on the create_task path.
 *
 * Found via the Phase 2 Slice 3 sandbox E2E (2026-06-04): create_task failed with
 * `null value in column "attachments"` until the helper supplied `attachments: []`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Capture the payload passed to .from('tasks').insert(...).
const h = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; row: Record<string, unknown> }> }))

vi.mock("@/lib/supabase-admin", () => {
  const makeChain = (table: string) => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (row: Record<string, unknown>) => {
      h.inserts.push({ table, row })
      return {
        select: () => ({
          single: async () => ({
            data: { id: "task-1", ...row },
            error: null,
          }),
        }),
      }
    },
  })
  return {
    supabaseAdmin: {
      from: (table: string) => makeChain(table),
    },
  }
})

import { executeTool } from "@/lib/ai-agent/tools"

beforeEach(() => {
  h.inserts.length = 0
})

describe("create_task insert shape", () => {
  it("always supplies attachments (tasks.attachments is NOT NULL, no default)", async () => {
    await executeTool("create_task", { task_title: "X", account_id: "a" })
    const row = h.inserts.find((i) => i.table === "tasks")?.row
    expect(row).toBeDefined()
    expect(row).toHaveProperty("attachments")
    expect(row!.attachments).toEqual([])
  })

  it("uses valid enum defaults (priority Normal, category Internal) — not the old invalid medium/Admin", async () => {
    await executeTool("create_task", { task_title: "X" })
    const row = h.inserts.find((i) => i.table === "tasks")!.row
    expect(row.priority).toBe("Normal")
    expect(row.category).toBe("Internal")
    expect(row.status).toBe("To Do")
  })

  it("normalizes flexible enum input on the execution path (medium→Normal, follow up→Follow-up)", async () => {
    await executeTool("create_task", { task_title: "X", priority: "medium", category: "follow up" })
    const row = h.inserts.find((i) => i.table === "tasks")!.row
    expect(row.priority).toBe("Normal")
    expect(row.category).toBe("Follow-up")
  })
})
