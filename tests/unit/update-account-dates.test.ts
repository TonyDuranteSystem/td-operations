/**
 * Tests for updateAccountDates server action.
 *
 * Verifies the bulk-update helper for the lifecycle date pair
 * (client_since + ra_switch_date): patch shape, empty-string → null
 * coercion, partial updates, and the "no fields supplied" guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockUpdateWithLock, mockRevalidatePath } = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
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
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { email: "x@y.com" } } }) },
    from: vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({}) }),
  })),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { updateAccountDates } from "@/app/(dashboard)/accounts/actions"

const ACCOUNT_ID = "acc-1"
const UPDATED_AT = "2026-01-01T00:00:00Z"

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateWithLock.mockResolvedValue({ success: true })
})

describe("updateAccountDates", () => {
  it("writes both fields when both supplied", async () => {
    const result = await updateAccountDates(
      ACCOUNT_ID,
      { client_since: "2024-06-01", ra_switch_date: "2025-02-15" },
      UPDATED_AT,
    )
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "accounts",
      ACCOUNT_ID,
      { client_since: "2024-06-01", ra_switch_date: "2025-02-15" },
      UPDATED_AT,
    )
  })

  it("writes only the supplied field (partial update)", async () => {
    const result = await updateAccountDates(
      ACCOUNT_ID,
      { client_since: "2024-06-01" },
      UPDATED_AT,
    )
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "accounts",
      ACCOUNT_ID,
      { client_since: "2024-06-01" },
      UPDATED_AT,
    )
  })

  it("coerces empty string to null (clearing the date)", async () => {
    const result = await updateAccountDates(
      ACCOUNT_ID,
      { ra_switch_date: "" },
      UPDATED_AT,
    )
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "accounts",
      ACCOUNT_ID,
      { ra_switch_date: null },
      UPDATED_AT,
    )
  })

  it("preserves explicit null", async () => {
    const result = await updateAccountDates(
      ACCOUNT_ID,
      { client_since: null },
      UPDATED_AT,
    )
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      "accounts",
      ACCOUNT_ID,
      { client_since: null },
      UPDATED_AT,
    )
  })

  it("returns error when no fields supplied", async () => {
    const result = await updateAccountDates(ACCOUNT_ID, {}, UPDATED_AT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No date fields/i)
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })

  it("propagates updateWithLock error", async () => {
    mockUpdateWithLock.mockResolvedValue({ success: false, error: "version conflict" })
    const result = await updateAccountDates(
      ACCOUNT_ID,
      { client_since: "2024-06-01" },
      UPDATED_AT,
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/version conflict/)
  })
})
