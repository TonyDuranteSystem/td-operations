/**
 * P3.4 #9 — lib/operations/task.ts unit tests
 *
 * Covers: updateTask() validation / happy path / optimistic lock / stale /
 * not_found / db error / Done-auto-completes-date; appendTaskNote() prepend
 * behavior + empty rejection + not_found; updateTasksBulk() scoping
 * (ids / delivery_id / account_id / status_in / title_ilike) + aggregate log +
 * empty outcome + Done-auto-completes-date.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let existingRow: { id: string; notes: string | null; updated_at: string | null } | null = null
let updateReturnsRows: Array<{ id: string; account_id: string | null; updated_at: string | null }> = []
let bulkUpdateReturnsRows: Array<{ id: string }> = []
let updateError: { message: string } | null = null
let expectStaleLockFilter: string | null = null

const updateCalls: Array<{ patch: Record<string, unknown>; filters: Record<string, string | string[]>; ilike?: string }> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "tasks") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      }
      const chain: Record<string, unknown> = {}
      let pendingPatch: Record<string, unknown> | null = null
      const filters: Record<string, string | string[]> = {}
      let ilikeVal: string | undefined
      let isBulk = false
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
          // Anything other than id lookup + its lock sentinel means bulk
          if (col !== "id" && col !== "updated_at") isBulk = true
          return chain
        }),
        in: vi.fn((col: string, values: string[]) => {
          filters[col] = values
          if (col !== "updated_at") isBulk = true
          return chain
        }),
        ilike: vi.fn((_col: string, value: string) => {
          ilikeVal = value
          isBulk = true
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
            if (isBulk) {
              updateCalls.push({ patch: pendingPatch, filters: { ...filters }, ilike: ilikeVal })
              pendingPatch = null
              isBulk = false
              ilikeVal = undefined
              for (const k of Object.keys(filters)) delete filters[k]
              resolve({ data: updateError ? null : bulkUpdateReturnsRows, error: updateError })
              return
            }
            const stale =
              expectStaleLockFilter !== null &&
              filters["updated_at"] === expectStaleLockFilter
            const rows = stale ? [] : updateReturnsRows
            updateCalls.push({ patch: pendingPatch, filters: { ...filters } })
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
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

beforeEach(() => {
  existingRow = null
  updateReturnsRows = [
    { id: "task-1", account_id: "acct-1", updated_at: "2026-04-17T22:00:00Z" },
  ]
  bulkUpdateReturnsRows = [{ id: "task-1" }, { id: "task-2" }, { id: "task-3" }]
  updateError = null
  expectStaleLockFilter = null
  updateCalls.length = 0
  actionLogCalls.length = 0
})

// ─── updateTask — validation ─────────────────────────────

describe("updateTask — validation", () => {
  it("returns error when id is missing", async () => {
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({ id: "", patch: { status: "Done" } })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("id")
  })

  it("returns error when patch is empty", async () => {
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({ id: "task-1", patch: {} })
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("patch")
  })
})

// ─── updateTask — happy path ─────────────────────────────

describe("updateTask — happy path", () => {
  it("writes the patch, stamps updated_at, logs to action_log", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({
      id: "task-1",
      patch: { priority: "High", assigned_to: "Antonio" },
      actor: "dashboard:antonio",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("updated")
    expect(result.task_id).toBe("task-1")

    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].patch).toMatchObject({ priority: "High", assigned_to: "Antonio" })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()
    expect(updateCalls[0].filters.id).toBe("task-1")

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("dashboard:antonio")
    expect(actionLogCalls[0].table_name).toBe("tasks")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
  })

  it("auto-stamps completed_date when status flips to Done", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateTask } = await import("@/lib/operations/task")
    await updateTask({ id: "task-1", patch: { status: "Done" } })
    const patch = updateCalls[0].patch as Record<string, unknown>
    expect(patch.status).toBe("Done")
    expect(patch.completed_date).toBeTruthy()
    expect(typeof patch.completed_date).toBe("string")
  })

  it("does NOT overwrite completed_date if caller already set it", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateTask } = await import("@/lib/operations/task")
    await updateTask({
      id: "task-1",
      patch: { status: "Done", completed_date: "2026-01-15" },
    })
    expect((updateCalls[0].patch as Record<string, unknown>).completed_date).toBe("2026-01-15")
  })

  it("applies optimistic-lock filter when expected_updated_at is provided", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateTask } = await import("@/lib/operations/task")
    await updateTask({
      id: "task-1",
      patch: { status: "In Progress" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(updateCalls[0].filters.updated_at).toBe("2026-04-17T10:00:00Z")
  })

  it("defaults actor to 'system' and summary to fields list", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateTask } = await import("@/lib/operations/task")
    await updateTask({ id: "task-1", patch: { priority: "Urgent" } })
    expect(actionLogCalls[0].actor).toBe("system")
    expect(actionLogCalls[0].summary).toContain("priority")
  })
})

// ─── updateTask — lock miss / not found ──────────────────

describe("updateTask — lock miss / not found", () => {
  it("returns stale when update returns 0 rows but task exists", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    updateReturnsRows = []
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({
      id: "task-1",
      patch: { status: "Done" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("stale")
  })

  it("returns not_found when the task row does not exist", async () => {
    existingRow = null
    updateReturnsRows = []
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({ id: "missing", patch: { status: "Done" } })
    expect(result.outcome).toBe("not_found")
  })
})

// ─── updateTask — db error ───────────────────────────────

describe("updateTask — db error", () => {
  it("surfaces the underlying error", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    updateError = { message: "invalid enum value" }
    const { updateTask } = await import("@/lib/operations/task")
    const result = await updateTask({ id: "task-1", patch: { status: "Invalid" as never } })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("invalid enum")
  })
})

// ─── appendTaskNote ──────────────────────────────────────

describe("appendTaskNote — validation", () => {
  it("rejects empty notes", async () => {
    const { appendTaskNote } = await import("@/lib/operations/task")
    const result = await appendTaskNote({ id: "task-1", note: "  \n  " })
    expect(result.outcome).toBe("empty_note")
  })

  it("returns not_found when task missing", async () => {
    existingRow = null
    const { appendTaskNote } = await import("@/lib/operations/task")
    const result = await appendTaskNote({ id: "missing", note: "hello" })
    expect(result.outcome).toBe("not_found")
  })
})

describe("appendTaskNote — append behavior", () => {
  it("appends a dated entry to existing notes (chronological — new entry last)", async () => {
    existingRow = { id: "task-1", notes: "2026-04-10: earlier note", updated_at: "2026-04-17T10:00:00Z" }
    const { appendTaskNote } = await import("@/lib/operations/task")
    const result = await appendTaskNote({ id: "task-1", note: "client called back", date: "2026-04-17" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("appended")
    const notes = updateCalls[0].patch.notes as string
    expect(notes).toContain("2026-04-10: earlier note")
    expect(notes.endsWith("2026-04-17: client called back")).toBe(true)
  })

  it("uses today's date when none supplied", async () => {
    existingRow = { id: "task-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { appendTaskNote } = await import("@/lib/operations/task")
    await appendTaskNote({ id: "task-1", note: "fresh" })
    const notes = updateCalls[0].patch.notes as string
    const today = new Date().toISOString().split("T")[0]
    expect(notes.endsWith(`${today}: fresh`)).toBe(true)
  })
})

// ─── updateTasksBulk ─────────────────────────────────────

describe("updateTasksBulk — validation", () => {
  it("returns error when scope missing", async () => {
    const { updateTasksBulk } = await import("@/lib/operations/task")
    const result = await updateTasksBulk({ patch: { status: "Done" } })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("scope")
  })

  it("returns error when patch is empty", async () => {
    const { updateTasksBulk } = await import("@/lib/operations/task")
    const result = await updateTasksBulk({ ids: ["task-1"], patch: {} })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
  })
})

describe("updateTasksBulk — scoping", () => {
  it("filters by delivery_id + status_in when provided", async () => {
    const { updateTasksBulk } = await import("@/lib/operations/task")
    const result = await updateTasksBulk({
      delivery_id: "sd-1",
      status_in: ["To Do", "In Progress"],
      patch: { status: "Done" },
      actor: "system:sd-complete",
      summary: "Auto-close 3 tasks for SD completion",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("updated")
    expect(result.count).toBe(3)
    expect(updateCalls[0].filters.delivery_id).toBe("sd-1")
    expect(updateCalls[0].filters.status).toEqual(["To Do", "In Progress"])
    const patch = updateCalls[0].patch as Record<string, unknown>
    expect(patch.status).toBe("Done")
    expect(patch.completed_date).toBeTruthy()
  })

  it("filters by account_id + title_ilike when provided", async () => {
    const { updateTasksBulk } = await import("@/lib/operations/task")
    await updateTasksBulk({
      account_id: "acct-1",
      title_ilike: "%Fax%SS-4%",
      status_in: ["To Do", "In Progress", "Waiting"],
      patch: { status: "Done" },
    })
    expect(updateCalls[0].filters.account_id).toBe("acct-1")
    expect(updateCalls[0].ilike).toBe("%Fax%SS-4%")
  })

  it("returns empty outcome when 0 rows matched", async () => {
    bulkUpdateReturnsRows = []
    const { updateTasksBulk } = await import("@/lib/operations/task")
    const result = await updateTasksBulk({
      delivery_id: "sd-missing",
      patch: { status: "Done" },
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("empty")
    expect(result.count).toBe(0)
    expect(actionLogCalls.length).toBe(0)
  })

  it("writes ONE aggregate action_log entry for the bulk call", async () => {
    const { updateTasksBulk } = await import("@/lib/operations/task")
    await updateTasksBulk({
      ids: ["task-1", "task-2", "task-3"],
      patch: { status: "Done" },
      actor: "claude.ai",
      summary: "Auto-closed 3 related tasks",
      account_id: "acct-1",
    })
    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].summary).toBe("Auto-closed 3 related tasks")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
  })
})
