/**
 * P3.4 #10 — lib/operations/lease.ts unit tests
 *
 * Covers: createLease() validation / happy path / contact auto-resolve / suite
 * auto-assign / duplicate detection / account-not-found / contact-not-found /
 * db error / language derivation from contact / overrides.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let accountRow: { id: string; company_name: string; ein_number: string | null; state_of_formation: string | null; entity_type?: string | null } | null = null
let accountContactLinks: Array<{ contact_id: string; role?: string | null }> = []
let contactRow: { id: string; full_name: string; email: string | null; language: string | null } | null = null
// members table — empty by default (every existing test's account behaves
// like an SMLLC: no members rows, falls through to the account_contacts
// default pick, same as before this fix).
let membersRows: Array<{
  member_type: string
  full_name: string | null
  company_name: string | null
  contact_id: string | null
  representative_name: string | null
  representative_email: string | null
  is_primary: boolean | null
  is_signer: boolean | null
}> = []
// Extra contacts keyed by id, for tests that resolve a signer OTHER than
// contactRow (e.g. a company member's representative). contactRow itself
// stays reachable by "contact-1" so existing tests are untouched.
let extraContactsById: Record<string, { id: string; full_name: string; email: string | null; language?: string | null }> = {}
let duplicateLeases: Array<{ id: string; token: string; status: string }> = []
// The suite module (allocator / locked explicit assign / address sync) is the DATABASE's job and is
// tested against the real sandbox DB + tests/unit/operations-suite.test.ts; here they are doubles.
let allocatedSuite = "3D-151"
let companySuiteNow: string | null = null
let allocateError: string | null = null
let specificError: string | null = null
const allocateCalls: Array<Record<string, unknown>> = []
const specificCalls: Array<{ accountId: string; suite: string }> = []
const syncCalls: Array<{ accountId: string; suite: string }> = []
let insertReturnsRow: { id: string; token: string; access_code: string; suite_number: string; contract_year: number; contact_id: string } | null = null
let insertError: { message: string } | null = null

const insertCalls: Array<Record<string, unknown>> = []
const updateCalls: Array<Record<string, unknown>> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mock ────────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const filters: Record<string, string | number> = {}
      let selectCols = ""
      let pendingInsert: Record<string, unknown> | null = null
      let pendingUpdate: Record<string, unknown> | null = null
      let _limitVal: number | undefined
      let inCol: string | undefined
      let inVals: string[] = []

      Object.assign(chain, {
        select: vi.fn((cols: string) => {
          selectCols = cols
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
        eq: vi.fn((col: string, value: string | number) => {
          filters[col] = value
          return chain
        }),
        in: vi.fn((col: string, vals: string[]) => {
          inCol = col
          inVals = vals
          return chain
        }),
        not: vi.fn(() => chain),
        is: vi.fn(() => chain),
        range: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn((n: number) => {
          _limitVal = n
          return chain
        }),
        single: vi.fn(() => resolvePromise()),
        maybeSingle: vi.fn(() => resolvePromise()),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingInsert) {
          insertCalls.push({ table, payload: pendingInsert, returnSelect: selectCols })
          const data = insertError ? null : insertReturnsRow
          const result = { data, error: insertError }
          pendingInsert = null
          return result
        }
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate, filters: { ...filters } })
          pendingUpdate = null
          return { data: null, error: null }
        }
        // Read path
        if (table === "accounts") {
          return { data: accountRow, error: null }
        }
        if (table === "members") {
          return { data: membersRows, error: null }
        }
        if (table === "account_contacts") {
          return { data: accountContactLinks, error: null }
        }
        if (table === "contacts") {
          // Scoped-to-account representative-email lookup: .in("id", ids).eq("email", v)
          if (inCol === "id") {
            const candidates = inVals
              .map((id) => (id === contactRow?.id ? contactRow : extraContactsById[id]))
              .filter((c): c is NonNullable<typeof c> => !!c)
            const match = candidates.find((c) => filters.email === undefined || c.email === filters.email)
            return { data: match ?? null, error: null }
          }
          if (filters.id !== undefined) {
            if (filters.id === contactRow?.id) return { data: contactRow, error: null }
            return { data: extraContactsById[filters.id as string] ?? null, error: null }
          }
          if (filters.email !== undefined) {
            if (contactRow?.email === filters.email) return { data: contactRow, error: null }
            const found = Object.values(extraContactsById).find((c) => c.email === filters.email)
            return { data: found ?? null, error: null }
          }
          return { data: contactRow, error: null }
        }
        if (table === "lease_agreements") {
          // The duplicate check (account_id + contract_year).
          return { data: duplicateLeases, error: null }
        }
        return { data: null, error: null }
      }

      function resolvePromise() {
        return Promise.resolve(resolveValue())
      }

      return chain
    },
  },
}))

vi.mock("@/lib/operations/suite", async () => {
  const actual = await vi.importActual<typeof import("@/lib/operations/suite")>("@/lib/operations/suite")
  return {
    ...actual,
    allocateCompanySuite: vi.fn(async (opts: Record<string, unknown>) => {
      allocateCalls.push(opts)
      if (allocateError) throw new Error(allocateError)
      return allocatedSuite
    }),
    assignSpecificCompanySuite: vi.fn(async (accountId: string, suite: string) => {
      specificCalls.push({ accountId, suite })
      if (specificError) throw new Error(specificError)
      return suite
    }),
    syncPhysicalAddressToSuite: vi.fn(async (accountId: string, suite: string) => {
      syncCalls.push({ accountId, suite })
    }),
    getCompanySuite: vi.fn(async () => companySuiteNow),
  }
})

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

beforeEach(() => {
  accountRow = {
    id: "acct-1",
    company_name: "Example LLC",
    ein_number: "12-3456789",
    state_of_formation: "FL",
  }
  accountContactLinks = [{ contact_id: "contact-1" }]
  contactRow = {
    id: "contact-1",
    full_name: "Jane Doe",
    email: "jane@example.com",
    language: "en",
  }
  membersRows = []
  extraContactsById = {}
  duplicateLeases = []
  allocatedSuite = "3D-151"
  companySuiteNow = "3D-151" // the company already holds its suite (a lease never issues one by default)
  allocateError = null
  specificError = null
  allocateCalls.length = 0
  specificCalls.length = 0
  syncCalls.length = 0
  insertReturnsRow = {
    id: "lease-1",
    token: "example-llc-2026",
    access_code: "abc123",
    suite_number: "3D-151",
    contract_year: 2026,
    contact_id: "contact-1",
  }
  insertError = null
  insertCalls.length = 0
  updateCalls.length = 0
  actionLogCalls.length = 0
})

// ─── validation ──────────────────────────────────────────

describe("createLease — validation", () => {
  it("returns error when account_id is missing", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("account_id")
  })
})

// ─── not_found paths ─────────────────────────────────────

describe("createLease — not_found paths", () => {
  it("returns not_found when account does not exist", async () => {
    accountRow = null
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "missing" })
    expect(result.outcome).toBe("not_found")
    expect(result.error).toContain("Account")
  })

  it("returns not_found when account has no linked contact", async () => {
    accountContactLinks = []
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1" })
    expect(result.outcome).toBe("not_found")
    expect(result.error).toContain("No contact linked")
  })

  it("returns not_found when provided contact_id does not exist", async () => {
    contactRow = null
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", contact_id: "missing-contact" })
    expect(result.outcome).toBe("not_found")
    expect(result.error).toContain("Contact")
  })
})

// ─── Multi-Member LLC signer resolution (dev job 9ad76300-6181-4250-a1de-c77f37933f82) ──
//
// createLease() used to resolve the tenant contact via an UNORDERED
// account_contacts.limit(1) pick — no reference to the members table at
// all. On Prowave LLC this named the 99% company member's representative
// (Marco Pasetto) instead of the flagged 1% individual signer (Matteo
// Mangili). These tests reproduce that exact shape through the real
// createLease() call, not just the underlying resolver in isolation.

describe("createLease — Multi-Member LLC signer resolution", () => {
  beforeEach(() => {
    // Every test in this block is a Multi-Member LLC — the classification
    // itself (entity_type reaching the resolver) is part of what's under
    // test, not incidental setup.
    accountRow = { ...accountRow!, entity_type: "Multi Member LLC" }
  })

  it("THE PROWAVE CASE — picks the flagged members-table signer, not the first account_contacts row", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Matteo Mangili", company_name: null, contact_id: "matteo-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "company", full_name: null, company_name: "Indaco LTD", contact_id: "marco-id", representative_name: "Marco Pasetto", representative_email: "info@sheltax.com", is_primary: false, is_signer: false },
    ]
    // account_contacts row order puts Marco FIRST — exactly what the old
    // unordered .limit(1) pick would have returned.
    accountContactLinks = [
      { contact_id: "marco-id" },
      { contact_id: "matteo-id" },
    ]
    extraContactsById = {
      "marco-id": { id: "marco-id", full_name: "Marco Pasetto", email: "info@sheltax.com" },
      "matteo-id": { id: "matteo-id", full_name: "Matteo Mangili", email: "info@matteomangili.com" },
    }
    insertReturnsRow = { id: "lease-1", token: "prowave-llc-2026", access_code: "abc123", suite_number: "3D-151", contract_year: 2026, contact_id: "matteo-id" }

    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", contract_year: 2026 })
    expect(result.success).toBe(true)
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.contact_id).toBe("matteo-id")
    expect(insert.tenant_contact_name).toBe("Matteo Mangili")
    expect(insert.tenant_email).toBe("info@matteomangili.com")
  })

  it("a Multi-Member LLC with zero flagged signers refuses to guess", async () => {
    membersRows = [
      { member_type: "individual", full_name: "A", company_name: null, contact_id: "a-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
      { member_type: "individual", full_name: "B", company_name: null, contact_id: "b-id", representative_name: null, representative_email: null, is_primary: false, is_signer: false },
    ]
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Flag exactly one member")
    expect(insertCalls.length).toBe(0)
  })

  it("a Multi-Member LLC with two flagged signers refuses to guess", async () => {
    membersRows = [
      { member_type: "individual", full_name: "A", company_name: null, contact_id: "a-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
      { member_type: "individual", full_name: "B", company_name: null, contact_id: "b-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
    ]
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1" })
    expect(result.success).toBe(false)
    expect(insertCalls.length).toBe(0)
  })

  it("an explicit contact_id still wins over the members-table resolver", async () => {
    membersRows = [
      { member_type: "individual", full_name: "Matteo Mangili", company_name: null, contact_id: "matteo-id", representative_name: null, representative_email: null, is_primary: true, is_signer: true },
    ]
    extraContactsById = { "override-id": { id: "override-id", full_name: "Staff Override", email: "staff@example.com" } }
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", contact_id: "override-id" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.contact_id).toBe("override-id")
  })
})

// ─── duplicate check ─────────────────────────────────────

describe("createLease — duplicate check", () => {
  it("returns duplicate with existing lease details", async () => {
    duplicateLeases = [{ id: "lease-0", token: "example-llc-2026", status: "sent" }]
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", contract_year: 2026 })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate")
    expect(result.existing).toEqual({ id: "lease-0", token: "example-llc-2026", status: "sent" })
  })

  it("bypasses the code-side duplicate check when skip_duplicate_check=true", async () => {
    // This asserts skip bypasses the SELECT pre-check only. In real prod/sandbox
    // the unique index uq_lease_account_year_tenant still enforces one lease per
    // (account, year, tenant) — so if the prior row still exists the INSERT
    // raises 23505 and createLease returns outcome "duplicate" instead. The mock
    // has no index, so it reaches "created" here. Remove the prior row first to
    // actually re-generate a same-year lease.
    duplicateLeases = [{ id: "lease-0", token: "example-llc-2026", status: "sent" }]
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", skip_duplicate_check: true })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
  })
})

// ─── happy path ──────────────────────────────────────────

describe("createLease — happy path", () => {
  it("creates a lease with defaults + logs action", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({
      account_id: "acct-1",
      actor: "claude.ai",
      contract_year: 2026,
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
    expect(result.lease?.token).toBe("example-llc-2026")

    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.account_id).toBe("acct-1")
    expect(insert.contact_id).toBe("contact-1")
    expect(insert.tenant_company).toBe("Example LLC")
    expect(insert.tenant_ein).toBe("12-3456789")
    expect(insert.tenant_state).toBe("FL")
    expect(insert.monthly_rent).toBe(100)
    expect(insert.yearly_rent).toBe(1200)
    expect(insert.security_deposit).toBe(150)
    expect(insert.square_feet).toBe(120)
    expect(insert.term_months).toBe(12)
    expect(insert.premises_address).toBe("10225 Ulmerton Rd, Largo, FL 33771")
    expect(insert.status).toBe("draft")
    expect(insert.suite_number).toBe("3D-151") // 150 + 1

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].actor).toBe("claude.ai")
    expect(actionLogCalls[0].action_type).toBe("create")
    expect(actionLogCalls[0].table_name).toBe("lease_agreements")
    expect(actionLogCalls[0].account_id).toBe("acct-1")
  })

  it("uses provided contact_id instead of looking up primary", async () => {
    contactRow = {
      id: "contact-xyz",
      full_name: "Override Contact",
      email: "override@example.com",
      language: "en",
    }
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", contact_id: "contact-xyz" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.contact_id).toBe("contact-xyz")
    expect(insert.tenant_contact_name).toBe("Override Contact")
  })

  it("uses the company's OWN suite (never picked by the lease, never issued by default)", async () => {
    companySuiteNow = "3D-330"
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-330")
    expect(allocateCalls).toHaveLength(0)
    expect(specificCalls).toHaveLength(0)
  })

  it("only an explicit issue_suite_if_missing:true asks the allocator for a suite", async () => {
    companySuiteNow = null
    allocatedSuite = "3D-330"
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", issue_suite_if_missing: true })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-330")
    expect(allocateCalls).toHaveLength(1)
    expect(allocateCalls[0].accountId).toBe("acct-1")
  })

  it("a renewal gets the SAME suite again (the company's own suite)", async () => {
    companySuiteNow = "3D-140"
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", contract_year: 2027 })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-140")
    expect(syncCalls).toEqual([{ accountId: "acct-1", suite: "3D-140" }])
  })

  it("an explicit suite (Place Client, existing client) goes through the LOCKED assign — the allocator is not used", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", suite_number: "3d 999" })
    expect(specificCalls).toEqual([{ accountId: "acct-1", suite: "3D-999" }])
    expect(allocateCalls).toHaveLength(0)
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-999")
  })

  it("refuses an explicit suite that is not shaped like 3D-NNN — no lease is written", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", suite_number: "318" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("not a valid suite")
    expect(insertCalls).toHaveLength(0)
  })

  it("the database refusing an explicit suite (another company's, or a different one than the company holds) stops the lease", async () => {
    specificError = "Suite 3D-999 already belongs to another company"
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", suite_number: "3D-999" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("already belongs to another company")
    expect(insertCalls).toHaveLength(0)
  })

  it("by DEFAULT a lease never issues a suite: with none (waived / not issued) it stops with a clear message and writes no lease", async () => {
    companySuiteNow = null
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no suite yet/i)
    expect(allocateCalls).toHaveLength(0)
    expect(insertCalls).toHaveLength(0)
  })

  it("an AUTOMATIC job uses the company's suite when it already has one (never issues)", async () => {
    companySuiteNow = "3D-222"
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", issue_suite_if_missing: false })
    expect(result.success).toBe(true)
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-222")
    expect(allocateCalls).toHaveLength(0)
  })

  it("an allocator failure stops the lease — never a lease with a missing or guessed suite", async () => {
    companySuiteNow = null
    allocateError = "Could not issue a suite: connection reset"
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1", issue_suite_if_missing: true })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Could not issue a suite")
    expect(insertCalls).toHaveLength(0)
  })

  it("derives language='it' from contact.language", async () => {
    contactRow = {
      id: "contact-1",
      full_name: "Marco Rossi",
      email: "marco@example.it",
      language: "Italian",
    }
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.language).toBe("it")
  })

  it("honors explicit language override", async () => {
    contactRow = {
      id: "contact-1",
      full_name: "Marco Rossi",
      email: "marco@example.it",
      language: "Italian",
    }
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", language: "en" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.language).toBe("en")
  })

  it("computes yearly_rent from monthly_rent when not supplied", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", monthly_rent: 250 })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.monthly_rent).toBe(250)
    expect(insert.yearly_rent).toBe(3000)
  })

  it("honors explicit yearly_rent override", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", monthly_rent: 100, yearly_rent: 999 })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.yearly_rent).toBe(999)
  })

  it("defaults tenant_title to 'Manager'", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.tenant_title).toBe("Manager")
  })

  it("honors explicit tenant_title override", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", tenant_title: "Member" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.tenant_title).toBe("Member")
  })

  it("defaults term_end_date to {contract_year}-12-31", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", contract_year: 2027 })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.term_end_date).toBe("2027-12-31")
    expect(insert.contract_year).toBe(2027)
  })

  it("uses explicit summary + details when provided", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({
      account_id: "acct-1",
      summary: "Auto-created during onboarding",
      details: { trigger: "wizard_submit", step: 8 },
    })
    expect(actionLogCalls[0].summary).toBe("Auto-created during onboarding")
    expect(actionLogCalls[0].details).toEqual({ trigger: "wizard_submit", step: 8 })
  })

  it("builds token from company_name slug + contract year", async () => {
    accountRow = {
      id: "acct-2",
      company_name: "Acme & Co, LLC",
      ein_number: null,
      state_of_formation: "DE",
    }
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-2", contract_year: 2026 })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.token).toBe("acme-co-llc-2026")
  })

  it("keeps the address the Operating Agreement prints in step with the company's suite", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    expect(syncCalls).toEqual([{ accountId: "acct-1", suite: "3D-151" }])
  })
})

// ─── db error ────────────────────────────────────────────

describe("createLease — db error", () => {
  it("surfaces the insert error", async () => {
    insertError = { message: "duplicate key violates constraint" }
    insertReturnsRow = null
    const { createLease } = await import("@/lib/operations/lease")
    const result = await createLease({ account_id: "acct-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toContain("duplicate key")
  })
})

describe("suiteNumericPart", () => {
  it("reads 3D-NNN and rejects everything else", async () => {
    const { suiteNumericPart } = await import("@/lib/operations/lease")
    expect(suiteNumericPart("3D-318")).toBe(318)
    expect(suiteNumericPart(" 3d-1000 ")).toBe(1000)
    expect(suiteNumericPart("Suite 3D-318")).toBeNull()
    expect(suiteNumericPart("3D")).toBeNull()
    expect(suiteNumericPart(null)).toBeNull()
  })
})

describe("normalizeSuiteNumber", () => {
  it("normalises what staff type into 3D-NNN", async () => {
    const { normalizeSuiteNumber } = await import("@/lib/operations/lease")
    expect(normalizeSuiteNumber("3D-318")).toBe("3D-318")
    expect(normalizeSuiteNumber("3d318")).toBe("3D-318")
    expect(normalizeSuiteNumber(" Suite 3D-318 ")).toBe("3D-318")
    expect(normalizeSuiteNumber("3D 205")).toBe("3D-205")
    expect(normalizeSuiteNumber("3D-0318")).toBe("3D-318") // leading zero stripped: same number, same string
  })
  it("rejects anything that is not a numbered TD suite", async () => {
    const { normalizeSuiteNumber } = await import("@/lib/operations/lease")
    expect(normalizeSuiteNumber("")).toBeNull()
    expect(normalizeSuiteNumber("3D")).toBeNull()
    expect(normalizeSuiteNumber("Suite 104-153")).toBeNull()
    expect(normalizeSuiteNumber("3D-1")).toBeNull()
    expect(normalizeSuiteNumber(null)).toBeNull()
  })
})
