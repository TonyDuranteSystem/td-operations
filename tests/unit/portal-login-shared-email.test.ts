/**
 * Two people can share one email (a couple's company). A NEW portal login must belong to the person it is created FOR — not to
 * the oldest contact on that email, who may be the one with no portal access for this company (dev job beb43385).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  created: [] as Array<{ email: string; app_metadata: Record<string, unknown> }>,
  contact: { full_name: "Cee Cc", email: "cd@x.com", language: "English" } as Record<string, unknown>,
  findByEmail: vi.fn(async () => "oldest-contact-on-that-email" as string | null),
  existingUser: null as null | { id: string; app_metadata: Record<string, unknown> },
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  for (const m of ["select", "eq", "is", "limit", "update", "insert", "order"]) builder[m] = self
  builder.single = async () => ({ data: h.contact, error: null })
  builder.maybeSingle = async () => ({ data: h.contact, error: null })
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
  return {
    supabaseAdmin: {
      from: () => builder,
      auth: {
        admin: {
          createUser: async (a: { email: string; app_metadata: Record<string, unknown> }) => { h.created.push(a); return { data: { user: { id: "new-user" } }, error: null } },
          updateUserById: async () => ({}),
        },
      },
    },
  }
})
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUserByEmail: async () => h.existingUser }))
vi.mock("@/lib/operations/find-contact-by-email", () => ({ findContactIdByEmail: h.findByEmail }))
vi.mock("@/lib/operations/sync-tier", () => ({ syncTier: vi.fn(async () => ({})), computeContactTier: vi.fn(async () => null) }))
vi.mock("@/lib/team/reanchor-conversations", () => ({ reanchorLeadConversations: vi.fn(async () => ({})) }))

import { autoCreatePortalUser } from "@/lib/portal/auto-create"

beforeEach(() => {
  h.created.length = 0
  h.existingUser = null
  h.findByEmail.mockClear()
})

describe("a new login belongs to the person it is created for", () => {
  it("uses the contact the caller named, even when an older contact shares the email", async () => {
    const r = await autoCreatePortalUser({ accountId: "acc-1", contactId: "cee-open-contact", tier: "active" })
    expect(r.success).toBe(true)
    expect(h.created).toHaveLength(1)
    expect(h.created[0].app_metadata.contact_id).toBe("cee-open-contact")
    expect(h.created[0].app_metadata.contact_id).not.toBe("oldest-contact-on-that-email")
  })

  it("with no contact named (offer-publish email override) it still looks the contact up by email, as before", async () => {
    const r = await autoCreatePortalUser({ accountId: "acc-1", tier: "lead", emailOverride: "someone@x.com", nameOverride: "Some One" })
    expect(r.success).toBe(true)
    expect(h.findByEmail).toHaveBeenCalledWith("someone@x.com")
    expect(h.created[0].app_metadata.contact_id).toBe("oldest-contact-on-that-email")
  })

  it("an already-existing login keeps pointing where it pointed (nothing is moved)", async () => {
    h.existingUser = { id: "u-old", app_metadata: { contact_id: "existing-meta-contact" } }
    const r = await autoCreatePortalUser({ accountId: "acc-1", contactId: "cee-open-contact", tier: "active" })
    expect(r.success).toBe(true)
    expect(r.alreadyExists).toBe(true)
    expect(h.created).toHaveLength(0)
  })
})
