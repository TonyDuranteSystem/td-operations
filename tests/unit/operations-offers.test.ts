/**
 * P3.4 #6 — lib/operations/offers.ts unit tests
 *
 * Covers createOffer(): validation, not-found, duplicate detection, token
 * auto-generation, referrer auto-fill from lead, currency auto-detection,
 * Whop auto-plan gating, action_log write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

interface LeadFixture {
  id: string
  referrer_name: string | null
  referrer_partner_id: string | null
}

// ─── Mock state ──────────────────────────────────────────

let leadFixture: LeadFixture | null = null
let accountExists = true
let duplicateOffer: { token: string; status: string } | null = null
let tokenCollision = false
let insertSucceeds = true

const offerInserts: Array<Record<string, unknown>> = []
const leadUpdates: Array<Record<string, unknown>> = []
const actionLogCalls: Array<Record<string, unknown>> = []
const whopCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "leads") {
        const chain: Record<string, unknown> = {}
        let pendingUpdate: Record<string, unknown> | null = null
        Object.assign(chain, {
          select: vi.fn().mockReturnValue(chain),
          update: vi.fn((payload: Record<string, unknown>) => {
            pendingUpdate = payload
            return chain
          }),
          eq: vi.fn((_col: string, id: string) => {
            if (pendingUpdate) {
              leadUpdates.push({ id, ...pendingUpdate })
              pendingUpdate = null
            }
            return chain
          }),
          maybeSingle: vi.fn(() => Promise.resolve({ data: leadFixture, error: null })),
          single: vi.fn(() => Promise.resolve({ data: leadFixture, error: null })),
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        })
        return chain
      }
      if (table === "accounts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() =>
            Promise.resolve({
              data: accountExists ? { id: "acct-1" } : null,
              error: accountExists ? null : null,
            })
          ),
        }
      }
      if (table === "offers") {
        const chain: Record<string, unknown> = {}
        let pendingInsert: Record<string, unknown> | null = null
        let pendingUpdate: Record<string, unknown> | null = null
        let isTokenCheck = false
        let isDupCheck = false
        let updateTokenFilter: string | null = null
        Object.assign(chain, {
          select: vi.fn((cols: string) => {
            // generateUniqueToken selects just "token" by exact match on token.
            // Duplicate check selects "token, status" filtered by lead/account.
            if (cols === "token") isTokenCheck = true
            else if (cols === "token, status") isDupCheck = true
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
          eq: vi.fn((col: string, value: string) => {
            if (pendingUpdate) {
              updateTokenFilter = col === "token" ? value : updateTokenFilter
              offerInserts.push({
                __update: true,
                token: updateTokenFilter,
                ...pendingUpdate,
              })
              pendingUpdate = null
            }
            return chain
          }),
          not: vi.fn(() => chain),
          limit: vi.fn(() => chain),
          single: vi.fn(() => {
            if (pendingInsert) {
              offerInserts.push(pendingInsert)
              const row = {
                token: (pendingInsert.token as string) || "generated-token",
                access_code: "abc12345",
                status: "draft",
              }
              pendingInsert = null
              return Promise.resolve({
                data: insertSucceeds ? row : null,
                error: insertSucceeds ? null : { message: "insert failed" },
              })
            }
            return Promise.resolve({ data: null, error: null })
          }),
          maybeSingle: vi.fn(() => {
            if (isDupCheck) {
              isDupCheck = false
              return Promise.resolve({ data: duplicateOffer, error: null })
            }
            if (isTokenCheck) {
              isTokenCheck = false
              return Promise.resolve({
                data: tokenCollision ? { token: "collision" } : null,
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          }),
        })
        return chain
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    },
  },
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

vi.mock("@/lib/config", () => ({
  APP_BASE_URL: "https://app.tonydurante.us",
}))

vi.mock("@/app/offer/[token]/contract/bank-defaults", () => ({
  getBankDetailsByPreference: (pref: string, currency: string) => ({
    beneficiary: "Tony Durante LLC",
    iban: currency === "EUR" ? "DK8989000023658198" : "200000306770",
    preference: pref,
    currency,
  }),
}))

vi.mock("@/lib/whop-auto-plan", () => ({
  createWhopPlan: vi.fn(async (opts: Record<string, unknown>) => {
    whopCalls.push(opts)
    return { success: true, checkoutUrl: "https://whop.example/checkout/123" }
  }),
}))

// ─── Reset ───────────────────────────────────────────────

beforeEach(() => {
  leadFixture = null
  accountExists = true
  duplicateOffer = null
  tokenCollision = false
  insertSucceeds = true
  offerInserts.length = 0
  leadUpdates.length = 0
  actionLogCalls.length = 0
  whopCalls.length = 0
})

// ─── Tests ───────────────────────────────────────────────

describe("createOffer — validation", () => {
  it("returns validation_error when services is missing", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Test Client",
      language: "en",
      payment_type: "bank_transfer",
      services: null,
      cost_summary: [{ label: "Total", total: "$100" }],
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("validation_error")
    expect(result.error).toContain("services")
  })

  it("returns validation_error when cost_summary is missing", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Test",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: null,
    })
    expect(result.outcome).toBe("validation_error")
  })

  it("returns validation_error on malformed service", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Test",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "Missing price" }],
      cost_summary: [{ label: "Total" }],
    })
    expect(result.outcome).toBe("validation_error")
    expect(result.error).toContain("services")
  })
})

describe("createOffer — existence checks", () => {
  it("returns not_found when account_id does not exist", async () => {
    accountExists = false
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Test",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      account_id: "nonexistent-account",
    })
    expect(result.outcome).toBe("not_found")
  })
})

describe("createOffer — duplicate detection", () => {
  it("blocks when an active offer already exists for the lead", async () => {
    leadFixture = { id: "lead-1", referrer_name: null, referrer_partner_id: null }
    duplicateOffer = { token: "existing-offer-2026", status: "draft" }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Test",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      lead_id: "lead-1",
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate_blocked")
    expect(result.duplicate?.token).toBe("existing-offer-2026")
    expect(offerInserts.filter((o) => !o.__update).length).toBe(0)
  })
})

describe("createOffer — successful creation", () => {
  it("creates an offer with auto-generated token and returns offer_url", async () => {
    leadFixture = { id: "lead-1", referrer_name: null, referrer_partner_id: null }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario Rossi",
      client_email: "mario@example.com",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "Formation", price: "$500" }],
      cost_summary: [{ label: "Total", total: "$500" }],
      lead_id: "lead-1",
    })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("created")
    expect(result.token).toMatch(/^mario-rossi-\d{4}/)
    expect(result.offer_url).toContain("app.tonydurante.us/offer/")
    expect(result.access_code).toBe("abc12345")
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.client_name).toBe("Mario Rossi")
    expect(insert?.status).toBe("draft")
    expect(leadUpdates[0]).toEqual(
      expect.objectContaining({ id: "lead-1", offer_status: "Draft" })
    )
  })

  it("uses provided token when supplied", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario Rossi",
      language: "en",
      payment_type: "bank_transfer",
      token: "custom-token-2026",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
    })
    expect(result.token).toBe("custom-token-2026")
  })

  it("appends collision suffix when auto-generated token is taken", async () => {
    tokenCollision = true
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario Rossi",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
    })
    expect(result.token).toMatch(/^mario-rossi-\d{4}-[a-z0-9]{4}/)
  })
})

describe("createOffer — referrer auto-fill", () => {
  it("fills referrer from lead when no referrer_name supplied and lead has referrer_partner_id", async () => {
    leadFixture = {
      id: "lead-1",
      referrer_name: "Partner X",
      referrer_partner_id: "partner-acct-99",
    }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      lead_id: "lead-1",
    })
    expect(result.referrer_auto_filled).toBe(true)
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.referrer_name).toBe("Partner X")
    expect(insert?.referrer_type).toBe("partner")
    expect(insert?.referrer_account_id).toBe("partner-acct-99")
  })

  it("fills referrer as 'client' with 10% credit_note when lead has referrer but no partner_id", async () => {
    leadFixture = {
      id: "lead-1",
      referrer_name: "Client Y",
      referrer_partner_id: null,
    }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      lead_id: "lead-1",
    })
    expect(result.referrer_auto_filled).toBe(true)
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.referrer_type).toBe("client")
    expect(insert?.referrer_commission_type).toBe("credit_note")
    expect(insert?.referrer_commission_pct).toBe(10)
  })

  it("does not overwrite when caller provides referrer_name", async () => {
    leadFixture = {
      id: "lead-1",
      referrer_name: "Lead Referrer",
      referrer_partner_id: null,
    }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      lead_id: "lead-1",
      referrer_name: "Explicit Referrer",
    })
    expect(result.referrer_auto_filled).toBe(false)
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.referrer_name).toBe("Explicit Referrer")
  })

  it("skips auto-fill when auto_fill_referrer_from_lead is false", async () => {
    leadFixture = {
      id: "lead-1",
      referrer_name: "Partner X",
      referrer_partner_id: "p",
    }
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      lead_id: "lead-1",
      auto_fill_referrer_from_lead: false,
    })
    expect(result.referrer_auto_filled).toBe(false)
  })
})

describe("createOffer — currency detection", () => {
  it("auto-detects EUR from cost_summary total", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "it",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "\u20ac100" }],
      cost_summary: [{ label: "Total", total: "\u20ac100" }],
    })
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.currency).toBe("EUR")
    const bank = insert?.bank_details as { currency: string }
    expect(bank.currency).toBe("EUR")
  })

  it("defaults to USD when no EUR marker", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
    })
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.currency).toBe("USD")
  })

  it("respects explicit currency override", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      currency: "EUR",
    })
    const insert = offerInserts.find((o) => !o.__update)
    expect(insert?.currency).toBe("EUR")
  })
})

describe("createOffer — Whop auto-plan", () => {
  it("skips Whop plan unless payment_gateway=whop AND payment_type=checkout", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      payment_gateway: "whop",
    })
    expect(whopCalls.length).toBe(0)
  })

  it("creates Whop plan when gateway=whop + payment_type=checkout", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    const result = await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "checkout",
      payment_gateway: "whop",
      services: [{ name: "Formation", price: "$500" }],
      cost_summary: [{ label: "Total", total: "$500" }],
    })
    expect(whopCalls.length).toBe(1)
    expect(result.whop_checkout_url).toBe("https://whop.example/checkout/123")
  })
})

describe("createOffer — action_log", () => {
  it("writes an action_log entry on success", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      source: "crm-button",
    })
    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].action_type).toBe("create")
    expect(actionLogCalls[0].table_name).toBe("offers")
    expect(actionLogCalls[0].actor).toBe("crm-admin")
  })

  it("uses claude.ai as actor when source=mcp-claude", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      client_name: "Mario",
      language: "en",
      payment_type: "bank_transfer",
      services: [{ name: "X", price: "$100" }],
      cost_summary: [{ label: "Total", total: "$100" }],
      source: "mcp-claude",
    })
    expect(actionLogCalls[0].actor).toBe("claude.ai")
  })
})

describe("createOffer — entity_type normalization (MMLLC build)", () => {
  const baseParams = {
    client_name: "Mario Rossi",
    language: "en" as const,
    payment_type: "bank_transfer" as const,
    services: [{ name: "Formation", price: "$500" }],
    cost_summary: [{ label: "Total", total: "$500" }],
  }

  it("normalizes short code 'MMLLC' to 'Multi Member LLC' on insert", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({ ...baseParams, token: "test-mmllc-short", entity_type: "MMLLC" })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-mmllc-short")
    expect(insert?.entity_type).toBe("Multi Member LLC")
  })

  it("normalizes short code 'SMLLC' to 'Single Member LLC' on insert", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({ ...baseParams, token: "test-smllc-short", entity_type: "SMLLC" })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-smllc-short")
    expect(insert?.entity_type).toBe("Single Member LLC")
  })

  it("normalizes short code 'Corp' to 'C-Corp Elected' on insert", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({ ...baseParams, token: "test-corp-short", entity_type: "Corp" })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-corp-short")
    expect(insert?.entity_type).toBe("C-Corp Elected")
  })

  it("passes full DB enum value through unchanged", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({ ...baseParams, token: "test-mmllc-full", entity_type: "Multi Member LLC" })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-mmllc-full")
    expect(insert?.entity_type).toBe("Multi Member LLC")
  })

  it("writes null when entity_type is omitted", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({ ...baseParams, token: "test-no-entity" })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-no-entity")
    expect(insert?.entity_type).toBeNull()
  })

  it("writes null when entity_type value is unrecognized", async () => {
    const { createOffer } = await import("@/lib/operations/offers")
    await createOffer({
      ...baseParams,
      token: "test-bad-entity",
      // @ts-expect-error — intentionally passing unsupported value to prove it gets nulled
      entity_type: "LLP",
    })
    const insert = offerInserts.find((o) => !o.__update && o.token === "test-bad-entity")
    expect(insert?.entity_type).toBeNull()
  })
})
