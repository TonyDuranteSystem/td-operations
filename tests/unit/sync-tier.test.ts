/**
 * syncTier + computeContactTier unit tests
 *
 * Mock strategy: in-memory Maps for accounts/contacts, two separate
 * link arrays for each account_contacts query direction, vi.fn() for auth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── State ───────────────────────────────────────────────

type AccountRow = { portal_tier: string | null }
type ContactRow = { id: string; email: string | null; portal_tier: string | null }

let accountMap: Map<string, AccountRow>
let contactMap: Map<string, ContactRow>
// Separate link arrays for each query direction (allows asymmetric test fixtures)
let acToContactLinks: Array<{ account_id: string; contact_id: string }>
let ctToAccountLinks: Array<{ account_id: string; contact_id: string }>
let insertLog: Array<{ table: string; payload: unknown }>
let updateLog: Array<{ table: string; where: Record<string, unknown>; payload: unknown }>
const mockUpdateUserById = vi.fn()
let mockFindAuthUserByEmail: (email: string) => Promise<unknown>

// ─── Mock: supabase-admin ─────────────────────────────────

function buildChain(table: string) {
  let eqColumn = ""
  let eqValue = ""
  let inValues: string[] = []
  let isUpdate = false
  let updatePayload: Record<string, unknown> = {}

  function resolve(): { data: unknown; error: unknown } {
    if (table === "accounts") {
      if (inValues.length > 0) {
        const rows = inValues.map(id => accountMap.get(id)).filter(Boolean)
        return { data: rows, error: null }
      }
      const row = accountMap.get(eqValue)
      return row ? { data: row, error: null } : { data: null, error: { message: "not found" } }
    }
    if (table === "contacts") {
      const row = contactMap.get(eqValue)
      return row ? { data: row, error: null } : { data: null, error: { message: "not found" } }
    }
    if (table === "account_contacts") {
      if (eqColumn === "account_id") {
        const rows = acToContactLinks
          .filter(r => r.account_id === eqValue)
          .map(r => ({ contact_id: r.contact_id }))
        return { data: rows, error: null }
      }
      if (eqColumn === "contact_id") {
        const rows = ctToAccountLinks
          .filter(r => r.contact_id === eqValue)
          .map(r => ({ account_id: r.account_id }))
        return { data: rows, error: null }
      }
    }
    return { data: null, error: null }
  }

  const chain = {
    select: (_cols?: string) => chain,

    update(payload: Record<string, unknown>) {
      isUpdate = true
      updatePayload = payload
      return chain
    },

    insert(payload: Record<string, unknown>) {
      insertLog.push({ table, payload })
      return Promise.resolve({ data: null, error: null })
    },

    eq(col: string, val: string) {
      eqColumn = col
      eqValue = val
      if (isUpdate) {
        updateLog.push({ table, where: { [col]: val }, payload: { ...updatePayload } })
        // Mutate in-memory state so subsequent reads see the new value
        if (table === "accounts") {
          const cur = accountMap.get(val)
          if (cur) accountMap.set(val, { ...cur, ...updatePayload } as AccountRow)
        }
        if (table === "contacts") {
          const cur = contactMap.get(val)
          if (cur) contactMap.set(val, { ...cur, ...updatePayload } as ContactRow)
        }
        isUpdate = false
        return Promise.resolve({ data: null, error: null })
      }
      return chain
    },

    in(_col: string, vals: string[]) {
      inValues = vals
      return chain
    },

    single: () => Promise.resolve(resolve()),

    then(onfulfilled: (v: unknown) => void) {
      onfulfilled(resolve())
    },
  }

  return chain
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => buildChain(table),
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) => {
          mockUpdateUserById(...args)
          return Promise.resolve({ data: null, error: null })
        },
      },
    },
  },
}))

vi.mock("@/lib/auth-admin-helpers", () => ({
  findAuthUserByEmail: (email: string) => mockFindAuthUserByEmail(email),
}))

import { syncTier, computeContactTier } from "@/lib/operations/sync-tier"

// ─── Setup ───────────────────────────────────────────────

beforeEach(() => {
  accountMap = new Map()
  contactMap = new Map()
  acToContactLinks = []
  ctToAccountLinks = []
  insertLog = []
  updateLog = []
  mockUpdateUserById.mockReset()
  mockFindAuthUserByEmail = vi.fn().mockResolvedValue(null)
})

// ─── computeContactTier ──────────────────────────────────

describe("computeContactTier", () => {
  it("returns null when contact has no linked accounts", async () => {
    const tier = await computeContactTier("c1")
    expect(tier).toBeNull()
  })

  it("returns null when all linked accounts have excluded tiers", async () => {
    accountMap.set("acc-B", { portal_tier: "inactive" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })
    const tier = await computeContactTier("c1")
    expect(tier).toBeNull()
  })

  it("returns null when all linked accounts have null portal_tier", async () => {
    accountMap.set("acc-B", { portal_tier: null })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })
    const tier = await computeContactTier("c1")
    expect(tier).toBeNull()
  })

  it("returns the single valid account tier", async () => {
    accountMap.set("acc-A", { portal_tier: "formation" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    const tier = await computeContactTier("c1")
    expect(tier).toBe("formation")
  })

  it("returns the highest tier across multiple accounts", async () => {
    accountMap.set("acc-A", { portal_tier: "formation" })
    accountMap.set("acc-B", { portal_tier: "active" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })
    const tier = await computeContactTier("c1")
    expect(tier).toBe("active")
  })

  it("skips inactive accounts when computing highest tier", async () => {
    accountMap.set("acc-A", { portal_tier: "formation" })
    accountMap.set("acc-B", { portal_tier: "inactive" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })
    const tier = await computeContactTier("c1")
    expect(tier).toBe("formation")
  })

  it("skips suspended accounts when computing highest tier", async () => {
    accountMap.set("acc-A", { portal_tier: "onboarding" })
    accountMap.set("acc-B", { portal_tier: "suspended" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })
    const tier = await computeContactTier("c1")
    expect(tier).toBe("onboarding")
  })
})

// ─── syncTier ────────────────────────────────────────────

describe("syncTier", () => {
  // Test 6: Invalid tier rejected
  it("returns error for invalid tier without touching DB", async () => {
    const result = await syncTier({
      accountId: "acc-A",
      newTier: "banana" as "active",
      reason: "test",
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid tier/)
    expect(updateLog).toHaveLength(0)
    expect(insertLog).toHaveLength(0)
  })

  it("returns error when account does not exist", async () => {
    const result = await syncTier({ accountId: "missing", newTier: "active", reason: "test" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Account not found/)
  })

  // Test 1: Normal set — account onboarding → active, single contact follows
  it("Test 1: normal tier change propagates to linked contact", async () => {
    accountMap.set("acc-A", { portal_tier: "onboarding" })
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "onboarding" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })

    mockFindAuthUserByEmail = vi.fn().mockResolvedValue({
      id: "auth-1",
      email: "user@example.com",
      app_metadata: { portal_tier: "onboarding" },
    })

    const result = await syncTier({ accountId: "acc-A", newTier: "active", reason: "payment-confirmed" })

    expect(result.success).toBe(true)
    expect(result.previousTier).toBe("onboarding")
    expect(result.newTier).toBe("active")
    expect(result.contactsUpdated).toHaveLength(1)
    expect(result.contactsUpdated[0]).toMatchObject({
      contactId: "c1",
      previousTier: "onboarding",
      newTier: "active",
    })

    // Account write
    const acctUpdate = updateLog.find(w => w.table === "accounts")
    expect(acctUpdate?.payload).toMatchObject({ portal_tier: "active" })

    // Contact write
    const contactUpdate = updateLog.find(w => w.table === "contacts")
    expect(contactUpdate?.payload).toMatchObject({ portal_tier: "active" })

    // Auth sync
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      "auth-1",
      expect.objectContaining({
        app_metadata: expect.objectContaining({ portal_tier: "active" }),
      }),
    )
  })

  // Test 2: Multi-account contact — highest tier wins
  it("Test 2: contact with higher-tier account keeps its higher tier", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })   // being changed to formation
    accountMap.set("acc-B", { portal_tier: "active" }) // existing higher tier
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "lead" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    // Contact is also linked to acc-B from contact's perspective
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })

    const result = await syncTier({ accountId: "acc-A", newTier: "formation", reason: "test" })

    expect(result.success).toBe(true)
    // Contact should get 'active' (highest across acc-A=formation + acc-B=active)
    expect(result.contactsUpdated[0]?.newTier).toBe("active")

    const contactUpdate = updateLog.find(w => w.table === "contacts")
    expect(contactUpdate?.payload).toMatchObject({ portal_tier: "active" })
  })

  // Test 3: No-account contact — contact tier preserved, not downgraded
  it("Test 3: contact with no valid reverse links is skipped (tier preserved)", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "active" })
    // c1 appears from account's side but has NO reverse links (ITIN-only edge case)
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    // ctToAccountLinks is empty → computeContactTier returns null → tier preserved

    const result = await syncTier({ accountId: "acc-A", newTier: "formation", reason: "test" })

    expect(result.success).toBe(true)
    expect(result.contactsUpdated).toHaveLength(0)
    // Contact was NOT updated
    expect(updateLog.filter(w => w.table === "contacts")).toHaveLength(0)
    // Contact tier still 'active' in memory
    expect(contactMap.get("c1")?.portal_tier).toBe("active")
  })

  // Test 4: Inactive account excluded from tier computation
  it("Test 4: inactive account is excluded from contact tier computation", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })
    accountMap.set("acc-B", { portal_tier: "inactive" })
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "lead" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })

    const result = await syncTier({ accountId: "acc-A", newTier: "formation", reason: "test" })

    expect(result.success).toBe(true)
    // acc-B (inactive) excluded → highest valid tier is acc-A (formation)
    expect(result.contactsUpdated[0]?.newTier).toBe("formation")
  })

  // Test 5: NULL account tier excluded
  it("Test 5: account with null portal_tier is excluded from contact tier computation", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })
    accountMap.set("acc-B", { portal_tier: null })
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "lead" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })

    const result = await syncTier({ accountId: "acc-A", newTier: "onboarding", reason: "test" })

    expect(result.success).toBe(true)
    // acc-B (null tier) excluded → highest valid tier is acc-A (onboarding)
    expect(result.contactsUpdated[0]?.newTier).toBe("onboarding")
  })

  // Test 7: Action log entry created with correct shape
  it("Test 7: writes action_log entry with required fields", async () => {
    accountMap.set("acc-A", { portal_tier: "formation" })
    contactMap.set("c1", { id: "c1", email: null, portal_tier: "formation" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })

    await syncTier({ accountId: "acc-A", newTier: "active", reason: "data-reviewed", actor: "crm:antonio" })

    const logEntry = insertLog.find(e => e.table === "action_log")
    expect(logEntry).toBeDefined()
    expect(logEntry?.payload).toMatchObject({
      actor: "crm:antonio",
      action_type: "tier_sync",
      table_name: "accounts",
      record_id: "acc-A",
      account_id: "acc-A",
      details: expect.objectContaining({
        old_tier: "formation",
        new_tier: "active",
        reason: "data-reviewed",
        actor: "crm:antonio",
      }),
    })
  })

  // Test 8: Auth metadata synced
  it("Test 8: auth app_metadata is updated with new tier", async () => {
    accountMap.set("acc-A", { portal_tier: "formation" })
    contactMap.set("c1", { id: "c1", email: "user@example.com", portal_tier: "formation" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })

    mockFindAuthUserByEmail = vi.fn().mockResolvedValue({
      id: "auth-99",
      email: "user@example.com",
      app_metadata: { portal_tier: "formation", some_other: true },
    })

    await syncTier({ accountId: "acc-A", newTier: "active", reason: "test" })

    expect(mockUpdateUserById).toHaveBeenCalledTimes(1)
    expect(mockUpdateUserById).toHaveBeenCalledWith(
      "auth-99",
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          portal_tier: "active",
          some_other: true, // existing metadata preserved
        }),
      }),
    )
  })

  it("skips auth sync when contact has no email", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })
    contactMap.set("c1", { id: "c1", email: null, portal_tier: "lead" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })

    await syncTier({ accountId: "acc-A", newTier: "formation", reason: "test" })

    expect(mockFindAuthUserByEmail).not.toHaveBeenCalled()
    expect(mockUpdateUserById).not.toHaveBeenCalled()
  })

  it("does not update contact when tier is unchanged", async () => {
    accountMap.set("acc-A", { portal_tier: "lead" })
    contactMap.set("c1", { id: "c1", email: null, portal_tier: "formation" })
    acToContactLinks.push({ account_id: "acc-A", contact_id: "c1" })
    // From contact's side, acc-A updated to formation + acc-B at formation
    accountMap.set("acc-B", { portal_tier: "formation" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-A" })
    ctToAccountLinks.push({ contact_id: "c1", account_id: "acc-B" })

    const result = await syncTier({ accountId: "acc-A", newTier: "formation", reason: "test" })

    expect(result.success).toBe(true)
    // Contact already at formation, computedTier = formation → no update
    expect(result.contactsUpdated).toHaveLength(0)
    expect(updateLog.filter(w => w.table === "contacts")).toHaveLength(0)
  })
})
