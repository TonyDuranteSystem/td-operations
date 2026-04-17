/**
 * P3.4 #8 — lib/operations/document.ts unit tests
 *
 * Covers: updateDocument() single-row (by id and by drive_file_id), optimistic
 * lock + stale + not_found + validation + action_log; updateDocumentsBulk()
 * multi-row with aggregate logging + empty-ids tolerance + db errors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let existingRow: { id: string; account_id: string | null; updated_at: string | null } | null = null
let updateReturnsRows: Array<{ id: string; drive_file_id: string | null; account_id: string | null; updated_at: string | null }> = []
let bulkUpdateReturnsRows: Array<{ id: string }> = []
let updateError: { message: string } | null = null
let expectStaleLockFilter: string | null = null

const updateCalls: Array<{ patch: Record<string, unknown>; filters: Record<string, string | string[]> }> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "documents") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      }
      const chain: Record<string, unknown> = {}
      let pendingPatch: Record<string, unknown> | null = null
      const filters: Record<string, string | string[]> = {}
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
          return chain
        }),
        in: vi.fn((col: string, values: string[]) => {
          filters[col] = values
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
              updateCalls.push({ patch: pendingPatch, filters: { ...filters } })
              pendingPatch = null
              isBulk = false
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
    { id: "doc-1", drive_file_id: "drv-1", account_id: "acct-1", updated_at: "2026-04-17T22:00:00Z" },
  ]
  bulkUpdateReturnsRows = [{ id: "doc-1" }, { id: "doc-2" }, { id: "doc-3" }]
  updateError = null
  expectStaleLockFilter = null
  updateCalls.length = 0
  actionLogCalls.length = 0
})

// ─── updateDocument — validation ─────────────────────────

describe("updateDocument — validation", () => {
  it("returns error when neither id nor drive_file_id is provided", async () => {
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({ patch: { portal_visible: true } })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("id")
  })

  it("returns error when patch is empty", async () => {
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({ id: "doc-1", patch: {} })
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("patch")
  })
})

// ─── updateDocument — happy path (by id) ─────────────────

describe("updateDocument — by id", () => {
  it("writes the patch, stamps updated_at, and logs to action_log", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({
      id: "doc-1",
      patch: { portal_visible: true },
      actor: "dashboard:antonio",
      summary: "Portal visibility enabled",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("updated")
    expect(result.document_id).toBe("doc-1")

    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].patch).toMatchObject({ portal_visible: true })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()
    expect(updateCalls[0].filters.id).toBe("doc-1")

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("dashboard:antonio")
    expect(actionLogCalls[0].table_name).toBe("documents")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
    expect(actionLogCalls[0].summary).toBe("Portal visibility enabled")
  })

  it("applies optimistic-lock filter when expected_updated_at is provided", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    await updateDocument({
      id: "doc-1",
      patch: { category: 3, category_name: "Tax" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(updateCalls[0].filters.updated_at).toBe("2026-04-17T10:00:00Z")
  })

  it("defaults actor to 'system' and summary to fields list", async () => {
    existingRow = { id: "doc-1", account_id: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    await updateDocument({ id: "doc-1", patch: { portal_visible: false } })
    expect(actionLogCalls[0].actor).toBe("system")
    expect(actionLogCalls[0].summary).toContain("portal_visible")
  })
})

// ─── updateDocument — happy path (by drive_file_id) ──────

describe("updateDocument — by drive_file_id", () => {
  it("looks up by drive_file_id when id is absent", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({
      drive_file_id: "drv-1",
      patch: { file_name: "renamed.pdf" },
    })
    expect(result.success).toBe(true)
    expect(updateCalls[0].filters.drive_file_id).toBe("drv-1")
    expect(updateCalls[0].filters.id).toBeUndefined()
  })

  it("scopes by account_id when both drive_file_id and account_id are provided", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    await updateDocument({
      drive_file_id: "drv-1",
      account_id: "acct-1",
      patch: { category: 3, category_name: "Tax" },
    })
    expect(updateCalls[0].filters.drive_file_id).toBe("drv-1")
    expect(updateCalls[0].filters.account_id).toBe("acct-1")
  })

  it("prefers id when both id and drive_file_id are supplied", async () => {
    existingRow = { id: "doc-1", account_id: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateDocument } = await import("@/lib/operations/document")
    await updateDocument({
      id: "doc-1",
      drive_file_id: "drv-xx",
      patch: { portal_visible: true },
    })
    expect(updateCalls[0].filters.id).toBe("doc-1")
    expect(updateCalls[0].filters.drive_file_id).toBeUndefined()
  })
})

// ─── updateDocument — lock miss / not found ──────────────

describe("updateDocument — lock miss / not found", () => {
  it("returns stale when update returns 0 rows but the doc exists", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    updateReturnsRows = []
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({
      id: "doc-1",
      patch: { portal_visible: true },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("stale")
  })

  it("returns not_found when the doc row does not exist", async () => {
    existingRow = null
    updateReturnsRows = []
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({
      id: "missing-doc",
      patch: { portal_visible: true },
    })
    expect(result.outcome).toBe("not_found")
  })
})

// ─── updateDocument — db error ───────────────────────────

describe("updateDocument — db error", () => {
  it("surfaces the underlying error", async () => {
    existingRow = { id: "doc-1", account_id: "acct-1", updated_at: "2026-04-17T10:00:00Z" }
    updateError = { message: "violates check constraint" }
    const { updateDocument } = await import("@/lib/operations/document")
    const result = await updateDocument({
      id: "doc-1",
      patch: { status: "bad-value" },
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("check constraint")
  })
})

// ─── updateDocumentsBulk ─────────────────────────────────

describe("updateDocumentsBulk — validation", () => {
  it("returns empty outcome when ids array is empty (not an error)", async () => {
    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    const result = await updateDocumentsBulk({ ids: [], patch: { portal_visible: true } })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("empty")
    expect(result.count).toBe(0)
    expect(updateCalls.length).toBe(0)
    expect(actionLogCalls.length).toBe(0)
  })

  it("returns error when patch is empty", async () => {
    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    const result = await updateDocumentsBulk({ ids: ["doc-1"], patch: {} })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
  })
})

describe("updateDocumentsBulk — happy path", () => {
  it("applies the patch to every id and writes ONE aggregate action_log entry", async () => {
    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    const result = await updateDocumentsBulk({
      ids: ["doc-1", "doc-2", "doc-3"],
      patch: { portal_visible: true },
      actor: "claude.ai",
      summary: "Portal transition: enabled visibility",
      account_id: "acct-1",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("updated")
    expect(result.count).toBe(3)

    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].filters.id).toEqual(["doc-1", "doc-2", "doc-3"])
    expect(updateCalls[0].patch).toMatchObject({ portal_visible: true })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].summary).toBe("Portal transition: enabled visibility")
    expect(actionLogCalls[0].actor).toBe("claude.ai")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
  })

  it("stamps updated_at on the patch", async () => {
    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    await updateDocumentsBulk({
      ids: ["doc-1"],
      patch: { portal_visible: false },
    })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()
  })

  it("surfaces db errors", async () => {
    updateError = { message: "unique_violation" }
    const { updateDocumentsBulk } = await import("@/lib/operations/document")
    const result = await updateDocumentsBulk({
      ids: ["doc-1", "doc-2"],
      patch: { portal_visible: true },
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("unique_violation")
  })
})
