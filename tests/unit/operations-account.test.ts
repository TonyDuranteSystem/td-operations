/**
 * P3.4 #7 — lib/operations/account.ts unit tests
 *
 * Covers: updateAccount() success + stale-lock + not_found + validation +
 * action_log writes; appendAccountNote() prepend behavior + empty note
 * rejection + not_found.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let existingRow: { id: string; notes: string | null; updated_at: string | null } | null = null
let updateReturnsRows: Array<{ id: string; updated_at: string | null }> = []
let updateError: { message: string } | null = null
let expectStaleLockFilter: string | null = null

const updateCalls: Array<{ patch: Record<string, unknown>; filters: Record<string, string> }> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "accounts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      }
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
        select: vi.fn((cols: string) => {
          // distinguish the standalone read (in appendAccountNote) from the
          // .update().select() return.
          if (cols.includes("notes")) readMode = "select"
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
          // update-flow mode: .maybeSingle() is only used to distinguish
          // stale-lock vs not_found when update returns 0 rows.
          return Promise.resolve({ data: existingRow ? { id: existingRow.id } : null, error: null })
        }),
        then: (resolve: (v: unknown) => void) => {
          if (pendingPatch) {
            // If a stale-lock filter was applied and test expects it to miss,
            // return empty rows.
            const stale = expectStaleLockFilter !== null
              && filters["updated_at"] === expectStaleLockFilter
            const rows = stale ? [] : updateReturnsRows
            updateCalls.push({ patch: pendingPatch, filters: { ...filters } })
            pendingPatch = null
            // Reset filters for the next operation
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
  updateReturnsRows = [{ id: "acct-1", updated_at: "2026-04-17T22:00:00Z" }]
  updateError = null
  expectStaleLockFilter = null
  updateCalls.length = 0
  actionLogCalls.length = 0
})

// ─── updateAccount ───────────────────────────────────────

describe("updateAccount — validation", () => {
  it("returns error when id is missing", async () => {
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "",
      patch: { status: "Active" },
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("id")
  })

  it("returns error when patch is empty", async () => {
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "acct-1",
      patch: {},
    })
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("patch")
  })
})

describe("updateAccount — happy path", () => {
  it("writes the patch, stamps updated_at, and logs to action_log", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "acct-1",
      patch: { status: "Active", portal_tier: "active" },
      actor: "claude.ai",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("updated")
    expect(result.account_id).toBe("acct-1")

    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].patch).toMatchObject({ status: "Active", portal_tier: "active" })
    expect(updateCalls[0].patch.updated_at).toBeTruthy()
    expect(updateCalls[0].filters.id).toBe("acct-1")

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("claude.ai")
    expect(actionLogCalls[0].action_type).toBe("update")
    expect(actionLogCalls[0].table_name).toBe("accounts")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
  })

  it("applies optimistic-lock filter when expected_updated_at is provided", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { updateAccount } = await import("@/lib/operations/account")
    await updateAccount({
      id: "acct-1",
      patch: { status: "Suspended" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(updateCalls[0].filters.updated_at).toBe("2026-04-17T10:00:00Z")
  })

  it("passes actor + summary to action_log when supplied", async () => {
    const { updateAccount } = await import("@/lib/operations/account")
    await updateAccount({
      id: "acct-1",
      patch: { status: "Active" },
      actor: "dashboard:antonio",
      summary: "Reactivating account",
    })
    expect(actionLogCalls[0].actor).toBe("dashboard:antonio")
    expect(actionLogCalls[0].summary).toBe("Reactivating account")
  })

  it("defaults actor to 'system' and summary to fields list", async () => {
    const { updateAccount } = await import("@/lib/operations/account")
    await updateAccount({
      id: "acct-1",
      patch: { status: "Active", portal_tier: "active" },
    })
    expect(actionLogCalls[0].actor).toBe("system")
    expect(actionLogCalls[0].summary).toContain("status")
    expect(actionLogCalls[0].summary).toContain("portal_tier")
  })
})

describe("updateAccount — lock miss / not found", () => {
  it("returns stale when update returns 0 rows but the account exists", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    updateReturnsRows = []
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "acct-1",
      patch: { status: "Active" },
      expected_updated_at: "2026-04-17T10:00:00Z",
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("stale")
  })

  it("returns not_found when the account row does not exist", async () => {
    existingRow = null
    updateReturnsRows = []
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "missing-acct",
      patch: { status: "Active" },
    })
    expect(result.outcome).toBe("not_found")
  })
})

describe("updateAccount — db error", () => {
  it("surfaces the underlying error", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    updateError = { message: "violates foreign key constraint" }
    const { updateAccount } = await import("@/lib/operations/account")
    const result = await updateAccount({
      id: "acct-1",
      patch: { status: "Active" },
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("foreign key")
  })
})

// ─── appendAccountNote ───────────────────────────────────

describe("appendAccountNote — validation", () => {
  it("rejects empty notes", async () => {
    const { appendAccountNote } = await import("@/lib/operations/account")
    const result = await appendAccountNote({ id: "acct-1", note: "   " })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("empty_note")
  })

  it("returns not_found when account missing", async () => {
    existingRow = null
    const { appendAccountNote } = await import("@/lib/operations/account")
    const result = await appendAccountNote({
      id: "missing-acct",
      note: "status updated",
    })
    expect(result.outcome).toBe("not_found")
  })
})

describe("appendAccountNote — prepend behavior", () => {
  it("prepends a dated entry to existing notes", async () => {
    existingRow = {
      id: "acct-1",
      notes: "2026-04-10: earlier note",
      updated_at: "2026-04-17T10:00:00Z",
    }
    const { appendAccountNote } = await import("@/lib/operations/account")
    const result = await appendAccountNote({
      id: "acct-1",
      note: "flipped to Suspended",
      date: "2026-04-17",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("appended")
    // The update call should have received the combined notes with new entry first
    const notes = updateCalls[0].patch.notes as string
    expect(notes.startsWith("2026-04-17: flipped to Suspended")).toBe(true)
    expect(notes).toContain("2026-04-10: earlier note")
  })

  it("uses today's date when no date supplied", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { appendAccountNote } = await import("@/lib/operations/account")
    await appendAccountNote({ id: "acct-1", note: "manual note" })
    const notes = updateCalls[0].patch.notes as string
    const today = new Date().toISOString().split("T")[0]
    expect(notes.startsWith(`${today}: manual note`)).toBe(true)
  })

  it("trims whitespace from the note text", async () => {
    existingRow = { id: "acct-1", notes: null, updated_at: "2026-04-17T10:00:00Z" }
    const { appendAccountNote } = await import("@/lib/operations/account")
    await appendAccountNote({ id: "acct-1", note: "   padded note   \n" })
    const notes = updateCalls[0].patch.notes as string
    expect(notes).toContain(": padded note")
    expect(notes).not.toContain(":    padded")
  })
})
