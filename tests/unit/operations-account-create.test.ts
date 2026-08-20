/**
 * lib/operations/account.ts — createAccount() + createAndLinkContact() unit tests
 *
 * These are the operations-layer replacements for the raw RLS-scoped inserts
 * that never succeeded in production (accounts/contacts had no staff INSERT
 * policy — see dev_task 7ebb1e0c). Covers: near-duplicate-name guard (not
 * just exact matches), the portal_tier/account_type defaults, EIN
 * normalization, and — rewritten 2026-08-19, dev_task 693273fd, second pass —
 * identity matching that never silently guesses: an exact email+name match
 * auto-links, anything less certain creates a new contact and surfaces a
 * non-blocking warning instead of merging or missing an existing person.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let allAccounts: Array<{ id: string; company_name: string }> = []
let accountInsertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "acct-new-1" },
  error: null,
}
let sameEmailContacts: Array<{
  id: string
  full_name: string | null
  email: string | null
  address_line1?: string | null
  address_city?: string | null
  address_state?: string | null
  address_zip?: string | null
  address_country?: string | null
}> = []
let sameNameContacts: Array<{ id: string; full_name: string | null; email: string | null }> = []
let contactRolesByContactId: Record<string, Array<{ role: string | null; accounts: { company_name: string } | null }>> = {}
let contactRolesError: { message: string } | null = null
let accountContactsExistingLink: { account_id: string } | null = null
let accountContactsInsertError: { message: string } | null = null
let contactsInsertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "contact-fallback-1" },
  error: null,
}

const accountInsertCalls: Array<Record<string, unknown>> = []
const contactsUpdateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
const accountContactsInsertCalls: Array<Record<string, unknown>> = []
const contactsInsertCalls: Array<Record<string, unknown>> = []
const actionLogCalls: Array<Record<string, unknown>> = []
// Spies proving escapeLikePattern's real effect + the merged_into filter are
// actually invoked, not silently made a no-op by a permissive mock (QA-Tester
// finding, council review 2026-08-19, dev_task 693273fd).
const emailIlikeCalls: string[] = []
const nameIlikeCalls: string[] = []
const emailIsCalls: Array<[string, unknown]> = []
const nameIsCalls: Array<[string, unknown]> = []

const resolveMemberContactIdMock = vi.fn<[Record<string, unknown>], Promise<string | null>>()

vi.mock("@/lib/members/resolve-member-contact", () => ({
  resolveMemberContactId: (input: Record<string, unknown>) => resolveMemberContactIdMock(input),
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: vi.fn(() => Promise.resolve({ data: allAccounts, error: null })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            accountInsertCalls.push(payload)
            return {
              select: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve(accountInsertResult)),
              })),
            }
          }),
        }
      }
      if (table === "account_contacts") {
        return {
          select: vi.fn((cols: string) => {
            if (cols.includes("accounts(company_name)")) {
              return {
                eq: vi.fn((_col: string, contactId: string) =>
                  Promise.resolve(
                    contactRolesError
                      ? { data: null, error: contactRolesError }
                      : { data: contactRolesByContactId[contactId] || [], error: null }
                  )
                ),
              }
            }
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  maybeSingle: vi.fn(() => Promise.resolve({ data: accountContactsExistingLink, error: null })),
                })),
              })),
            }
          }),
          insert: vi.fn((payload: Record<string, unknown>) => {
            accountContactsInsertCalls.push(payload)
            return Promise.resolve({ error: accountContactsInsertError })
          }),
        }
      }
      if (table === "contacts") {
        return {
          select: vi.fn(() => ({
            ilike: vi.fn((col: string, pattern: string) => {
              if (col === "email") emailIlikeCalls.push(pattern)
              if (col === "full_name") nameIlikeCalls.push(pattern)
              return {
                is: vi.fn((col2: string, val2: unknown) => {
                  if (col === "email") {
                    emailIsCalls.push([col2, val2])
                    return Promise.resolve({ data: sameEmailContacts, error: null })
                  }
                  if (col === "full_name") {
                    nameIsCalls.push([col2, val2])
                    return Promise.resolve({ data: sameNameContacts, error: null })
                  }
                  return Promise.resolve({ data: [], error: null })
                }),
              }
            }),
          })),
          update: vi.fn((patch: Record<string, unknown>) => ({
            eq: vi.fn((_col: string, id: string) => {
              contactsUpdateCalls.push({ id, patch })
              return Promise.resolve({ error: null })
            }),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            contactsInsertCalls.push(payload)
            return {
              select: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve(contactsInsertResult)),
              })),
            }
          }),
        }
      }
      throw new Error(`Unexpected table in test mock: ${table}`)
    },
  },
}))

beforeEach(() => {
  allAccounts = []
  accountInsertResult = { data: { id: "acct-new-1" }, error: null }
  sameEmailContacts = []
  sameNameContacts = []
  contactRolesByContactId = {}
  contactRolesError = null
  accountContactsExistingLink = null
  accountContactsInsertError = null
  contactsInsertResult = { data: { id: "contact-fallback-1" }, error: null }
  accountInsertCalls.length = 0
  contactsUpdateCalls.length = 0
  accountContactsInsertCalls.length = 0
  contactsInsertCalls.length = 0
  actionLogCalls.length = 0
  emailIlikeCalls.length = 0
  nameIlikeCalls.length = 0
  emailIsCalls.length = 0
  nameIsCalls.length = 0
  resolveMemberContactIdMock.mockReset()
  resolveMemberContactIdMock.mockResolvedValue("contact-resolved-1")
})

// ─── createAccount ───────────────────────────────────────

describe("createAccount — validation", () => {
  it("returns error when company_name is empty", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "   " })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("company_name")
    expect(accountInsertCalls.length).toBe(0)
  })
})

describe("createAccount — EIN normalization", () => {
  it("normalizes a plain 9-digit EIN to XX-XXXXXXX", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    await createAccount({ company_name: "Digitsolution Agency LLC", ein_number: "301482516" })
    expect(accountInsertCalls[0].ein_number).toBe("30-1482516")
  })

  it("rejects a malformed EIN instead of saving it raw", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Digitsolution Agency LLC", ein_number: "pending" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("Invalid EIN")
    expect(accountInsertCalls.length).toBe(0)
  })

  it("leaves ein_number null when not supplied", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    await createAccount({ company_name: "Digitsolution Agency LLC" })
    expect(accountInsertCalls[0].ein_number).toBeNull()
  })
})

describe("createAccount — near-duplicate guard", () => {
  it("blocks an exact case-insensitive match", async () => {
    allAccounts = [{ id: "acct-existing-1", company_name: "Digitsolution Agency LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "digitsolution agency llc" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
    expect(result.account_id).toBe("acct-existing-1")
    expect(accountInsertCalls.length).toBe(0)
  })

  it("catches a shorter name contained in an existing longer one (the Adact Studio case)", async () => {
    allAccounts = [{ id: "acct-existing-2", company_name: "Adact Studio International LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Adact Studio" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
    expect(result.account_id).toBe("acct-existing-2")
    expect(result.error).toContain("Adact Studio International LLC")
  })

  it("catches names that differ only by legal suffix", async () => {
    allAccounts = [{ id: "acct-existing-3", company_name: "Smith Holdings, LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Smith Holdings Inc" })
    expect(result.outcome).toBe("duplicate")
    expect(result.account_id).toBe("acct-existing-3")
  })

  it("does not flag unrelated names that happen to share a short fragment", async () => {
    allAccounts = [{ id: "acct-existing-4", company_name: "Co Ventures LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Blue Sky Consulting LLC" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
  })

  it("does not flag a generic short word as a duplicate (caught live in sandbox QA: an existing account literally named 'Test' collided with a name that merely contained the word 'test')", async () => {
    allAccounts = [{ id: "acct-existing-6", company_name: "Test" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "QA Full Flow Test LLC" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
  })

  it("still blocks an exact match even when the name is short", async () => {
    allAccounts = [{ id: "acct-existing-7", company_name: "Test" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "test" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
  })

  it("does not mistake 'Lilac Consulting LLC' for a duplicate of another '...Consulting LLC' (a suffix-stripping regex bug found in review: unescaped periods in 'l.l.c' matched the middle of the word 'lilac')", async () => {
    allAccounts = [{ id: "acct-existing-8", company_name: "Blue Sky Consulting LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Lilac Consulting LLC" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
  })

  it("still catches two accounts named literally just 'LLC' as an exact duplicate (a suffix-only name normalizes to empty, which used to silently bypass the guard)", async () => {
    allAccounts = [{ id: "acct-existing-9", company_name: "LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "LLC" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
  })

  it("catches two suffix-only names that differ only by punctuation ('LLC' vs 'L.L.C.') — the raw fallback used to compare unstripped punctuation, so these looked different even though they normalize to the same word", async () => {
    allAccounts = [{ id: "acct-existing-10", company_name: "L.L.C." }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "LLC" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
  })

  it("allows creation when no account matches", async () => {
    allAccounts = [{ id: "acct-existing-5", company_name: "Totally Different Co LLC" }]
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Digitsolution Agency LLC" })
    expect(result.success).toBe(true)
    expect(accountInsertCalls.length).toBe(1)
  })
})

describe("createAccount — happy path", () => {
  it("defaults portal_tier to null and account_type to Client", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Digitsolution Agency LLC" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
    expect(result.account_id).toBe("acct-new-1")

    expect(accountInsertCalls.length).toBe(1)
    expect(accountInsertCalls[0].portal_tier).toBeNull()
    expect(accountInsertCalls[0].account_type).toBe("Client")
    expect(accountInsertCalls[0].company_name).toBe("Digitsolution Agency LLC")
  })

  it("honors an explicit account_type override", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    await createAccount({ company_name: "One Off Job LLC", account_type: "One-Time" })
    expect(accountInsertCalls[0].account_type).toBe("One-Time")
  })

  it("defaults status to Pending Formation when not supplied", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    await createAccount({ company_name: "New Co LLC" })
    expect(accountInsertCalls[0].status).toBe("Pending Formation")
  })

  it("logs to action_log with the provided actor", async () => {
    const { createAccount } = await import("@/lib/operations/account")
    await createAccount({ company_name: "Digitsolution Agency LLC", actor: "dashboard:luca" })
    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("dashboard:luca")
    expect(actionLogCalls[0].action_type).toBe("create")
    expect(actionLogCalls[0].table_name).toBe("accounts")
    expect(actionLogCalls[0].account_id).toBe("acct-new-1")
    expect(actionLogCalls[0].summary).toBe("Created: Digitsolution Agency LLC")
  })
})

describe("createAccount — db error", () => {
  it("surfaces the underlying insert error", async () => {
    accountInsertResult = { data: null, error: { message: "null value in column violates not-null constraint" } }
    const { createAccount } = await import("@/lib/operations/account")
    const result = await createAccount({ company_name: "Broken LLC" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("not-null constraint")
    expect(actionLogCalls.length).toBe(0)
  })
})

// ─── createAndLinkContact ────────────────────────────────

describe("createAndLinkContact — validation", () => {
  it("returns error when account_id is missing", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "", first_name: "Jane", last_name: "Smith" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("account_id")
  })

  it("returns error when first_name is empty", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "  ", last_name: "Smith" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("first_name")
  })

  it("allows a blank last_name (the account-detail Add Contact panel still permits a single-word name)", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "Madonna", last_name: "" })
    expect(result.success).toBe(true)
  })
})

describe("createAndLinkContact — exact email+name match auto-links (the only case that never asks)", () => {
  it("auto-links when the full legal name (including middle) exactly matches an existing contact on that email", async () => {
    sameEmailContacts = [{ id: "contact-existing-john", full_name: "John Michael Smith", email: "john@example.com" }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      middle_name: "Michael",
      last_name: "Smith",
      email: "john@example.com",
    })
    expect(result.success).toBe(true)
    expect(result.contact_id).toBe("contact-existing-john")
    expect(result.warning).toBeUndefined()
    expect(contactsInsertCalls.length).toBe(0)
    expect(resolveMemberContactIdMock).not.toHaveBeenCalled()
  })

  it("correctly picks the matching person out of TWO contacts that share one email (the family-LLC case) instead of merging or guessing", async () => {
    sameEmailContacts = [
      { id: "contact-father", full_name: "John Smith", email: "family@biz.com" },
      { id: "contact-son", full_name: "John David Smith", email: "family@biz.com" },
    ]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      middle_name: "David",
      last_name: "Smith",
      email: "family@biz.com",
    })
    expect(result.contact_id).toBe("contact-son")
    expect(result.warning).toBeUndefined()
  })

  it("fills blank address fields on the matched existing contact without overwriting a value that's already there", async () => {
    sameEmailContacts = [
      { id: "contact-existing-john", full_name: "John Smith", email: "john@example.com", address_city: "Boston", address_line1: null },
    ]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      last_name: "Smith",
      email: "john@example.com",
      address_city: "Miami",
      address_line1: "1 Main St",
    })
    expect(contactsUpdateCalls.length).toBe(1)
    expect(contactsUpdateCalls[0].id).toBe("contact-existing-john")
    // Boston was already there — must NOT be overwritten with Miami.
    expect(contactsUpdateCalls[0].patch.address_city).toBeUndefined()
    // address_line1 was blank — the new value fills it.
    expect(contactsUpdateCalls[0].patch.address_line1).toBe("1 Main St")
  })

  it("skips the address refresh entirely when nothing is blank to fill", async () => {
    sameEmailContacts = [
      { id: "contact-existing-john", full_name: "John Smith", email: "john@example.com", address_city: "Boston" },
    ]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "John", last_name: "Smith", email: "john@example.com", address_city: "Miami" })
    expect(contactsUpdateCalls.length).toBe(0)
  })
})

describe("createAndLinkContact — anything less than an exact match creates new + warns instead of guessing", () => {
  it("does NOT auto-link when the stored name lacks the middle name just submitted — creates a new contact and warns instead of silently merging or silently duplicating", async () => {
    sameEmailContacts = [{ id: "contact-existing-john", full_name: "John Smith", email: "john@example.com" }]
    contactRolesByContactId["contact-existing-john"] = [{ role: "owner", accounts: { company_name: "Smith LLC" } }]
    resolveMemberContactIdMock.mockResolvedValue("contact-resolved-1")
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      middle_name: "Michael",
      last_name: "Smith",
      email: "john@example.com",
    })
    expect(result.success).toBe(true)
    expect(result.contact_id).toBe("contact-resolved-1")
    expect(result.warning).toBeTruthy()
    expect(result.warning).toContain("John Smith")
    expect(result.warning).toContain("Smith LLC")
  })

  it("warns when an email is shared with a completely different name on file (does not assume same person)", async () => {
    sameEmailContacts = [{ id: "contact-other-person", full_name: "Someone Else", email: "shared@biz.com" }]
    contactRolesByContactId["contact-other-person"] = [{ role: "Member", accounts: { company_name: "Shared LLC" } }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "New", last_name: "Person", email: "shared@biz.com" })
    expect(result.success).toBe(true)
    expect(result.warning).toContain("Someone Else")
    expect(result.warning).toContain("Shared LLC")
  })

  it("warns on an exact name match under a DIFFERENT email, listing that person's other companies/roles (the Damiano Mocellin case)", async () => {
    sameNameContacts = [{ id: "contact-damiano", full_name: "Damiano Mocellin", email: "info@orizzonti.us" }]
    contactRolesByContactId["contact-damiano"] = [
      { role: "owner", accounts: { company_name: "Orizzonti LLC" } },
      { role: "Member", accounts: { company_name: "Oh My Creatives LLC" } },
    ]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Damiano",
      last_name: "Mocellin",
      email: "hello@ohmycreatives.com",
    })
    expect(result.success).toBe(true)
    expect(result.warning).toContain("Damiano Mocellin")
    expect(result.warning).toContain("Orizzonti LLC")
    expect(result.warning).toContain("Oh My Creatives LLC")
  })

  it("does not warn on a same-name match when no email was given at all and none exists on the matched contact either (still surfaces — email absence isn't a reason to hide a real name collision)", async () => {
    sameNameContacts = [{ id: "contact-existing", full_name: "Jane Smith", email: null }]
    contactRolesByContactId["contact-existing"] = [{ role: "owner", accounts: { company_name: "Jane's LLC" } }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "Jane", last_name: "Smith" })
    expect(result.warning).toContain("Jane Smith")
  })

  it("does not warn when there is no email match and no name match — and actually completes the save, not just the warning check", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "Brand", last_name: "New", email: "brand.new@example.com" })
    expect(result.warning).toBeUndefined()
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("linked")
    expect(result.contact_id).toBe("contact-resolved-1")
    expect(accountContactsInsertCalls.length).toBe(1)
  })
})

describe("createAndLinkContact — both warnings fire independently (not mutually exclusive)", () => {
  it("surfaces BOTH the email-collision warning and the exact-name-match (Damiano) warning when both conditions are true — a prior bug's `if (!warning)` guard silently dropped the second one whenever the first fired", async () => {
    sameEmailContacts = [{ id: "contact-other-person", full_name: "Someone Else", email: "shared@biz.com" }]
    contactRolesByContactId["contact-other-person"] = [{ role: "Member", accounts: { company_name: "Shared LLC" } }]
    sameNameContacts = [{ id: "contact-damiano", full_name: "Damiano Mocellin", email: "info@orizzonti.us" }]
    contactRolesByContactId["contact-damiano"] = [{ role: "owner", accounts: { company_name: "Orizzonti LLC" } }]

    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Damiano",
      last_name: "Mocellin",
      email: "shared@biz.com",
    })
    expect(result.warning).toContain("Someone Else")
    expect(result.warning).toContain("Damiano Mocellin")
    expect(result.warning).toContain("Orizzonti LLC")
  })
})

describe("createAndLinkContact — ILIKE wildcard escaping is actually applied (not a mock no-op)", () => {
  it("escapes % and _ before building both the email and the full-name search patterns", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Jane_50%",
      last_name: "O'Brien",
      email: "jane_doe@gmail.com",
    })
    expect(emailIlikeCalls[0]).toBe("%jane\\_doe@gmail.com%")
    expect(nameIlikeCalls[0]).toBe("%Jane\\_50\\% O'Brien%")
  })

  it("collapses internal double-spaces (a typo within a single name field) before building the name search pattern, matching the whitespace-collapsed comparison used to judge an exact match", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "Jane  Ann", last_name: "Smith", email: null })
    expect(nameIlikeCalls[0]).toBe("%Jane Ann Smith%")
  })
})

describe("createAndLinkContact — excludes merged contacts from identity candidates", () => {
  it("filters merged_into IS NULL on both the email and the name candidate queries", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "Brand", last_name: "New", email: "brand.new@example.com" })
    expect(emailIsCalls[0]).toEqual(["merged_into", null])
    expect(nameIsCalls[0]).toEqual(["merged_into", null])
  })
})

describe("createAndLinkContact — refresh treats a whitespace-only existing value as blank", () => {
  it("fills a field whose on-file value is only whitespace instead of treating it as already-set", async () => {
    sameEmailContacts = [
      { id: "contact-existing-john", full_name: "John Smith", email: "john@example.com", address_city: "   ", address_line1: null },
    ]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      last_name: "Smith",
      email: "john@example.com",
      address_city: "Miami",
    })
    expect(contactsUpdateCalls.length).toBe(1)
    expect(contactsUpdateCalls[0].patch.address_city).toBe("Miami")
  })
})

describe("createAndLinkContact — a describeContactRoles lookup failure never crashes the write", () => {
  it("still creates the contact and returns a degraded (not misleadingly empty) warning instead of throwing", async () => {
    sameEmailContacts = [{ id: "contact-other-person", full_name: "Someone Else", email: "shared@biz.com" }]
    contactRolesError = { message: "connection reset" }
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "New", last_name: "Person", email: "shared@biz.com" })
    expect(result.success).toBe(true)
    expect(result.warning).toContain("unable to verify")
  })
})

describe("createAndLinkContact — contact resolution fallback", () => {
  it("falls back to a direct contact insert when resolveMemberContactId returns null", async () => {
    resolveMemberContactIdMock.mockResolvedValue(null)
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({
      account_id: "acct-1",
      first_name: "No",
      last_name: "Email Person",
      email: null,
    })
    expect(result.success).toBe(true)
    expect(result.contact_id).toBe("contact-fallback-1")
    expect(contactsInsertCalls.length).toBe(1)
    expect(contactsInsertCalls[0].full_name).toBe("No Email Person")
    expect(accountContactsInsertCalls[0].contact_id).toBe("contact-fallback-1")
  })
})

describe("createAndLinkContact — link semantics", () => {
  it("passes role and is_primary through to the account_contacts row", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Jane",
      last_name: "Smith",
      email: "jane@example.com",
      role: "owner",
      is_primary: true,
    })
    expect(accountContactsInsertCalls[0]).toMatchObject({
      account_id: "acct-1",
      contact_id: "contact-resolved-1",
      role: "owner",
      is_primary: true,
    })
  })

  it("defaults role to owner and is_primary to false when not supplied", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "Jane", last_name: "Smith" })
    expect(accountContactsInsertCalls[0]).toMatchObject({ role: "owner", is_primary: false })
  })

  it("skips the insert and returns already_linked when the pair already exists", async () => {
    accountContactsExistingLink = { account_id: "acct-1" }
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "Jane", last_name: "Smith" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_linked")
    expect(accountContactsInsertCalls.length).toBe(0)
  })

  it("surfaces the account_contacts insert error", async () => {
    accountContactsInsertError = { message: "duplicate key value violates unique constraint" }
    const { createAndLinkContact } = await import("@/lib/operations/account")
    const result = await createAndLinkContact({ account_id: "acct-1", first_name: "Jane", last_name: "Smith" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("duplicate key")
  })

  it("logs to action_log with the provided actor and composed name", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Jane",
      last_name: "Smith",
      actor: "dashboard:luca",
    })
    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("dashboard:luca")
    expect(actionLogCalls[0].table_name).toBe("account_contacts")
    expect(actionLogCalls[0].summary).toContain("Jane Smith")
  })
})
