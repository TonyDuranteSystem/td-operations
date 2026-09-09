/**
 * Tests for addContactNote — specifically the lock-timestamp fix from the
 * second bug-hunter pass (dev job e7352aa6, 2026-09-08). This function
 * already re-reads the contact's notes fresh before combining in the new
 * note, but used to lock updateWithLock against the STALE page-load
 * timestamp the caller passed in rather than this fresh read's own
 * updated_at. After updateWithLock was fixed to genuinely refuse on any
 * lock mismatch (closing a separate, more serious bug), that stale
 * timestamp started wrongly refusing a second note added immediately after
 * a first one, without a page reload — even though the second note's
 * `combined` value was already computed correctly from a fresh read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockUpdateWithLock, mockRevalidatePath, mockSingle } = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
}))

vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }),
  updateWithLock: (...args: unknown[]) => mockUpdateWithLock(...args),
}))

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mockSingle,
        })),
      })),
    })),
  })),
}))

import { addContactNote } from "@/app/(dashboard)/contacts/[id]/actions"

const CONTACT_ID = "contact-1"

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateWithLock.mockResolvedValue({ success: true })
})

describe("addContactNote — locks against the fresh read, not the stale page-load value", () => {
  it("uses the just-read updated_at for the lock, ignoring the caller's page-load timestamp", async () => {
    mockSingle.mockResolvedValue({ data: { notes: "old note", updated_at: "2026-01-01T00:05:00Z" } })
    const result = await addContactNote(CONTACT_ID, "new note", "2026-01-01T00:00:00Z" /* stale */)
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "contacts",
      CONTACT_ID,
      expect.objectContaining({ notes: expect.stringContaining("new note") }),
      "2026-01-01T00:05:00Z", // the FRESH read's updated_at, not the stale param
    )
  })

  it("still combines the new note with existing notes correctly", async () => {
    mockSingle.mockResolvedValue({ data: { notes: "existing note", updated_at: "T1" } })
    await addContactNote(CONTACT_ID, "second note", "T0")
    const [, , updates] = mockUpdateWithLock.mock.calls[0]
    expect((updates as { notes: string }).notes).toContain("second note")
    expect((updates as { notes: string }).notes).toContain("existing note")
  })

  it("propagates a genuine conflict from updateWithLock as a failure, never as a silent success (third bug-hunter pass, dev job e7352aa6)", async () => {
    mockSingle.mockResolvedValue({ data: { notes: "existing note", updated_at: "T1" } })
    mockUpdateWithLock.mockResolvedValue({
      success: false,
      error: "This record changed since it was loaded — reload and try again.",
    })
    const result = await addContactNote(CONTACT_ID, "a note", "T0")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
  })

  it("refuses an empty note without reading the contact or calling the lock at all", async () => {
    const result = await addContactNote(CONTACT_ID, "   ", "T0")
    expect(result.success).toBe(false)
    expect(mockSingle).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })

  it("refuses when the contact can't be found", async () => {
    mockSingle.mockResolvedValue({ data: null })
    const result = await addContactNote(CONTACT_ID, "a note", "T0")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })
})
