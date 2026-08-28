/**
 * lib/members/resolve-primary-contact.ts unit tests.
 *
 * Pins the fix for dev job bb48eba1: Digital Fastlane LLC's diagnostic panel
 * guessed Patrizia Capalbo (alphabetical tiebreak over account_contacts) as
 * the "primary contact" instead of Angelo Capalbo Ghelli, who is correctly
 * flagged members.is_primary=true — producing false "no portal access"
 * warnings for a client who has always had it. This resolver must check
 * members.is_primary FIRST and only fall back to the old account_contacts
 * guess when no members row is flagged primary.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

// ─── Mock state ──────────────────────────────────────────

let membersRows: Array<{
  contact_id: string | null
  full_name: string | null
  member_type: string
  representative_email: string | null
  email?: string | null
  is_primary: boolean | null
}> = []

interface AccountContactRow {
  contact_id: string
  role?: string | null
  is_primary?: boolean | null
  contacts: { id: string; full_name: string; email: string | null; portal_tier: string | null; portal_role: string | null }
}
let accountContactLinks: AccountContactRow[] = []
let contactsById: Record<string, { id: string; full_name: string; email: string | null; portal_tier: string | null; portal_role: string | null }> = {}
let ambiguousEmails: Set<string> = new Set()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const filters: Record<string, string | number> = {}
      let inCol: string | undefined
      let inVals: string[] = []
      let emailIlikeTarget: string | undefined

      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, value: string | number) => {
          filters[col] = value
          return chain
        }),
        ilike: vi.fn((col: string, pattern: string) => {
          if (col === "email") emailIlikeTarget = pattern.slice(1, -1).replace(/\\(.)/g, "$1")
          return chain
        }),
        in: vi.fn((col: string, vals: string[]) => {
          inCol = col
          inVals = vals
          return chain
        }),
        order: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (table === "members") {
          return { data: membersRows, error: null }
        }
        if (table === "account_contacts") {
          return { data: accountContactLinks, error: null }
        }
        if (table === "contacts") {
          if (emailIlikeTarget !== undefined) {
            if (ambiguousEmails.has(emailIlikeTarget)) {
              return { data: [{ id: "dup-1", email: emailIlikeTarget }, { id: "dup-2", email: emailIlikeTarget }], error: null }
            }
            const pool = inCol === "id"
              ? inVals.map((id) => contactsById[id]).filter(Boolean)
              : Object.values(contactsById)
            const matches = pool.filter((c) => (c.email ?? "").trim().toLowerCase().includes(emailIlikeTarget as string))
            return { data: matches, error: null }
          }
          if (filters.id) {
            return { data: contactsById[filters.id as string] ?? null, error: null }
          }
        }
        return { data: null, error: null }
      }

      return chain
    },
  },
}))

beforeEach(() => {
  membersRows = []
  accountContactLinks = []
  contactsById = {}
  ambiguousEmails = new Set()
})

// ─── THE DIGITAL FASTLANE CASE ───────────────────────────

describe("resolvePrimaryContact — Digital Fastlane LLC (the reported incident)", () => {
  it("resolves to the member flagged is_primary, not the account_contacts alphabetical pick", async () => {
    membersRows = [
      { contact_id: "angelo-id", full_name: "Angelo Capalbo Ghelli", member_type: "individual", representative_email: null, is_primary: true },
      { contact_id: "patrizia-id", full_name: "Patrizia Capalbo", member_type: "individual", representative_email: null, is_primary: false },
    ]
    // account_contacts would alphabetically favor Patrizia if it were consulted.
    accountContactLinks = [
      { contact_id: "patrizia-id", role: "Member", is_primary: false, contacts: { id: "patrizia-id", full_name: "Patrizia Capalbo", email: "patrizia@example.com", portal_tier: "active", portal_role: null } },
      { contact_id: "angelo-id", role: "Member", is_primary: false, contacts: { id: "angelo-id", full_name: "Angelo Capalbo Ghelli", email: "angelo@example.com", portal_tier: "active", portal_role: null } },
    ]
    contactsById = {
      "angelo-id": { id: "angelo-id", full_name: "Angelo Capalbo Ghelli", email: "angelo@example.com", portal_tier: "active", portal_role: null },
      "patrizia-id": { id: "patrizia-id", full_name: "Patrizia Capalbo", email: "patrizia@example.com", portal_tier: "active", portal_role: null },
    }
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-digital-fastlane")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("angelo-id")
      expect(result.source).toBe("members")
    }
  })
})

// ─── The gap this resolver exists to surface ─────────────

describe("resolvePrimaryContact — members rows exist but none flagged primary", () => {
  it("falls back to account_contacts and reports source 'account_contacts' (the MMLLC gap signal)", async () => {
    membersRows = [
      { contact_id: "a-id", full_name: "A", member_type: "individual", representative_email: null, is_primary: false },
      { contact_id: "b-id", full_name: "B", member_type: "individual", representative_email: null, is_primary: false },
    ]
    accountContactLinks = [
      { contact_id: "a-id", role: "Member", is_primary: false, contacts: { id: "a-id", full_name: "A", email: "a@example.com", portal_tier: null, portal_role: null } },
    ]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-gap")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.source).toBe("account_contacts")
  })
})

describe("resolvePrimaryContact — no members rows at all (SMLLC / legacy)", () => {
  it("falls back to account_contacts, source 'account_contacts'", async () => {
    accountContactLinks = [
      { contact_id: "owner-id", role: "owner", is_primary: true, contacts: { id: "owner-id", full_name: "Owner", email: "owner@example.com", portal_tier: "active", portal_role: null } },
    ]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-smllc")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("owner-id")
      expect(result.source).toBe("account_contacts")
    }
  })

  it("no account_contacts either → not_found", async () => {
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-empty")
    expect(result.outcome).toBe("not_found")
  })
})

// ─── Flagged primary member with no direct contact_id ────

describe("resolvePrimaryContact — flagged primary member resolves via email fallback", () => {
  it("individual member: no contact_id, resolves via its own email field", async () => {
    membersRows = [
      { contact_id: null, full_name: "No-Contact Primary", member_type: "individual", representative_email: null, email: "primary@example.com", is_primary: true },
    ]
    accountContactLinks = [{ contact_id: "linked-id", contacts: { id: "linked-id", full_name: "No-Contact Primary", email: "primary@example.com", portal_tier: null, portal_role: null } }]
    contactsById = { "linked-id": { id: "linked-id", full_name: "No-Contact Primary", email: "primary@example.com", portal_tier: null, portal_role: null } }
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-email-fallback")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("linked-id")
      expect(result.source).toBe("members")
    }
  })

  it("company member: no contact_id, resolves via representative_email", async () => {
    membersRows = [
      { contact_id: null, full_name: null, member_type: "company", representative_email: "rep@holdings.com", is_primary: true },
    ]
    accountContactLinks = [{ contact_id: "rep-id", contacts: { id: "rep-id", full_name: "Rep", email: "rep@holdings.com", portal_tier: null, portal_role: null } }]
    contactsById = { "rep-id": { id: "rep-id", full_name: "Rep", email: "rep@holdings.com", portal_tier: null, portal_role: null } }
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-company-fallback")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("rep-id")
      expect(result.source).toBe("members")
    }
  })

  it("flagged primary resolves to nobody real (no contact_id, no email) — falls through to account_contacts rather than not_found", async () => {
    membersRows = [
      { contact_id: null, full_name: "Ghost Primary", member_type: "individual", representative_email: null, email: null, is_primary: true },
    ]
    accountContactLinks = [{ contact_id: "fallback-id", contacts: { id: "fallback-id", full_name: "Fallback Contact", email: "fallback@example.com", portal_tier: null, portal_role: null } }]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-ghost-primary")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") {
      expect(result.contact.id).toBe("fallback-id")
      expect(result.source).toBe("account_contacts")
    }
  })

  it("flagged primary's email is ambiguous (shared by 2+ contacts) — falls through to account_contacts rather than guessing", async () => {
    membersRows = [
      { contact_id: null, full_name: "Ambiguous Primary", member_type: "individual", representative_email: null, email: "shared@example.com", is_primary: true },
    ]
    ambiguousEmails = new Set(["shared@example.com"])
    accountContactLinks = [{ contact_id: "fallback-id", contacts: { id: "fallback-id", full_name: "Fallback Contact", email: "fallback@example.com", portal_tier: null, portal_role: null } }]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-ambiguous-primary")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.source).toBe("account_contacts")
  })
})

// ─── account_contacts fallback tiebreak order ────────────

describe("resolvePrimaryContact — account_contacts fallback tiebreak", () => {
  it("prefers is_primary flag over alphabetical contact_id order", async () => {
    accountContactLinks = [
      { contact_id: "a-id", role: "Member", is_primary: false, contacts: { id: "a-id", full_name: "Aaron", email: "aaron@example.com", portal_tier: null, portal_role: null } },
      { contact_id: "z-id", role: "Member", is_primary: true, contacts: { id: "z-id", full_name: "Zara", email: "zara@example.com", portal_tier: null, portal_role: null } },
    ]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-tiebreak")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("z-id")
  })

  it("prefers an owner-ish role over a non-owner role when no is_primary flag is set", async () => {
    accountContactLinks = [
      { contact_id: "a-id", role: "Accountant", is_primary: false, contacts: { id: "a-id", full_name: "Aaron", email: "aaron@example.com", portal_tier: null, portal_role: null } },
      { contact_id: "b-id", role: "Sole Member", is_primary: false, contacts: { id: "b-id", full_name: "Bob", email: "bob@example.com", portal_tier: null, portal_role: null } },
    ]
    const { resolvePrimaryContact } = await import("@/lib/members/resolve-primary-contact")
    const result = await resolvePrimaryContact("acct-role-tiebreak")
    expect(result.outcome).toBe("resolved")
    if (result.outcome === "resolved") expect(result.contact.id).toBe("b-id")
  })
})
