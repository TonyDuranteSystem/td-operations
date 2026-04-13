/**
 * Tests for updateContactField email → auth.users sync (Phase 0.5)
 *
 * Verifies that changing contacts.email also syncs to auth.users.email,
 * with proper conflict handling, revert on failure, and cross-account
 * cache revalidation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Hoisted mocks (available inside vi.mock factories) ──────────

const {
  mockSingle,
  mockSelect,
  mockInsert,
  mockAuthListUsers,
  mockAuthUpdateUserById,
  mockUpdateWithLock,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockSingle: vi.fn(),
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockAuthListUsers: vi.fn(),
  mockAuthUpdateUserById: vi.fn(),
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
}))

// ─── Module mocks ────────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "contacts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: mockSingle,
            }),
          }),
        }
      }
      if (table === "account_contacts") {
        return {
          select: mockSelect.mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { account_id: "acc-1" },
                { account_id: "acc-2" },
              ],
            }),
          }),
        }
      }
      if (table === "action_log") {
        return {
          insert: mockInsert.mockReturnValue({
            catch: vi.fn(),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn(),
          }),
        }),
      }
    }),
    auth: {
      admin: {
        listUsers: mockAuthListUsers,
        updateUserById: mockAuthUpdateUserById,
      },
    },
  },
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
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { email: "admin@test.com" } },
      }),
    },
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({}),
    }),
  })),
}))

// Import after mocks
import { updateContactField } from "@/app/(dashboard)/accounts/actions"

// ─── Setup ───────────────────────────────────────────────────────

const CONTACT_ID = "contact-123"
const AUTH_USER_ID = "auth-456"
const OLD_EMAIL = "old@example.com"
const NEW_EMAIL = "new@example.com"
const UPDATED_AT = "2026-01-01T00:00:00Z"

function setupAuthUser(exists: boolean) {
  if (exists) {
    mockAuthListUsers.mockResolvedValue({
      data: {
        users: [
          { id: AUTH_USER_ID, app_metadata: { contact_id: CONTACT_ID } },
        ],
      },
    })
  } else {
    mockAuthListUsers.mockResolvedValue({
      data: { users: [] },
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSingle.mockResolvedValue({ data: { email: OLD_EMAIL } })
})

// ─── Tests ───────────────────────────────────────────────────────

describe("updateContactField email sync", () => {
  it("Test 1: syncs email to auth user on success", async () => {
    setupAuthUser(true)
    mockAuthUpdateUserById.mockResolvedValue({ error: null })
    mockUpdateWithLock.mockResolvedValue({ success: true })

    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)

    expect(result.success).toBe(true)
    expect(mockAuthUpdateUserById).toHaveBeenCalledWith(AUTH_USER_ID, { email: NEW_EMAIL })
    expect(mockUpdateWithLock).toHaveBeenCalledWith("contacts", CONTACT_ID, { email: NEW_EMAIL }, UPDATED_AT)
  })

  it("Test 2: blocks email change when new email taken in auth", async () => {
    setupAuthUser(true)
    mockAuthUpdateUserById.mockResolvedValue({
      error: { message: "A user with this email address has already been registered" },
    })

    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)

    expect(result.success).toBe(false)
    expect(result.error).toContain("already been registered")
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })

  it("Test 3: updates contacts only when no portal user exists", async () => {
    setupAuthUser(false)
    mockUpdateWithLock.mockResolvedValue({ success: true })

    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)

    expect(result.success).toBe(true)
    expect(mockAuthUpdateUserById).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).toHaveBeenCalledWith("contacts", CONTACT_ID, { email: NEW_EMAIL }, UPDATED_AT)
  })

  it("Test 4: non-email field does not trigger auth lookup", async () => {
    mockUpdateWithLock.mockResolvedValue({ success: true })

    const result = await updateContactField(CONTACT_ID, "phone", "+1234567890", UPDATED_AT, "acc-1")

    expect(result.success).toBe(true)
    expect(mockAuthListUsers).not.toHaveBeenCalled()
    expect(mockAuthUpdateUserById).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).toHaveBeenCalledWith("contacts", CONTACT_ID, { phone: "+1234567890" }, UPDATED_AT)
  })

  it("Test 5: reverts auth when contacts update fails", async () => {
    setupAuthUser(true)
    mockAuthUpdateUserById
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null })
    mockUpdateWithLock.mockResolvedValue({ success: false, error: "Lock conflict" })

    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)

    expect(result.success).toBe(false)
    expect(mockAuthUpdateUserById).toHaveBeenCalledTimes(2)
    expect(mockAuthUpdateUserById).toHaveBeenNthCalledWith(1, AUTH_USER_ID, { email: NEW_EMAIL })
    expect(mockAuthUpdateUserById).toHaveBeenNthCalledWith(2, AUTH_USER_ID, { email: OLD_EMAIL })
  })

  it("Test 6: logs desync when contacts fails AND auth revert fails", async () => {
    setupAuthUser(true)
    mockAuthUpdateUserById
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: "Revert failed" } })
    mockUpdateWithLock.mockResolvedValue({ success: false, error: "Lock conflict" })

    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)

    expect(result.success).toBe(false)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "system",
        action_type: "update",
        summary: expect.stringContaining("DESYNC"),
        details: expect.objectContaining({
          contact_id: CONTACT_ID,
          auth_user_id: AUTH_USER_ID,
          old_email: OLD_EMAIL,
          new_email: NEW_EMAIL,
        }),
      })
    )
  })

  it("Test 7: cross-account revalidation for email changes", async () => {
    setupAuthUser(true)
    mockAuthUpdateUserById.mockResolvedValue({ error: null })
    mockUpdateWithLock.mockResolvedValue({ success: true })

    await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT, "acc-1")

    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-1")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-2")
  })

  it("Test 8: single-account revalidation for non-email changes", async () => {
    mockUpdateWithLock.mockResolvedValue({ success: true })

    await updateContactField(CONTACT_ID, "phone", "+1234567890", UPDATED_AT, "acc-1")

    expect(mockRevalidatePath).toHaveBeenCalledTimes(1)
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-1")
  })
})
