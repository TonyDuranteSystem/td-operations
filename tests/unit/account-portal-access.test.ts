/**
 * lib/members/account-portal-access.ts unit tests.
 *
 * Pins the fix for dev job bb48eba1 (child 4e0a74af): THW Global LLC's
 * "Portal auth user" check said the client had no portal login, when in
 * fact two of its three members had active logins — the check only tested
 * the one flagged Primary contact. resolveAccountPortalAccess must find a
 * login belonging to ANYONE tied to the account.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

let membersRows: Array<{ contact_id: string | null }> = []
let accountContactsRows: Array<{ contact_id: string | null }> = []
let contactsById: Record<string, { full_name: string | null; email: string | null }> = {}
let loginEmails: Set<string> = new Set()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      let inIds: string[] = []

      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn((_col: string, ids: string[]) => {
          inIds = ids
          return chain
        }),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (table === "members") return { data: membersRows, error: null }
        if (table === "account_contacts") return { data: accountContactsRows, error: null }
        if (table === "contacts") {
          const rows = inIds.map((id) => (contactsById[id] ? { id, ...contactsById[id] } : null)).filter(Boolean)
          return { data: rows, error: null }
        }
        return { data: null, error: null }
      }

      return chain
    },
  },
}))

vi.mock("@/lib/auth-admin-helpers", () => ({
  findAuthUsersByEmails: vi.fn(async (emails: string[]) => {
    const map = new Map<string, { id: string; email: string }>()
    for (const e of emails) {
      const norm = e.toLowerCase().trim()
      if (loginEmails.has(norm)) map.set(norm, { id: `auth-${norm}`, email: norm })
    }
    return map
  }),
}))

beforeEach(() => {
  membersRows = []
  accountContactsRows = []
  contactsById = {}
  loginEmails = new Set()
})

describe("resolveAccountPortalAccess — THW Global LLC (the reported incident)", () => {
  it("finds a co-member's login when the flagged-primary member has none", async () => {
    membersRows = [{ contact_id: "gergo-id" }, { contact_id: "adam-id" }, { contact_id: "peter-id" }]
    accountContactsRows = [{ contact_id: "gergo-id" }, { contact_id: "adam-id" }, { contact_id: "peter-id" }]
    contactsById = {
      "gergo-id": { full_name: "Gergo Kecskemeti Zsombor", email: "kecskemetizsombor1@gmail.com" },
      "adam-id": { full_name: "Adam Mihaly", email: "mihalo@tuta.com" },
      "peter-id": { full_name: "Peter Zelenyanszki", email: "info.thehealthyway@gmail.com" },
    }
    loginEmails = new Set(["mihalo@tuta.com", "info.thehealthyway@gmail.com"])

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-thw")
    expect(result.loginContact).not.toBeNull()
    expect(["Adam Mihaly", "Peter Zelenyanszki"]).toContain(result.loginContact!.name)
  })
})

describe("resolveAccountPortalAccess — merges members and account_contacts, neither alone is enough", () => {
  it("finds a login on a contact that is in members but NOT in account_contacts", async () => {
    membersRows = [{ contact_id: "members-only-id" }]
    accountContactsRows = [] // not linked here at all
    contactsById = { "members-only-id": { full_name: "Members Only", email: "membersonly@example.com" } }
    loginEmails = new Set(["membersonly@example.com"])

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-a")
    expect(result.loginContact?.email).toBe("membersonly@example.com")
  })

  it("finds a login on a DUPLICATE contact that is in account_contacts but NOT in members (Oh My Creatives / Conversion Monsters shape)", async () => {
    // The Members-panel contact has no login; a separate, duplicate contact
    // record for the same real person — never added to members — does.
    membersRows = [{ contact_id: "flagged-no-login-id" }]
    accountContactsRows = [{ contact_id: "flagged-no-login-id" }, { contact_id: "duplicate-with-login-id" }]
    contactsById = {
      "flagged-no-login-id": { full_name: "Damiano Mocellin", email: "hello@ohmycreatives.com" },
      "duplicate-with-login-id": { full_name: "Damiano Mocellin", email: "info@orizzonti.us" },
    }
    loginEmails = new Set(["info@orizzonti.us"])

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-duplicate")
    expect(result.loginContact?.email).toBe("info@orizzonti.us")
  })
})

describe("resolveAccountPortalAccess — genuine true negative", () => {
  it("returns null when nobody linked to the account has a login", async () => {
    membersRows = [{ contact_id: "solo-id" }]
    accountContactsRows = [{ contact_id: "solo-id" }]
    contactsById = { "solo-id": { full_name: "Andrea Santellocco", email: "andrea@example.com" } }
    loginEmails = new Set() // nobody has a login anywhere

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-none")
    expect(result.loginContact).toBeNull()
  })

  it("returns null when the account has no members and no account_contacts at all", async () => {
    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-empty")
    expect(result.loginContact).toBeNull()
  })

  it("returns null when candidates exist but none have an email on file", async () => {
    membersRows = [{ contact_id: "no-email-id" }]
    contactsById = { "no-email-id": { full_name: "No Email", email: null } }

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-no-email")
    expect(result.loginContact).toBeNull()
  })
})

describe("resolveAccountPortalAccess — dedupes a contact present in both tables", () => {
  it("does not fail or double-count when the same contact_id is in both members and account_contacts", async () => {
    membersRows = [{ contact_id: "shared-id" }]
    accountContactsRows = [{ contact_id: "shared-id" }]
    contactsById = { "shared-id": { full_name: "Shared Contact", email: "shared@example.com" } }
    loginEmails = new Set(["shared@example.com"])

    const { resolveAccountPortalAccess } = await import("@/lib/members/account-portal-access")
    const result = await resolveAccountPortalAccess("acct-shared")
    expect(result.loginContact?.email).toBe("shared@example.com")
  })
})
