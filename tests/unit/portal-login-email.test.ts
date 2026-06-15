import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth-admin-helpers", () => ({
  findAuthUsersByContactId: vi.fn(),
  findAuthUserByEmail: vi.fn(),
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { auth: { admin: { updateUserById: vi.fn() } } },
}))
vi.mock("@/lib/gmail", () => ({ gmailPost: vi.fn().mockResolvedValue({}) }))
vi.mock("@/lib/config", () => ({ PORTAL_BASE_URL: "https://portal.test" }))

import { syncPortalLoginEmail } from "@/lib/operations/portal-login-email"
import { findAuthUsersByContactId, findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"

const CONTACT = "11111111-1111-1111-1111-111111111111"
const clientUser = (email: string, id = "auth-1") => ({ id, email, app_metadata: { role: "client" } })

const updateUserById = supabaseAdmin.auth.admin.updateUserById as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  updateUserById.mockResolvedValue({ data: {}, error: null })
})

describe("syncPortalLoginEmail", () => {
  it("no_login when the contact has no client login", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "new@x.com" })
    expect(r.status).toBe("no_login")
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it("no_change when login already equals the new email (case-insensitive)", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("Same@X.com")])
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "same@x.com" })
    expect(r.status).toBe("no_change")
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it("conflict (skips) when the new email already belongs to a different user", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("old@x.com", "auth-1")])
    ;(findAuthUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "auth-OTHER", email: "taken@x.com" })
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "taken@x.com" })
    expect(r.status).toBe("conflict")
    expect(updateUserById).not.toHaveBeenCalled()
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it("synced + notifies on the happy path", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("old@x.com", "auth-1")])
    ;(findAuthUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "new@x.com", language: "it", fullName: "Mario" })
    expect(r.status).toBe("synced")
    expect(r.oldEmail).toBe("old@x.com")
    expect(updateUserById).toHaveBeenCalledWith("auth-1", { email: "new@x.com", email_confirm: true })
    expect(gmailPost).toHaveBeenCalledTimes(1)
  })

  it("does not notify when notify=false", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("old@x.com")])
    ;(findAuthUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "new@x.com", notify: false })
    expect(r.status).toBe("synced")
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it("error when the admin update fails, no throw", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("old@x.com")])
    ;(findAuthUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    updateUserById.mockResolvedValue({ data: null, error: { message: "boom" } })
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "new@x.com" })
    expect(r.status).toBe("error")
    expect(r.error).toBe("boom")
  })

  it("a notification failure does not fail the sync", async () => {
    ;(findAuthUsersByContactId as ReturnType<typeof vi.fn>).mockResolvedValue([clientUser("old@x.com")])
    ;(findAuthUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(gmailPost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("smtp down"))
    const r = await syncPortalLoginEmail({ contactId: CONTACT, newEmail: "new@x.com" })
    expect(r.status).toBe("synced")
  })
})
