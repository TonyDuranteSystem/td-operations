/**
 * Tests for syncLeadEmailToOfferArtifacts — propagating a corrected lead
 * email to the offer, contact, and portal-login records created from the old
 * address. Verifies the offer retarget, the no-clobber rules, and that
 * final-state offers are never touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────

const { state, mockUpdateUserById, mockFindAuthUserByEmail } = vi.hoisted(() => ({
  state: {
    offers: [] as Array<{ token: string; status: string }>,
    contactsByEmail: {} as Record<string, { id: string } | undefined>,
    offerUpdateError: null as string | null,
    contactUpdateError: null as string | null,
    authUpdateError: null as string | null,
    offerUpdates: [] as Array<{ token: string; email: string }>,
    contactUpdates: [] as Array<{ id: string; email: string }>,
  },
  mockUpdateUserById: vi.fn(),
  mockFindAuthUserByEmail: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "offers") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: state.offers, error: null }),
          }),
          update: (patch: { client_email: string }) => ({
            eq: (_col: string, token: string) => {
              state.offerUpdates.push({ token, email: patch.client_email })
              return Promise.resolve({
                error: state.offerUpdateError ? { message: state.offerUpdateError } : null,
              })
            },
          }),
        }
      }
      if (table === "contacts") {
        return {
          select: () => ({
            eq: (_col: string, email: string) => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: state.contactsByEmail[email] ?? null, error: null }),
              }),
            }),
          }),
          update: (patch: { email: string }) => ({
            eq: (_col: string, id: string) => {
              state.contactUpdates.push({ id, email: patch.email })
              return Promise.resolve({
                error: state.contactUpdateError ? { message: state.contactUpdateError } : null,
              })
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { admin: { updateUserById: mockUpdateUserById } },
  },
}))

vi.mock("@/lib/auth-admin-helpers", () => ({
  findAuthUserByEmail: (email: string) => mockFindAuthUserByEmail(email),
}))

import { syncLeadEmailToOfferArtifacts } from "@/lib/offers/sync-offer-email"

const LEAD_ID = "lead-1"
const OLD = "old@example.com"
const NEW = "new@example.com"

beforeEach(() => {
  state.offers = []
  state.contactsByEmail = {}
  state.offerUpdateError = null
  state.contactUpdateError = null
  state.authUpdateError = null
  state.offerUpdates = []
  state.contactUpdates = []
  mockUpdateUserById.mockReset()
  mockUpdateUserById.mockResolvedValue({ error: null })
  mockFindAuthUserByEmail.mockReset()
  mockFindAuthUserByEmail.mockResolvedValue(null)
})

describe("syncLeadEmailToOfferArtifacts", () => {
  it("propagates to offer, contact and portal login on the happy path", async () => {
    state.offers = [{ token: "off-1", status: "sent" }]
    state.contactsByEmail = { [OLD]: { id: "contact-1" } }
    mockFindAuthUserByEmail.mockImplementation((email: string) =>
      Promise.resolve(email === OLD ? { id: "auth-1", email: OLD } : null),
    )

    const r = await syncLeadEmailToOfferArtifacts({ leadId: LEAD_ID, oldEmail: OLD, newEmail: NEW })

    expect(r.offersUpdated).toBe(1)
    expect(r.contactUpdated).toBe(true)
    expect(r.authUserUpdated).toBe(true)
    expect(state.offerUpdates).toEqual([{ token: "off-1", email: NEW }])
    expect(state.contactUpdates).toEqual([{ id: "contact-1", email: NEW }])
    expect(mockUpdateUserById).toHaveBeenCalledWith("auth-1", { email: NEW })
  })

  it("does nothing when the email is unchanged", async () => {
    state.offers = [{ token: "off-1", status: "draft" }]
    const r = await syncLeadEmailToOfferArtifacts({ leadId: LEAD_ID, oldEmail: OLD, newEmail: OLD })
    expect(r.offersUpdated).toBe(0)
    expect(r.skipped).toContain("email unchanged")
    expect(state.offerUpdates).toHaveLength(0)
  })

  it("only retargets offers when there is no prior email", async () => {
    state.offers = [{ token: "off-1", status: "draft" }]
    const r = await syncLeadEmailToOfferArtifacts({ leadId: LEAD_ID, oldEmail: null, newEmail: NEW })
    expect(r.offersUpdated).toBe(1)
    expect(r.contactUpdated).toBe(false)
    expect(r.authUserUpdated).toBe(false)
    expect(mockFindAuthUserByEmail).not.toHaveBeenCalled()
  })

  it("never retargets signed/completed/superseded offers", async () => {
    state.offers = [
      { token: "draft-1", status: "draft" },
      { token: "signed-1", status: "signed" },
      { token: "done-1", status: "completed" },
      { token: "old-v1", status: "superseded" },
    ]
    const r = await syncLeadEmailToOfferArtifacts({ leadId: LEAD_ID, oldEmail: OLD, newEmail: NEW })
    expect(r.offersUpdated).toBe(1)
    expect(state.offerUpdates).toEqual([{ token: "draft-1", email: NEW }])
  })

  it("refuses to clobber a different contact / login that already owns the new email", async () => {
    state.offers = [{ token: "off-1", status: "sent" }]
    state.contactsByEmail = { [OLD]: { id: "contact-1" }, [NEW]: { id: "contact-other" } }
    mockFindAuthUserByEmail.mockImplementation((email: string) =>
      Promise.resolve(
        email === OLD ? { id: "auth-old", email: OLD } : { id: "auth-other", email: NEW },
      ),
    )

    const r = await syncLeadEmailToOfferArtifacts({ leadId: LEAD_ID, oldEmail: OLD, newEmail: NEW })

    expect(r.offersUpdated).toBe(1) // offer still retargeted
    expect(r.contactUpdated).toBe(false)
    expect(r.authUserUpdated).toBe(false)
    expect(mockUpdateUserById).not.toHaveBeenCalled()
    expect(state.contactUpdates).toHaveLength(0)
    expect(r.skipped.some((s) => s.startsWith("portal:"))).toBe(true)
    expect(r.skipped.some((s) => s.startsWith("contact:"))).toBe(true)
  })
})
