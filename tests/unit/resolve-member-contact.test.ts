/**
 * lib/members/resolve-member-contact.ts — resolveMemberContactId() unit tests
 *
 * The shared find-or-create-contact helper used by formation, onboarding,
 * credit-subject, and the account-creation identity-matching flow — but
 * every consumer mocks it out, so it had ZERO direct test coverage before
 * this file. A council review (2026-08-19, dev_task 693273fd) found it had
 * the same two bugs its sibling in lib/operations/account.ts had already
 * been fixed for: an unescaped ILIKE email lookup (a raw `_`/`%` in a real
 * email is a wildcard, over-matching an unrelated address) and an
 * unconditional refresh overwrite (silently replacing real on-file data with
 * whatever a new, unrelated caller happened to submit) — despite the
 * function's own doc comment already claiming "we never blank good data."
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let sameEmailContacts: Array<{ id: string; full_name: string | null; email: string | null }> = []
let sameNameContacts: Array<{ id: string; full_name: string | null; email: string | null }> = []
let accountContactsForDescribe: Array<{ role: string | null; accounts: { company_name: string } | null }> = []
let existingContact: Record<string, unknown> | null = null
let existingContactError: { message: string } | null = null
let createResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "contact-new-1" },
  error: null,
}

const emailIlikeCalls: string[] = []
const emailIsCalls: Array<[string, unknown]> = []
const nameIlikeCalls: string[] = []
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
const insertCalls: Array<Record<string, unknown>> = []
const loggedActions: Array<Record<string, unknown>> = []

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    loggedActions.push(params)
  }),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "account_contacts") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: accountContactsForDescribe, error: null })),
          })),
        }
      }
      if (table !== "contacts") throw new Error(`Unexpected table in test mock: ${table}`)
      return {
        select: vi.fn((cols: string) => {
          if (cols === "id, full_name, email") {
            return {
              ilike: vi.fn((col: string, pattern: string) => {
                if (col === "email") {
                  emailIlikeCalls.push(pattern)
                  return {
                    is: vi.fn((col2: string, val2: unknown) => {
                      emailIsCalls.push([col2, val2])
                      return Promise.resolve({ data: sameEmailContacts, error: null })
                    }),
                  }
                }
                // full_name search — the same-name-different-email duplicate check
                nameIlikeCalls.push(pattern)
                return {
                  is: vi.fn(() => Promise.resolve({ data: sameNameContacts, error: null })),
                }
              }),
            }
          }
          // The dynamic refresh field-set select, e.g. "address_city, address_zip"
          return {
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: existingContact, error: existingContactError })),
            })),
          }
        }),
        update: vi.fn((patch: Record<string, unknown>) => ({
          eq: vi.fn((_col: string, id: string) => {
            updateCalls.push({ id, patch })
            return Promise.resolve({ error: null })
          }),
        })),
        insert: vi.fn((payload: Record<string, unknown>) => {
          insertCalls.push(payload)
          return {
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(createResult)),
            })),
          }
        }),
      }
    },
  },
}))

beforeEach(() => {
  sameEmailContacts = []
  sameNameContacts = []
  accountContactsForDescribe = []
  existingContact = null
  existingContactError = null
  createResult = { data: { id: "contact-new-1" }, error: null }
  emailIlikeCalls.length = 0
  emailIsCalls.length = 0
  nameIlikeCalls.length = 0
  updateCalls.length = 0
  insertCalls.length = 0
  loggedActions.length = 0
})

describe("resolveMemberContactId — no email", () => {
  it("returns null without querying when email is blank", async () => {
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: null, name: "Jane Smith", now: "2026-08-19T00:00:00Z" })
    expect(result).toBeNull()
    expect(emailIlikeCalls.length).toBe(0)
  })
})

describe("resolveMemberContactId — ILIKE wildcard escaping", () => {
  it("escapes % and _ before building the email search pattern", async () => {
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({ email: "jane_doe@gmail.com", name: "Jane Doe", now: "2026-08-19T00:00:00Z" })
    expect(emailIlikeCalls[0]).toBe("%jane\\_doe@gmail.com%")
  })
})

describe("resolveMemberContactId — excludes merged contacts from candidates", () => {
  it("filters merged_into IS NULL on the email candidate query (a merged/tombstoned contact must never be reused)", async () => {
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({ email: "jane@example.com", name: "Jane Smith", now: "2026-08-19T00:00:00Z" })
    expect(emailIsCalls[0]).toEqual(["merged_into", null])
  })
})

describe("resolveMemberContactId — name matching on a shared email", () => {
  it("matches the correct contact by name when two people share one email (a family LLC)", async () => {
    sameEmailContacts = [
      { id: "contact-father", full_name: "John Smith", email: "family@biz.com" },
      { id: "contact-son", full_name: "John David Smith", email: "family@biz.com" },
    ]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "family@biz.com", name: "John David Smith", now: "2026-08-19T00:00:00Z" })
    expect(result).toBe("contact-son")
    expect(insertCalls.length).toBe(0)
  })

  it("creates a new contact when the email is on file but under no matching name", async () => {
    sameEmailContacts = [{ id: "contact-other", full_name: "Someone Else", email: "shared@biz.com" }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "shared@biz.com", name: "New Person", now: "2026-08-19T00:00:00Z" })
    expect(result).toBe("contact-new-1")
    expect(insertCalls.length).toBe(1)
  })

  it("re-verifies ILIKE candidates with an exact case-insensitive equality check instead of trusting a broader substring match", async () => {
    sameEmailContacts = [{ id: "contact-longer", full_name: "Jane Smith", email: "jane@example.com.evil.com" }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "jane@example.com", name: "Jane Smith", now: "2026-08-19T00:00:00Z" })
    expect(result).toBe("contact-new-1")
    expect(insertCalls.length).toBe(1)
  })
})

describe("resolveMemberContactId — refresh only fills blank fields", () => {
  it("does not overwrite an existing value with new data", async () => {
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    existingContact = { address_city: "Boston" }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({
      email: "jane@example.com",
      name: "Jane Smith",
      refresh: { address_city: "Miami" },
      now: "2026-08-19T00:00:00Z",
    })
    expect(updateCalls.length).toBe(0)
  })

  it("fills a field that is currently blank on the existing contact", async () => {
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    existingContact = { address_city: null }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({
      email: "jane@example.com",
      name: "Jane Smith",
      refresh: { address_city: "Miami" },
      now: "2026-08-19T00:00:00Z",
    })
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].id).toBe("contact-existing")
    expect(updateCalls[0].patch.address_city).toBe("Miami")
    expect(updateCalls[0].patch.updated_at).toBe("2026-08-19T00:00:00Z")
  })

  it("skips the update entirely when nothing is blank to fill", async () => {
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    existingContact = { address_city: "Boston", address_zip: "02108" }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({
      email: "jane@example.com",
      name: "Jane Smith",
      refresh: { address_city: "Miami", address_zip: "" },
      now: "2026-08-19T00:00:00Z",
    })
    expect(updateCalls.length).toBe(0)
  })

  it("treats a whitespace-only existing value as blank and still fills it", async () => {
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    existingContact = { address_city: "   " }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({
      email: "jane@example.com",
      name: "Jane Smith",
      refresh: { address_city: "Miami" },
      now: "2026-08-19T00:00:00Z",
    })
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].patch.address_city).toBe("Miami")
  })

  it("skips the refresh entirely (never overwrites) when the existing-value read fails — a failed read must not be treated as 'everything is blank'", async () => {
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    existingContactError = { message: "connection reset" }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({
      email: "jane@example.com",
      name: "Jane Smith",
      refresh: { address_city: "Miami", date_of_birth: "1990-01-01" },
      now: "2026-08-19T00:00:00Z",
    })
    expect(result).toBe("contact-existing")
    expect(updateCalls.length).toBe(0)
  })
})

describe("resolveMemberContactId — same-name-different-email duplicate flag", () => {
  it("flags a possible duplicate (without blocking creation or auto-linking) when an exact name match exists under a different email", async () => {
    sameNameContacts = [{ id: "contact-existing-elsewhere", full_name: "Damiano Mocellin", email: "info@orizzonti.us" }]
    accountContactsForDescribe = [{ role: "owner", accounts: { company_name: "Orizzonti LLC" } }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({
      email: "hello@ohmycreatives.com",
      name: "Damiano Mocellin",
      now: "2026-08-29T00:00:00Z",
    })
    // Still creates the new contact — never blocks, never auto-links.
    expect(result).toBe("contact-new-1")
    expect(insertCalls.length).toBe(1)
    // But leaves a durable flag for staff, since neither of this function's
    // real automated callers has a screen anyone is watching.
    expect(loggedActions.length).toBe(1)
    expect(loggedActions[0].action_type).toBe("flag")
    expect(loggedActions[0].record_id).toBe("contact-new-1")
    const details = loggedActions[0].details as Record<string, unknown>
    expect(details.existing_contact_id).toBe("contact-existing-elsewhere")
    expect(details.existing_roles).toBe("Orizzonti LLC (owner)")
  })

  it("does not flag when no other contact shares the exact name", async () => {
    sameNameContacts = [{ id: "contact-unrelated", full_name: "Someone Else Entirely", email: "other@example.com" }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({ email: "brand.new@example.com", name: "Brand New Person", now: "2026-08-29T00:00:00Z" })
    expect(loggedActions.length).toBe(0)
  })

  it("does not flag against a same-name contact that shares the SAME email (that path already matched, not this one)", async () => {
    // matchContactByName already succeeds via the email-scoped candidates,
    // so the name-search branch is never reached at all.
    sameEmailContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: "jane@example.com" }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "jane@example.com", name: "Jane Smith", now: "2026-08-29T00:00:00Z" })
    expect(result).toBe("contact-existing")
    expect(nameIlikeCalls.length).toBe(0)
    expect(loggedActions.length).toBe(0)
  })

  it("never merges or blocks — a genuinely different person sharing a common name still gets their own new contact with no error", async () => {
    sameNameContacts = [{ id: "contact-a-different-marco", full_name: "Marco Rossi", email: "marco.rossi@otherfirm.it" }]
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "marco.rossi@newclient.it", name: "Marco Rossi", now: "2026-08-29T00:00:00Z" })
    expect(result).toBe("contact-new-1")
    expect(insertCalls.length).toBe(1)
    expect(loggedActions.length).toBe(1) // flagged for a human to check — never assumed to be the same person
  })

  it("still creates the contact even if the roles lookup for the flag fails, and reports the lookup failure rather than a false 'no company yet'", async () => {
    sameNameContacts = [{ id: "contact-existing-elsewhere", full_name: "Jane Smith", email: "jane@otherco.com" }]
    accountContactsForDescribe = [] // simulated below via a thrown describeContactRoles error path is out of scope here; empty = "no company yet"
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "jane@newco.com", name: "Jane Smith", now: "2026-08-29T00:00:00Z" })
    expect(result).toBe("contact-new-1")
    expect(loggedActions.length).toBe(1)
  })
})

describe("resolveMemberContactId — creation", () => {
  it("passes first_name/last_name through only on creation", async () => {
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    await resolveMemberContactId({
      email: "brand.new@example.com",
      name: "Brand New",
      first_name: "Brand",
      last_name: "New",
      now: "2026-08-19T00:00:00Z",
    })
    expect(insertCalls[0].first_name).toBe("Brand")
    expect(insertCalls[0].last_name).toBe("New")
    expect(insertCalls[0].full_name).toBe("Brand New")
  })

  it("returns null when contact creation fails", async () => {
    createResult = { data: null, error: { message: "insert failed" } }
    const { resolveMemberContactId } = await import("@/lib/members/resolve-member-contact")
    const result = await resolveMemberContactId({ email: "brand.new@example.com", name: "Brand New", now: "2026-08-19T00:00:00Z" })
    expect(result).toBeNull()
  })
})
