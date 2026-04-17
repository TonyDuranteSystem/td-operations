/**
 * P3.6 — lib/operations/config.ts unit tests
 *
 * Covers updateSOP / updatePipelineStage / updateDevTask: validation,
 * happy path, optimistic lock (sop_runbooks + dev_tasks only — pipeline_stages
 * has no updated_at column), stale + not_found + db error, action_log shape,
 * and dev_task completed_at auto-stamp on status='done'.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let existingRow: { id: string; updated_at?: string | null } | null = null
let updateReturnsRows: Array<{ id: string; updated_at?: string | null }> = []
let updateError: { message: string } | null = null
let expectStaleLockFilter: string | null = null

const updateCalls: Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, string> }> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mock ────────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      let pendingPatch: Record<string, unknown> | null = null
      const filters: Record<string, string> = {}
      let readMode: "update" | "select" = "update"
      Object.assign(chain, {
        update: vi.fn((patch: Record<string, unknown>) => {
          pendingPatch = patch
          readMode = "update"
          return chain
        }),
        select: vi.fn(() => {
          if (!pendingPatch) readMode = "select"
          return chain
        }),
        eq: vi.fn((col: string, value: string) => {
          filters[col] = value
          return chain
        }),
        maybeSingle: vi.fn(() => {
          if (readMode === "select") {
            return Promise.resolve({ data: existingRow, error: null })
          }
          return Promise.resolve({ data: existingRow ? { id: existingRow.id } : null, error: null })
        }),
        then: (resolve: (v: unknown) => void) => {
          if (pendingPatch) {
            const stale =
              expectStaleLockFilter !== null &&
              filters["updated_at"] === expectStaleLockFilter
            const rows = stale ? [] : updateReturnsRows
            updateCalls.push({ table, patch: pendingPatch, filters: { ...filters } })
            pendingPatch = null
            for (const k of Object.keys(filters)) delete filters[k]
            resolve({ data: rows, error: updateError })
            return
          }
          resolve({ data: null, error: null })
        },
      })
      return chain
    },
  },
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => actionLogCalls.push(params)),
}))

beforeEach(() => {
  existingRow = null
  updateReturnsRows = [{ id: "row-1", updated_at: "2026-04-17T22:00:00Z" }]
  updateError = null
  expectStaleLockFilter = null
  updateCalls.length = 0
  actionLogCalls.length = 0
})

// ─── updateSOP ───────────────────────────────────────────

describe("updateSOP", () => {
  it("returns error when id is missing", async () => {
    const { updateSOP } = await import("@/lib/operations/config")
    const r = await updateSOP({ id: "", patch: { title: "new" } })
    expect(r.outcome).toBe("error")
  })

  it("returns error when patch is empty", async () => {
    const { updateSOP } = await import("@/lib/operations/config")
    const r = await updateSOP({ id: "sop-1", patch: {} })
    expect(r.outcome).toBe("error")
  })

  it("writes patch, stamps updated_at, logs action_log", async () => {
    existingRow = { id: "sop-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateSOP } = await import("@/lib/operations/config")
    const r = await updateSOP({
      id: "sop-1",
      patch: { title: "Updated Title", version: "v8" },
      actor: "dashboard:antonio",
    })
    expect(r.success).toBe(true)
    expect(r.outcome).toBe("updated")
    expect(updateCalls[0].table).toBe("sop_runbooks")
    expect(updateCalls[0].patch).toMatchObject({ title: "Updated Title", version: "v8" })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()
    expect(actionLogCalls[0].table_name).toBe("sop_runbooks")
    expect(actionLogCalls[0].actor).toBe("dashboard:antonio")
  })

  it("applies optimistic-lock filter", async () => {
    existingRow = { id: "sop-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateSOP } = await import("@/lib/operations/config")
    await updateSOP({
      id: "sop-1",
      patch: { version: "v9" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(updateCalls[0].filters.updated_at).toBe("2026-04-17T10:00:00Z")
  })

  it("returns stale on lock miss", async () => {
    existingRow = { id: "sop-1", updated_at: "2026-04-17T10:00:00Z" }
    updateReturnsRows = []
    const { updateSOP } = await import("@/lib/operations/config")
    const r = await updateSOP({
      id: "sop-1",
      patch: { version: "v9" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(r.outcome).toBe("stale")
  })

  it("returns not_found when row missing", async () => {
    existingRow = null
    updateReturnsRows = []
    const { updateSOP } = await import("@/lib/operations/config")
    const r = await updateSOP({ id: "missing", patch: { title: "x" } })
    expect(r.outcome).toBe("not_found")
  })
})

// ─── updatePipelineStage ─────────────────────────────────

describe("updatePipelineStage", () => {
  it("does NOT stamp updated_at (pipeline_stages has no column)", async () => {
    existingRow = { id: "stage-1" }
    const { updatePipelineStage } = await import("@/lib/operations/config")
    await updatePipelineStage({
      id: "stage-1",
      patch: { stage_name: "New Name", sla_days: 5 },
    })
    expect(updateCalls[0].table).toBe("pipeline_stages")
    expect(updateCalls[0].patch).toMatchObject({ stage_name: "New Name", sla_days: 5 })
    expect(updateCalls[0].patch.updated_at).toBeUndefined()
  })

  it("logs action_log with table_name=pipeline_stages", async () => {
    existingRow = { id: "stage-1" }
    const { updatePipelineStage } = await import("@/lib/operations/config")
    await updatePipelineStage({
      id: "stage-1",
      patch: { stage_name: "New Name" },
      actor: "dashboard:support",
    })
    expect(actionLogCalls[0].table_name).toBe("pipeline_stages")
    expect(actionLogCalls[0].actor).toBe("dashboard:support")
  })
})

// ─── updateDevTask ───────────────────────────────────────

describe("updateDevTask", () => {
  it("auto-stamps completed_at when status flips to done", async () => {
    existingRow = { id: "dt-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDevTask } = await import("@/lib/operations/config")
    await updateDevTask({ id: "dt-1", patch: { status: "done" } })
    const patch = updateCalls[0].patch as Record<string, unknown>
    expect(patch.status).toBe("done")
    expect(patch.completed_at).toBeTruthy()
  })

  it("does NOT overwrite completed_at if caller set it", async () => {
    existingRow = { id: "dt-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDevTask } = await import("@/lib/operations/config")
    await updateDevTask({
      id: "dt-1",
      patch: { status: "done", completed_at: "2026-01-01T00:00:00Z" },
    })
    expect((updateCalls[0].patch as Record<string, unknown>).completed_at).toBe("2026-01-01T00:00:00Z")
  })

  it("does not stamp completed_at for non-done status changes", async () => {
    existingRow = { id: "dt-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDevTask } = await import("@/lib/operations/config")
    await updateDevTask({ id: "dt-1", patch: { status: "in_progress" } })
    const patch = updateCalls[0].patch as Record<string, unknown>
    expect(patch.completed_at).toBeUndefined()
  })

  it("applies optimistic-lock filter", async () => {
    existingRow = { id: "dt-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDevTask } = await import("@/lib/operations/config")
    await updateDevTask({
      id: "dt-1",
      patch: { priority: "critical" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(updateCalls[0].filters.updated_at).toBe("2026-04-17T10:00:00Z")
  })

  it("surfaces db errors", async () => {
    existingRow = { id: "dt-1", updated_at: "2026-04-17T10:00:00Z" }
    updateError = { message: "enum violation" }
    const { updateDevTask } = await import("@/lib/operations/config")
    const r = await updateDevTask({ id: "dt-1", patch: { status: "bogus" } as never })
    expect(r.outcome).toBe("error")
    expect(r.error).toContain("enum violation")
  })
})
