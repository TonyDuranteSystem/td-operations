/**
 * Tests for updateWithLock — the shared optimistic-concurrency write helper
 * used across pipeline, tax returns, contacts, accounts, and services.
 *
 * Rebuilt 2026-09-08 (dev job e7352aa6, bug-hunter pass off dev job
 * ef5da377). The original conflict path auto-retried via the admin client
 * with NO updated_at condition at all whenever the first, request-scoped
 * attempt matched zero rows — an unconditional overwrite that silently
 * discarded a genuine concurrent write, the opposite of what this function's
 * own doc comment promises ("If the row was modified since it was read,
 * count === 0 and we return an error"). The fix keeps the retry's real,
 * legitimate purpose (a stale Next.js RSC cache, or an RLS-scoped client
 * that can't see a row the admin client can, when the row's actual content
 * is otherwise unchanged) but re-verifies the row's real current updated_at
 * before ever writing over it — a genuine conflict now returns an error
 * instead of being silently clobbered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockUpdate,
  mockUpdateEq,
  mockUpdateEq2,
  mockUpdateSelect,
  mockAdminSelect,
  mockAdminSelectEq,
  mockAdminMaybeSingle,
  mockAdminUpdate,
  mockAdminUpdateEq,
  mockAdminUpdateEq2,
  mockAdminUpdateSelect,
} = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockUpdateEq2: vi.fn(),
  mockUpdateSelect: vi.fn(),
  mockAdminSelect: vi.fn(),
  mockAdminSelectEq: vi.fn(),
  mockAdminMaybeSingle: vi.fn(),
  mockAdminUpdate: vi.fn(),
  mockAdminUpdateEq: vi.fn(),
  mockAdminUpdateEq2: vi.fn(),
  mockAdminUpdateSelect: vi.fn(),
}))

// Request-scoped client — real chain:
// .update({...}).eq('id',...).eq('updated_at',...).select('id')
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      update: (updates: unknown) => {
        mockUpdate(updates)
        return {
          eq: (...args: unknown[]) => {
            mockUpdateEq(...args)
            return {
              eq: (...args2: unknown[]) => {
                mockUpdateEq2(...args2)
                return { select: (...args3: unknown[]) => mockUpdateSelect(...args3) }
              },
            }
          },
        }
      },
    })),
  })),
}))

// Admin client — two shapes: the re-check read
// (.select('updated_at').eq('id',...).maybeSingle()) and the retry write
// (.update({...}).eq('id',...).eq('updated_at',...)).
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: (...args: unknown[]) => {
        mockAdminSelect(...args)
        return {
          eq: (...args2: unknown[]) => {
            mockAdminSelectEq(...args2)
            return { maybeSingle: mockAdminMaybeSingle }
          },
        }
      },
      update: (updates: unknown) => {
        mockAdminUpdate(updates)
        return {
          eq: (...args: unknown[]) => {
            mockAdminUpdateEq(...args)
            return {
              eq: (...args2: unknown[]) => {
                mockAdminUpdateEq2(...args2)
                return { select: (...args3: unknown[]) => mockAdminUpdateSelect(...args3) }
              },
            }
          },
        }
      },
    })),
  },
}))

import { updateWithLock } from "@/lib/server-action"

const TABLE = "contacts"
const ID = "row-1"
const ORIGINAL_UPDATED_AT = "2026-01-01T00:00:00Z"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("updateWithLock — happy path (no conflict)", () => {
  it("succeeds without ever touching the admin client when the lock matches on the first try", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [{ id: ID }], error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(true)
    expect(mockUpdateEq2).toHaveBeenCalledWith("updated_at", ORIGINAL_UPDATED_AT)
    expect(mockAdminSelect).not.toHaveBeenCalled()
    expect(mockAdminUpdate).not.toHaveBeenCalled()
  })

  it("propagates a real database error from the first write instead of retrying", async () => {
    mockUpdateSelect.mockResolvedValue({ data: null, error: { message: "connection reset" } })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toBe("connection reset")
    expect(mockAdminSelect).not.toHaveBeenCalled()
  })
})

describe("updateWithLock — genuine conflict (bug-hunter pass, dev job e7352aa6)", () => {
  it("refuses instead of silently overwriting when the row's real updated_at has actually moved on", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: { updated_at: "2026-01-01T00:05:00Z" }, error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
    // The whole point: no write is ever attempted once a genuine conflict is confirmed.
    expect(mockAdminUpdate).not.toHaveBeenCalled()
  })

  it("refuses when the record no longer exists at all, instead of writing a ghost row back", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: null, error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(mockAdminUpdate).not.toHaveBeenCalled()
  })

  it("propagates an error from the re-check read instead of guessing either way", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toBe("timeout")
    expect(mockAdminUpdate).not.toHaveBeenCalled()
  })
})

describe("updateWithLock — stale read, not a real conflict (the retry's legitimate case)", () => {
  it("applies the write when the row's real updated_at still matches what the caller read", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: { updated_at: ORIGINAL_UPDATED_AT }, error: null })
    mockAdminUpdateSelect.mockResolvedValue({ data: [{ id: ID }], error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(true)
    expect(mockAdminUpdate).toHaveBeenCalledWith(expect.objectContaining({ full_name: "New Name" }))
    // Still guarded by the original timestamp, not an unconditional write —
    // closes the actual bug even on this legitimate path.
    expect(mockAdminUpdateEq).toHaveBeenCalledWith("id", ID)
    expect(mockAdminUpdateEq2).toHaveBeenCalledWith("updated_at", ORIGINAL_UPDATED_AT)
  })

  it("propagates an error from the retry write itself", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: { updated_at: ORIGINAL_UPDATED_AT }, error: null })
    mockAdminUpdateSelect.mockResolvedValue({ data: null, error: { message: "write failed" } })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toBe("write failed")
  })
})

describe("updateWithLock — retry write itself races (second bug-hunter pass, dev job e7352aa6)", () => {
  it("refuses instead of reporting success when the retry write matches zero rows", async () => {
    // The re-check confirms nothing had changed a moment ago, but something
    // else wrote to this exact row in the gap between that re-check and this
    // retry write — the retry's own WHERE clause then matches nothing.
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: { updated_at: ORIGINAL_UPDATED_AT }, error: null })
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
  })

  it("also refuses when the retry write's select comes back null rather than an empty array", async () => {
    mockUpdateSelect.mockResolvedValue({ data: [], error: null })
    mockAdminMaybeSingle.mockResolvedValue({ data: { updated_at: ORIGINAL_UPDATED_AT }, error: null })
    mockAdminUpdateSelect.mockResolvedValue({ data: null, error: null })
    const result = await updateWithLock(TABLE, ID, { full_name: "New Name" }, ORIGINAL_UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
  })
})
