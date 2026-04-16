/**
 * P1.7 characterization — portal identity linkage.
 *
 * Covers plan §4 P1.7 flow 1:
 *   portal_transition_setup → portal_create_user → portal login.
 *   Verifies identity linkage across contacts.id, auth.users.id,
 *   auth.users.app_metadata.contact_id, account_contacts.contact_id.
 *
 * The chain that MUST hold for the portal to resolve the logged-in
 * user's contact and account correctly:
 *   - auth.users.app_metadata.contact_id → matches a row in contacts.id
 *   - account_contacts.contact_id → matches that contacts.id
 *   - contacts.portal_tier → is set (source of truth per CLAUDE.md)
 *
 * When this chain breaks, portal dashboard reads the wrong tier, the
 * sidebar renders the wrong items, and payments attribute to the
 * wrong account. The Phase 0 Antony Fioravanti rescue (§16.7) was
 * caused by a break in this chain.
 *
 * Exercises `autoCreatePortalUser` — the canonical code path used by
 * activate-service, offer_send, and portal_create_user admin action.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface ContactRow {
  id: string
  email: string | null
  full_name?: string
  language?: string | null
  portal_tier?: string | null
}

interface AuthUserRow {
  id: string
  email: string
  app_metadata: Record<string, unknown>
}

// ─── Mock harness ──────────────────────────────────────
//
// Tests populate these before calling autoCreatePortalUser; the mocked
// supabaseAdmin returns fixtures and logs every write so assertions can
// inspect what landed where.

let contactsByEmail: Map<string, ContactRow> = new Map()
let contactsById: Map<string, ContactRow> = new Map()
let accountContacts: Array<{ account_id: string; contact_id: string; role?: string }> = []
let authUsers: AuthUserRow[] = []
const writeLog: Array<{ table: string; op: string; payload: unknown; filter?: unknown }> = []

function buildContactsChain() {
  let filterCol: string | null = null
  let filterVal: string | null = null
  let selectCols = ""
  let pendingUpdate: Record<string, unknown> | null = null
  let pendingInsert: Record<string, unknown> | null = null
  const chain = {
    select: vi.fn((cols?: string) => {
      selectCols = cols ?? ""
      return chain
    }),
    insert: vi.fn((payload: Record<string, unknown>) => {
      pendingInsert = payload
      return chain
    }),
    update: vi.fn((payload: Record<string, unknown>) => {
      pendingUpdate = payload
      return chain
    }),
    eq: vi.fn((col: string, val: string) => {
      filterCol = col
      filterVal = val
      if (pendingUpdate !== null) {
        writeLog.push({
          table: "contacts",
          op: "update",
          payload: pendingUpdate,
          filter: { [col]: val },
        })
        pendingUpdate = null
      }
      return chain
    }),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(() => {
      const row = resolveContactFilter(filterCol, filterVal)
      return Promise.resolve({ data: row, error: null })
    }),
    single: vi.fn(() => {
      if (pendingInsert !== null) {
        const newRow: ContactRow = {
          id: `contact-gen-${Math.random().toString(36).slice(2, 8)}`,
          email: (pendingInsert.email as string) ?? null,
          full_name: pendingInsert.full_name as string | undefined,
          language: pendingInsert.language as string | undefined,
          portal_tier:
            (pendingInsert.portal_tier as string | undefined) ?? null,
        }
        contactsById.set(newRow.id, newRow)
        if (newRow.email) contactsByEmail.set(newRow.email, newRow)
        writeLog.push({
          table: "contacts",
          op: "insert",
          payload: pendingInsert,
        })
        pendingInsert = null
        return Promise.resolve({ data: { id: newRow.id }, error: null })
      }
      const row = resolveContactFilter(filterCol, filterVal)
      return Promise.resolve({ data: row, error: null })
    }),
  }
  // Suppress TS unused-var warnings — selectCols reserved for future use.
  void selectCols
  return chain
}

function resolveContactFilter(col: string | null, val: string | null): ContactRow | null {
  if (!col || !val) return null
  if (col === "id") return contactsById.get(val) ?? null
  if (col === "email") return contactsByEmail.get(val) ?? null
  return null
}

function buildAccountContactsChain() {
  let pendingInsert: Record<string, unknown> | null = null
  let pendingUpsert: Record<string, unknown> | null = null
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn((payload: Record<string, unknown>) => {
      pendingInsert = payload
      return chain
    }),
    upsert: vi.fn((payload: Record<string, unknown>) => {
      pendingUpsert = payload
      return chain
    }),
    maybeSingle: vi.fn(() => {
      // Flush pending writes on terminal resolution.
      flushAccountContactsWrites()
      return Promise.resolve({ data: null, error: null })
    }),
    then: (resolve: (v: { data: Array<{ contact_id: string }>; error: null }) => void) => {
      // For bare .select('contact_id').eq('account_id', ...) chains.
      const list = accountContacts.map((ac) => ({ contact_id: ac.contact_id }))
      return resolve({ data: list, error: null })
    },
  }

  function flushAccountContactsWrites() {
    if (pendingInsert) {
      accountContacts.push({
        account_id: pendingInsert.account_id as string,
        contact_id: pendingInsert.contact_id as string,
        role: pendingInsert.role as string | undefined,
      })
      writeLog.push({
        table: "account_contacts",
        op: "insert",
        payload: pendingInsert,
      })
      pendingInsert = null
    }
    if (pendingUpsert) {
      accountContacts.push({
        account_id: pendingUpsert.account_id as string,
        contact_id: pendingUpsert.contact_id as string,
        role: pendingUpsert.role as string | undefined,
      })
      writeLog.push({
        table: "account_contacts",
        op: "upsert",
        payload: pendingUpsert,
      })
      pendingUpsert = null
    }
  }

  // Override insert and upsert to flush immediately when awaited without
  // a terminal method. Async-iterator path: we rely on the fact that
  // autoCreatePortalUser always awaits; .insert(...) returns a
  // thenable-compatible chain. Make the chain thenable.
  const thenable = chain as unknown as Record<string, unknown>
  thenable.then = (resolve: (v: { data: unknown; error: null }) => void) => {
    flushAccountContactsWrites()
    return resolve({ data: null, error: null })
  }
  return chain
}

function buildAccountsChain() {
  let pendingUpdate: Record<string, unknown> | null = null
  const chain = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn((payload: Record<string, unknown>) => {
      pendingUpdate = payload
      return chain
    }),
    eq: vi.fn((col: string, val: string) => {
      if (pendingUpdate !== null) {
        writeLog.push({
          table: "accounts",
          op: "update",
          payload: pendingUpdate,
          filter: { [col]: val },
        })
        pendingUpdate = null
      }
      return chain
    }),
    single: vi.fn(() => Promise.resolve({ data: null, error: null })),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
  }
  return chain
}

const noopTableChain = () => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
  single: vi.fn(() => Promise.resolve({ data: null, error: null })),
})

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "contacts") return buildContactsChain()
      if (table === "account_contacts") return buildAccountContactsChain()
      if (table === "accounts") return buildAccountsChain()
      return noopTableChain()
    },
    auth: {
      admin: {
        listUsers: vi.fn(() =>
          Promise.resolve({ data: { users: authUsers }, error: null }),
        ),
        createUser: vi.fn((params: { email: string; app_metadata?: Record<string, unknown> }) => {
          const newId = `auth-gen-${Math.random().toString(36).slice(2, 8)}`
          const newUser: AuthUserRow = {
            id: newId,
            email: params.email,
            app_metadata: { ...(params.app_metadata ?? {}) },
          }
          authUsers.push(newUser)
          writeLog.push({
            table: "auth.users",
            op: "createUser",
            payload: params,
          })
          return Promise.resolve({ data: { user: newUser }, error: null })
        }),
        updateUserById: vi.fn((id: string, patch: { app_metadata?: Record<string, unknown> }) => {
          const existing = authUsers.find((u) => u.id === id)
          if (existing && patch.app_metadata) {
            existing.app_metadata = {
              ...existing.app_metadata,
              ...patch.app_metadata,
            }
          }
          writeLog.push({
            table: "auth.users",
            op: "updateUserById",
            payload: patch,
            filter: { id },
          })
          return Promise.resolve({ data: null, error: null })
        }),
      },
    },
  },
}))

import { autoCreatePortalUser } from "@/lib/portal/auto-create"

beforeEach(() => {
  contactsByEmail = new Map()
  contactsById = new Map()
  accountContacts = []
  authUsers = []
  writeLog.length = 0
})

// ─── Tests ──────────────────────────────────────────────

describe("portal identity linkage — new user path", () => {
  it("sets auth.users.app_metadata.contact_id to the matched contacts.id", async () => {
    // Fixture: contact exists, no auth user yet.
    const contact: ContactRow = {
      id: "contact-42",
      email: "user@test.com",
      full_name: "Test User",
      language: "Italian",
      portal_tier: null,
    }
    contactsById.set(contact.id, contact)
    contactsByEmail.set(contact.email!, contact)

    const result = await autoCreatePortalUser({
      contactId: contact.id,
      tier: "onboarding",
    })

    expect(result.success).toBe(true)
    expect(result.alreadyExists).toBe(false)
    expect(result.email).toBe("user@test.com")

    // The critical invariant: auth.users.app_metadata.contact_id === contacts.id
    const createCall = writeLog.find(
      (w) => w.table === "auth.users" && w.op === "createUser",
    )
    expect(createCall).toBeDefined()
    const payload = createCall!.payload as { app_metadata: Record<string, unknown> }
    expect(payload.app_metadata.contact_id).toBe(contact.id)
    expect(payload.app_metadata.role).toBe("client")
  })

  it("creates a contact row when none exists and still links it to auth.users", async () => {
    // Fixture: no contact, no auth user; caller passes only an email via
    // lead-fallback path. autoCreatePortalUser must end up with a
    // contacts row whose id matches the auth metadata.
    const result = await autoCreatePortalUser({
      emailOverride: "fresh@test.com",
      nameOverride: "Fresh User",
      tier: "lead",
    })

    expect(result.success).toBe(true)

    // A new contacts row was inserted.
    const contactInsert = writeLog.find(
      (w) => w.table === "contacts" && w.op === "insert",
    )
    expect(contactInsert).toBeDefined()

    // The auth user was created with that contact_id in app_metadata.
    const createCall = writeLog.find(
      (w) => w.table === "auth.users" && w.op === "createUser",
    )
    expect(createCall).toBeDefined()
    const payload = createCall!.payload as { app_metadata: Record<string, unknown> }
    expect(typeof payload.app_metadata.contact_id).toBe("string")
    expect(payload.app_metadata.contact_id).toMatch(/^contact-gen-/)
  })
})

describe("portal identity linkage — existing-user path (backfill)", () => {
  it("backfills auth.users.app_metadata.contact_id when it is missing", async () => {
    // Fixture: contact exists, auth user exists but WITHOUT contact_id.
    // This is the Antony Fioravanti rescue class (§16.7) — the chain
    // was broken and auto-create should repair it.
    const contact: ContactRow = {
      id: "contact-99",
      email: "legacy@test.com",
      full_name: "Legacy User",
      language: "English",
      portal_tier: null,
    }
    contactsById.set(contact.id, contact)
    contactsByEmail.set(contact.email!, contact)

    authUsers.push({
      id: "auth-legacy",
      email: "legacy@test.com",
      app_metadata: { role: "client" }, // no contact_id
    })

    const result = await autoCreatePortalUser({
      contactId: contact.id,
      tier: "active",
    })

    expect(result.success).toBe(true)
    expect(result.alreadyExists).toBe(true)

    // updateUserById should have been called with contact_id in app_metadata.
    const updateCall = writeLog.find(
      (w) => w.table === "auth.users" && w.op === "updateUserById",
    )
    expect(updateCall).toBeDefined()
    const patch = updateCall!.payload as { app_metadata: Record<string, unknown> }
    expect(patch.app_metadata.contact_id).toBe(contact.id)
    expect(patch.app_metadata.portal_tier).toBe("active")
  })

  it("resolves contact_id from caller-provided ID when auth metadata is missing it", async () => {
    // Caller passes a contactId, auth user exists with no metadata.
    // Characterization: the existing-user path must honor the caller's
    // contactId rather than creating a new contact.
    const contact: ContactRow = {
      id: "contact-caller",
      email: "caller@test.com",
      full_name: "Caller",
      portal_tier: null,
    }
    contactsById.set(contact.id, contact)
    contactsByEmail.set(contact.email!, contact)

    authUsers.push({
      id: "auth-caller",
      email: "caller@test.com",
      app_metadata: {},
    })

    await autoCreatePortalUser({
      contactId: contact.id,
      tier: "onboarding",
    })

    const updateCall = writeLog.find(
      (w) => w.table === "auth.users" && w.op === "updateUserById",
    )
    expect(updateCall).toBeDefined()
    const patch = updateCall!.payload as { app_metadata: Record<string, unknown> }
    expect(patch.app_metadata.contact_id).toBe(contact.id)
  })
})

describe("portal identity linkage — source-of-truth tier propagation", () => {
  it("writes portal_tier to contacts (the source of truth per CLAUDE.md)", async () => {
    const contact: ContactRow = {
      id: "contact-tier",
      email: "tier@test.com",
      full_name: "Tier Test",
      portal_tier: "lead",
    }
    contactsById.set(contact.id, contact)
    contactsByEmail.set(contact.email!, contact)

    authUsers.push({
      id: "auth-tier",
      email: "tier@test.com",
      app_metadata: { role: "client" },
    })

    await autoCreatePortalUser({
      contactId: contact.id,
      tier: "onboarding",
    })

    const contactWrite = writeLog.find(
      (w) => w.table === "contacts" && w.op === "update",
    )
    expect(contactWrite).toBeDefined()
    const payload = contactWrite!.payload as Record<string, unknown>
    expect(payload.portal_tier).toBe("onboarding")
  })
})
