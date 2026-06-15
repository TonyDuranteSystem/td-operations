/**
 * Tests for updateContactField email handling.
 *
 * The contact-email change now updates contacts FIRST, then delegates the
 * portal-login-email sync to the shared `syncPortalLoginEmail` helper
 * (lib/operations/portal-login-email.ts — unit-tested separately). A
 * conflict/failure in the helper does NOT roll back the contact email (it's
 * best-effort + flagged), and cross-account cache revalidation still runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockMaybeSingle,
  mockAcctContactsEq,
  mockUpdateWithLock,
  mockRevalidatePath,
  mockSyncPortalLoginEmail,
} = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockAcctContactsEq: vi.fn(),
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSyncPortalLoginEmail: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === "contacts") {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle }) }) }
      }
      if (table === "account_contacts") {
        return { select: vi.fn().mockReturnValue({ eq: mockAcctContactsEq }) }
      }
      return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn() }) }) }
    }),
  },
}))

vi.mock("@/lib/operations/portal-login-email", () => ({
  syncPortalLoginEmail: (...args: unknown[]) => mockSyncPortalLoginEmail(...args),
}))

vi.mock("@/lib/server-action", () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }),
  updateWithLock: (...args: unknown[]) => mockUpdateWithLock(...args),
}))

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }))

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { email: "admin@test.com" } } }) },
    from: vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({}) }),
  })),
}))

import { updateContactField } from "@/app/(dashboard)/accounts/actions"

const CONTACT_ID = "contact-123"
const NEW_EMAIL = "new@example.com"
const UPDATED_AT = "2026-01-01T00:00:00Z"

beforeEach(() => {
  vi.clearAllMocks()
  mockMaybeSingle.mockResolvedValue({ data: { full_name: "Mario Rossi", language: "Italian" } })
  mockAcctContactsEq.mockResolvedValue({ data: [{ account_id: "acc-1" }, { account_id: "acc-2" }] })
  mockSyncPortalLoginEmail.mockResolvedValue({ status: "synced", oldEmail: "old@example.com", newEmail: NEW_EMAIL })
  mockUpdateWithLock.mockResolvedValue({ success: true })
})

describe("updateContactField email handling", () => {
  it("updates contacts then syncs the portal login on email change", async () => {
    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith("contacts", CONTACT_ID, { email: NEW_EMAIL }, UPDATED_AT)
    expect(mockSyncPortalLoginEmail).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: CONTACT_ID, newEmail: NEW_EMAIL, language: "Italian", fullName: "Mario Rossi" }),
    )
  })

  it("does NOT block the contact email change when the login sync hits a conflict", async () => {
    mockSyncPortalLoginEmail.mockResolvedValue({ status: "conflict", newEmail: NEW_EMAIL })
    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalled()
  })

  it("succeeds when the contact has no portal login (helper returns no_login)", async () => {
    mockSyncPortalLoginEmail.mockResolvedValue({ status: "no_login" })
    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalled()
  })

  it("does not call the login sync when the contacts update fails", async () => {
    mockUpdateWithLock.mockResolvedValue({ success: false, error: "Lock conflict" })
    const result = await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT)
    expect(result.success).toBe(false)
    expect(mockSyncPortalLoginEmail).not.toHaveBeenCalled()
  })

  it("non-email field does not trigger the login sync", async () => {
    const result = await updateContactField(CONTACT_ID, "phone", "+1234567890", UPDATED_AT, "acc-1")
    expect(result.success).toBe(true)
    expect(mockSyncPortalLoginEmail).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).toHaveBeenCalledWith("contacts", CONTACT_ID, { phone: "+1234567890" }, UPDATED_AT)
  })

  it("cross-account revalidation for email changes", async () => {
    await updateContactField(CONTACT_ID, "email", NEW_EMAIL, UPDATED_AT, "acc-1")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-1")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-2")
  })

  it("single-account revalidation for non-email changes", async () => {
    await updateContactField(CONTACT_ID, "phone", "+1234567890", UPDATED_AT, "acc-1")
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1)
    expect(mockRevalidatePath).toHaveBeenCalledWith("/accounts/acc-1")
  })
})
