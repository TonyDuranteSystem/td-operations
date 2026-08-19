/**
 * lib/operations/account.ts — createAccount() + createAndLinkContact() unit tests
 *
 * These are the operations-layer replacements for the raw RLS-scoped inserts
 * that never succeeded in production (accounts/contacts had no staff INSERT
 * policy — see dev_task 7ebb1e0c). Covers: near-duplicate-name guard (not
 * just exact matches), the portal_tier/account_type defaults, structured
 * name capture with middle-name-safe contact matching, address refresh on an
 * existing match, and action_log writes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let allAccounts: Array<{ id: string; company_name: string }> = []
let accountInsertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "acct-new-1" },
  error: null,
}
let sameEmailContacts: Array<{ id: string; full_name: string | null }> = []
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
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(() => Promise.resolve({ data: accountContactsExistingLink, error: null })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            accountContactsInsertCalls.push(payload)
            return Promise.resolve({ error: accountContactsInsertError })
          }),
        }
      }
      if (table === "contacts") {
        return {
          select: vi.fn(() => ({
            ilike: vi.fn(() => Promise.resolve({ data: sameEmailContacts, error: null })),
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
  accountContactsExistingLink = null
  accountContactsInsertError = null
  contactsInsertResult = { data: { id: "contact-fallback-1" }, error: null }
  accountInsertCalls.length = 0
  contactsUpdateCalls.length = 0
  accountContactsInsertCalls.length = 0
  contactsInsertCalls.length = 0
  actionLogCalls.length = 0
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

describe("createAndLinkContact — name composition", () => {
  it("composes the legal full name from first + middle + last for a brand-new contact", async () => {
    resolveMemberContactIdMock.mockResolvedValue(null)
    contactsInsertResult = { data: { id: "contact-fallback-1" }, error: null }
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "Dante", middle_name: "Michael", last_name: "Basso" })
    expect(contactsInsertCalls[0].full_name).toBe("Dante Michael Basso")
    expect(contactsInsertCalls[0].first_name).toBe("Dante")
    expect(contactsInsertCalls[0].last_name).toBe("Basso")
  })

  it("passes the middle-name-inclusive legal name to resolveMemberContactId as the create-fallback name", async () => {
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "Dante",
      middle_name: "Michael",
      last_name: "Basso",
      email: "dante@example.com",
    })
    expect(resolveMemberContactIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Dante Michael Basso" })
    )
  })
})

describe("createAndLinkContact — middle-name-safe identity matching", () => {
  it("finds an existing contact on file WITHOUT a middle name, even when one is provided now", async () => {
    sameEmailContacts = [{ id: "contact-existing-john", full_name: "John Smith" }]
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
    // Reused the existing record — never called the create-fallback insert,
    // and never even reached resolveMemberContactId's own (middle-name-
    // inclusive) matching attempt.
    expect(contactsInsertCalls.length).toBe(0)
    expect(resolveMemberContactIdMock).not.toHaveBeenCalled()
  })

  it("fills blank address fields on the matched existing contact without overwriting anything", async () => {
    sameEmailContacts = [{ id: "contact-existing-john", full_name: "John Smith" }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({
      account_id: "acct-1",
      first_name: "John",
      last_name: "Smith",
      email: "john@example.com",
      address_city: "Miami",
    })
    expect(contactsUpdateCalls.length).toBe(1)
    expect(contactsUpdateCalls[0].id).toBe("contact-existing-john")
    expect(contactsUpdateCalls[0].patch).toMatchObject({ address_city: "Miami" })
    expect(contactsUpdateCalls[0].patch.address_line1).toBeUndefined()
  })

  it("skips the address refresh entirely when no address fields are provided", async () => {
    sameEmailContacts = [{ id: "contact-existing-john", full_name: "John Smith" }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "John", last_name: "Smith", email: "john@example.com" })
    expect(contactsUpdateCalls.length).toBe(0)
  })

  it("falls through to resolveMemberContactId when no same-email contact matches by name", async () => {
    sameEmailContacts = [{ id: "contact-someone-else", full_name: "Someone Else" }]
    const { createAndLinkContact } = await import("@/lib/operations/account")
    await createAndLinkContact({ account_id: "acct-1", first_name: "John", last_name: "Smith", email: "john@example.com" })
    expect(resolveMemberContactIdMock).toHaveBeenCalled()
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
