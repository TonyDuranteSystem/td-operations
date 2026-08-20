/**
 * app/(dashboard)/accounts/actions.ts — createAccount() + createAndLinkContact()
 * server-action wrapper tests.
 *
 * These two wrappers had ZERO test coverage (QA-Tester finding, council
 * review 2026-08-19, dev_task 693273fd) — every existing test exercised the
 * lib/operations/account.ts layer directly, never the Zod validation +
 * warning passthrough these wrappers add on top. Covers: schema rejection,
 * the partial-success fallback (account created, contact link failed), and
 * that a contact-match `warning` survives the round trip to the caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

// linkContactToAccount (exercised by createAccount's existing-contact path)
// is a real, unmocked sibling function in the same module — it calls
// createClient() itself, so the RLS-scoped client mock must support the
// account_contacts chain it actually uses, plus the fire-and-forget
// action_log insert safeAction makes on every call.
let accountContactsExistingLink: { account_id: string } | null = null
let accountContactsInsertError: { message: string } | null = null
const accountContactsInsertCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { email: "luca@tonydurante.us" } } }) },
    from: (table: string) => {
      if (table === "account_contacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: accountContactsExistingLink, error: null }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            accountContactsInsertCalls.push(payload)
            return Promise.resolve({ error: accountContactsInsertError })
          },
        }
      }
      // action_log — fire-and-forget, any resolved shape is fine.
      return { insert: () => Promise.resolve({ error: null }) }
    },
  }),
}))

const createAccountOpMock = vi.fn()
const createAndLinkContactOpMock = vi.fn()

vi.mock("@/lib/operations/account", () => ({
  createAccount: (params: Record<string, unknown>) => createAccountOpMock(params),
  createAndLinkContact: (params: Record<string, unknown>) => createAndLinkContactOpMock(params),
}))

beforeEach(() => {
  createAccountOpMock.mockReset()
  createAndLinkContactOpMock.mockReset()
  createAccountOpMock.mockResolvedValue({ success: true, outcome: "created", account_id: "acct-new-1" })
  createAndLinkContactOpMock.mockResolvedValue({ success: true, outcome: "linked", contact_id: "contact-new-1" })
  accountContactsExistingLink = null
  accountContactsInsertError = null
  accountContactsInsertCalls.length = 0
})

const VALID_ACCOUNT = {
  company_name: "Digitsolution Agency LLC",
  entity_type: "Single Member LLC" as const,
  member_structure: "single_member" as const,
  state_of_formation: "Delaware",
  status: "Pending Formation" as const,
  account_type: "Client" as const,
}

const VALID_CONTACT = {
  first_name: "Jane",
  last_name: "Smith",
  email: "jane@example.com",
}

describe("createAccount action — validation", () => {
  it("rejects an invalid account payload before ever calling the operations layer", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount({ ...VALID_ACCOUNT, company_name: "" }, VALID_CONTACT)
    expect(result.success).toBe(false)
    expect(createAccountOpMock).not.toHaveBeenCalled()
  })

  it("rejects an invalid primary contact payload before ever calling the operations layer", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, { ...VALID_CONTACT, first_name: "" })
    expect(result.success).toBe(false)
    expect(createAccountOpMock).not.toHaveBeenCalled()
  })
})

describe("createAccount action — happy path", () => {
  it("creates the account then links the contact, tagging the actor from the session user", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, VALID_CONTACT)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: "acct-new-1" })
    expect(createAccountOpMock).toHaveBeenCalledTimes(1)
    expect(createAccountOpMock.mock.calls[0][0]).toMatchObject({ company_name: "Digitsolution Agency LLC", actor: "dashboard:luca" })
    expect(createAndLinkContactOpMock).toHaveBeenCalledTimes(1)
    expect(createAndLinkContactOpMock.mock.calls[0][0]).toMatchObject({
      account_id: "acct-new-1",
      first_name: "Jane",
      last_name: "Smith",
      role: "owner",
      is_primary: true,
      actor: "dashboard:luca",
    })
  })

  it("passes a contact-identity warning through to the caller instead of swallowing it", async () => {
    createAndLinkContactOpMock.mockResolvedValue({ success: true, outcome: "linked", contact_id: "contact-new-1", warning: "A contact named \"Jane Smith\" already exists — linked to: Other LLC (owner)." })
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, VALID_CONTACT)
    expect(result.success).toBe(true)
    expect(result.warning).toContain("Jane Smith")
  })
})

describe("createAccount action — partial failure (account created, contact link failed)", () => {
  it("still reports success with the account id, surfacing the contact failure as a warning instead of an error", async () => {
    createAndLinkContactOpMock.mockResolvedValue({ success: false, outcome: "error", error: "insert failed" })
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, VALID_CONTACT)
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: "acct-new-1" })
    expect(result.warning).toContain("insert failed")
  })
})

describe("createAccount action — picking an existing contact instead of typing a new one", () => {
  it("does not require first/last name when an existing contact id is supplied", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, null, "contact-existing-1")
    expect(result.success).toBe(true)
    expect(createAndLinkContactOpMock).not.toHaveBeenCalled()
  })

  it("Single-Member: links the picked contact as owner AND marks them the account's primary contact — no fuzzy matching runs at all", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, null, "contact-existing-1")
    expect(result.success).toBe(true)
    expect(result.needsMemberSetup).toBe(false)
    expect(accountContactsInsertCalls[0]).toMatchObject({
      account_id: "acct-new-1",
      contact_id: "contact-existing-1",
      role: "owner",
      is_primary: true,
    })
  })

  it("Multi-Member: links the picked contact but does NOT mark them primary, and flags that member setup is still needed", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount({ ...VALID_ACCOUNT, member_structure: "multi_member" }, null, "contact-existing-1")
    expect(result.success).toBe(true)
    expect(result.needsMemberSetup).toBe(true)
    expect(accountContactsInsertCalls[0]).toMatchObject({ role: "owner", is_primary: false })
  })

  it("surfaces a partial-success warning when the account is created but linking the existing contact fails", async () => {
    accountContactsInsertError = { message: "duplicate key value violates unique constraint" }
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, null, "contact-existing-1")
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ id: "acct-new-1" })
    expect(result.warning).toContain("duplicate key")
  })
})

describe("createAccount action — needsMemberSetup on the ordinary new-contact path", () => {
  it("flags needsMemberSetup for a Multi-Member account even when the contact was freshly typed, not picked — this dialog is never covered by the client formation workflow's own member collection", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount({ ...VALID_ACCOUNT, member_structure: "multi_member" }, VALID_CONTACT)
    expect(result.success).toBe(true)
    expect(result.needsMemberSetup).toBe(true)
  })

  it("does not flag needsMemberSetup for a Single-Member account", async () => {
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, VALID_CONTACT)
    expect(result.success).toBe(true)
    expect(result.needsMemberSetup).toBe(false)
  })
})

describe("createAccount action — account creation failure", () => {
  it("returns the operations-layer error and never attempts to link a contact", async () => {
    createAccountOpMock.mockResolvedValue({ success: false, outcome: "duplicate", error: "An account with a very similar name already exists" })
    const { createAccount } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAccount(VALID_ACCOUNT, VALID_CONTACT)
    expect(result.success).toBe(false)
    expect(result.error).toContain("already exists")
    expect(createAndLinkContactOpMock).not.toHaveBeenCalled()
  })
})

// ─── createAndLinkContact (the account-detail "Add Contact" wrapper) ────

describe("createAndLinkContact action — validation", () => {
  it("rejects an empty name without calling the operations layer", async () => {
    const { createAndLinkContact } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAndLinkContact("acct-1", "   ", null)
    expect(result.success).toBe(false)
    expect(createAndLinkContactOpMock).not.toHaveBeenCalled()
  })
})

describe("createAndLinkContact action — name splitting", () => {
  it("splits a single-word name into first_name only, with an empty last_name", async () => {
    const { createAndLinkContact } = await import("@/app/(dashboard)/accounts/actions")
    await createAndLinkContact("acct-1", "Madonna", null)
    expect(createAndLinkContactOpMock.mock.calls[0][0]).toMatchObject({ first_name: "Madonna", last_name: "" })
  })

  it("splits a multi-word name into first_name + the remaining words joined as last_name", async () => {
    const { createAndLinkContact } = await import("@/app/(dashboard)/accounts/actions")
    await createAndLinkContact("acct-1", "John Michael Smith", "john@example.com")
    expect(createAndLinkContactOpMock.mock.calls[0][0]).toMatchObject({ first_name: "John", last_name: "Michael Smith" })
  })
})

describe("createAndLinkContact action — warning passthrough", () => {
  it("carries the operations-layer warning through to the caller", async () => {
    createAndLinkContactOpMock.mockResolvedValue({ success: true, outcome: "linked", contact_id: "contact-1", warning: "This email is already on file for a different name: Someone Else — Shared LLC (Member)." })
    const { createAndLinkContact } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAndLinkContact("acct-1", "New Person", "shared@biz.com")
    expect(result.success).toBe(true)
    expect(result.contactId).toBe("contact-1")
    expect(result.warning).toContain("Someone Else")
  })

  it("surfaces the operations-layer error and returns success:false on failure", async () => {
    createAndLinkContactOpMock.mockResolvedValue({ success: false, outcome: "error", error: "account_contacts insert failed" })
    const { createAndLinkContact } = await import("@/app/(dashboard)/accounts/actions")
    const result = await createAndLinkContact("acct-1", "Jane Smith", "jane@example.com")
    expect(result.success).toBe(false)
    expect(result.error).toContain("account_contacts insert failed")
  })
})
