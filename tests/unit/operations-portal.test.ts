/**
 * P1.6 — lib/operations/portal.ts unit tests
 *
 * Focus: reconcileTier (the new helper added in P1.6 — the other exports
 * are thin re-exports of already-tested functions in
 * lib/portal/auto-create.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Mock harness ──────────────────────────────────────

interface ContactRow {
  id: string
  email: string | null
  portal_tier: string | null
}
interface AccountRow {
  id: string
  portal_tier: string | null
}

let contactFixture: ContactRow | null = null
let linkFixture: Array<{ account_id: string | null }> = []
let accountsFixture: Record<string, AccountRow> = {}
let authUsersFixture: Array<{
  id: string
  email: string
  app_metadata: Record<string, unknown>
}> = []

const writeLog: Array<{ table: string; payload: unknown; filter?: unknown }> = []

function buildTableChain(table: string, resolver: (filterId: string | null) => unknown) {
  let filterId: string | null = null
  let pendingUpdate: unknown = null
  const chain = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn((payload: unknown) => {
      pendingUpdate = payload
      return chain
    }),
    eq: vi.fn((_col: string, value: string) => {
      filterId = value
      if (pendingUpdate !== null) {
        writeLog.push({ table, payload: pendingUpdate, filter: { id: value } })
        pendingUpdate = null
      }
      return chain
    }),
    single: vi.fn(() => Promise.resolve({ data: resolver(filterId), error: null })),
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({ data: resolver(filterId), error: null }),
  }
  return chain
}

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "contacts") {
          return buildTableChain(table, () => contactFixture)
        }
        if (table === "account_contacts") {
          return buildTableChain(table, () => linkFixture)
        }
        if (table === "accounts") {
          return buildTableChain(table, (id) => accountsFixture[id ?? ""] ?? null)
        }
        return buildTableChain(table, () => null)
      },
      auth: {
        admin: {
          listUsers: vi.fn(() =>
            Promise.resolve({
              data: { users: authUsersFixture },
              error: null,
            }),
          ),
          updateUserById: vi.fn((id: string, patch: unknown) => {
            writeLog.push({ table: "auth.users", payload: patch, filter: { id } })
            return Promise.resolve({ data: null, error: null })
          }),
        },
      },
    },
  }
})

// Mock the auto-create module — we only test reconcileTier here
vi.mock("@/lib/portal/auto-create", () => ({
  autoCreatePortalUser: vi.fn(),
  sendPortalWelcomeEmail: vi.fn(),
  upgradePortalTier: vi.fn(),
}))

import { reconcileTier } from "@/lib/operations/portal"

beforeEach(() => {
  contactFixture = null
  linkFixture = []
  accountsFixture = {}
  authUsersFixture = []
  writeLog.length = 0
})

// ─── reconcileTier ─────────────────────────────────────

describe("reconcileTier", () => {
  it("returns error when contact is not found", async () => {
    contactFixture = null
    const result = await reconcileTier({ contact_id: "missing" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Contact not found/)
  })

  it("returns error when contact has no portal_tier and no target_tier provided", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: null,
    }
    const result = await reconcileTier({ contact_id: "c1" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No tier to reconcile/)
  })

  it("uses contacts.portal_tier as source of truth when target_tier omitted", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]
    accountsFixture = { "acc-1": { id: "acc-1", portal_tier: "onboarding" } }
    authUsersFixture = [
      {
        id: "auth-1",
        email: "test@example.com",
        app_metadata: { portal_tier: "onboarding" },
      },
    ]

    const result = await reconcileTier({ contact_id: "c1" })

    expect(result.success).toBe(true)
    expect(result.resolved_tier).toBe("active")
    expect(result.changed.contact).toBe(false) // contact already at 'active'
    expect(result.changed.accounts).toEqual(["acc-1"])
    expect(result.changed.auth_user).toBe(true)

    // Verify writes
    const accountWrite = writeLog.find(
      (w) => w.table === "accounts" && (w.filter as { id: string }).id === "acc-1",
    )
    expect(accountWrite?.payload).toMatchObject({ portal_tier: "active" })

    const authWrite = writeLog.find((w) => w.table === "auth.users")
    expect(authWrite?.payload).toMatchObject({
      app_metadata: expect.objectContaining({ portal_tier: "active" }),
    })
  })

  it("overrides contacts.portal_tier when target_tier is provided", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]
    accountsFixture = { "acc-1": { id: "acc-1", portal_tier: "active" } }
    authUsersFixture = [
      {
        id: "auth-1",
        email: "test@example.com",
        app_metadata: { portal_tier: "active" },
      },
    ]

    const result = await reconcileTier({
      contact_id: "c1",
      target_tier: "lead", // explicit downgrade override
    })

    expect(result.success).toBe(true)
    expect(result.resolved_tier).toBe("lead")
    expect(result.changed.contact).toBe(true)
    expect(result.changed.accounts).toEqual(["acc-1"])
    expect(result.changed.auth_user).toBe(true)

    const contactWrite = writeLog.find((w) => w.table === "contacts")
    expect(contactWrite?.payload).toMatchObject({ portal_tier: "lead" })
  })

  it("does not rewrite already-synced accounts or auth users", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]
    accountsFixture = { "acc-1": { id: "acc-1", portal_tier: "active" } }
    authUsersFixture = [
      {
        id: "auth-1",
        email: "test@example.com",
        app_metadata: { portal_tier: "active" },
      },
    ]

    const result = await reconcileTier({ contact_id: "c1" })

    expect(result.success).toBe(true)
    expect(result.changed.accounts).toEqual([])
    expect(result.changed.auth_user).toBe(false)
    expect(writeLog.filter((w) => w.table === "accounts")).toHaveLength(0)
    expect(writeLog.filter((w) => w.table === "auth.users")).toHaveLength(0)
  })

  it("handles contacts with no linked accounts gracefully", async () => {
    contactFixture = {
      id: "c1",
      email: null,
      portal_tier: "active",
    }
    linkFixture = []
    const result = await reconcileTier({ contact_id: "c1" })
    expect(result.success).toBe(true)
    expect(result.changed.accounts).toEqual([])
    expect(result.changed.auth_user).toBe(false)
  })
})
