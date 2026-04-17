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

let accountRow: { id: string; company_name: string; ein_number: string | null; state_of_formation: string | null } | null = null
let accountContactLinks: Array<{ contact_id: string }> = []
let contactRow: { id: string; full_name: string; email: string | null; language: string | null } | null = null
let duplicateLeases: Array<{ id: string; token: string; status: string }> = []
let lastSuiteLeases: Array<{ suite_number: string }> = []
let insertReturnsRow: { id: string; token: string; access_code: string; suite_number: string; contract_year: number; contact_id: string } | null = null
let insertError: { message: string } | null = null

const insertCalls: Array<Record<string, unknown>> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mock ────────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const filters: Record<string, string | number> = {}
      let selectCols = ""
      let pendingInsert: Record<string, unknown> | null = null
      let orderCol: string | undefined
      let orderAsc = true
      let _limitVal: number | undefined

      Object.assign(chain, {
        select: vi.fn((cols: string) => {
          selectCols = cols
          return chain
        }),
        insert: vi.fn((payload: Record<string, unknown>) => {
          pendingInsert = payload
          return chain
        }),
        eq: vi.fn((col: string, value: string | number) => {
          filters[col] = value
          return chain
        }),
        order: vi.fn((col: string, opts?: { ascending?: boolean }) => {
          orderCol = col
          orderAsc = opts?.ascending ?? true
          return chain
        }),
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
        // Read path
        if (table === "accounts") {
          return { data: accountRow, error: null }
        }
        if (table === "account_contacts") {
          return { data: accountContactLinks, error: null }
        }
        if (table === "contacts") {
          return { data: contactRow, error: null }
        }
        if (table === "lease_agreements") {
          if (orderCol === "suite_number" && !orderAsc) {
            return { data: lastSuiteLeases, error: null }
          }
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
  duplicateLeases = []
  lastSuiteLeases = [{ suite_number: "3D-150" }]
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

  it("bypasses duplicate check when skip_duplicate_check=true", async () => {
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

  it("auto-assigns 3D-101 when no leases exist", async () => {
    lastSuiteLeases = []
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-101")
  })

  it("auto-assigns next suite number based on last lease", async () => {
    lastSuiteLeases = [{ suite_number: "3D-207" }]
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-208")
  })

  it("uses explicit suite_number when provided", async () => {
    const { createLease } = await import("@/lib/operations/lease")
    await createLease({ account_id: "acct-1", suite_number: "3D-999" })
    const insert = insertCalls[0].payload as Record<string, unknown>
    expect(insert.suite_number).toBe("3D-999")
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
