/**
 * Unit tests for `applyOnboardingAccountUpgrades` — the helper that flips
 * account_type One-Time → Client and propagates setup_fee + installment
 * amounts from the offer to the account columns when an existing-account
 * onboarding offer is paid.
 *
 * Strategy: mock supabaseAdmin per-table. Capture the `accounts.update` patch
 * and the `action_log.insert` row. Vary the fixture to cover every branch:
 *   - happy path (One-Time + recurring → Client + 3 columns written)
 *   - setup-fee-only (no recurring → stays One-Time, only setup_fee written)
 *   - already Client (no flip, columns still propagated if null)
 *   - all columns already populated (no-op patch)
 *   - parse failure on one installment (write the parseable one, note the failure)
 *   - mixed currency (€ setup fee + $ installments — both saved with their currencies)
 *   - non-onboarding contract_type (early return)
 *   - account read failure (graceful skip with note)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ── supabaseAdmin mock — captures writes and serves the account fixture ───────

type AccountFixture = {
  id: string
  account_type: string | null
  setup_fee_amount: number | null
  setup_fee_currency: string | null
  installment_1_amount: number | null
  installment_1_currency: string | null
  installment_2_amount: number | null
  installment_2_currency: string | null
}

let accountFixture: AccountFixture | null = null
let accountReadError: { message: string } | null = null
let accountUpdatePatch: Record<string, unknown> | null = null
let accountUpdateError: { message: string } | null = null
let actionLogRow: Record<string, unknown> | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        const chain: Record<string, unknown> = {}
        const noop = () => chain
        chain.select = noop
        chain.eq = noop
        chain.single = () => Promise.resolve({ data: accountFixture, error: accountReadError })
        chain.update = (patch: Record<string, unknown>) => {
          accountUpdatePatch = patch
          return {
            eq: () =>
              accountUpdateError
                ? Promise.resolve({ data: null, error: accountUpdateError })
                : Promise.resolve({ data: null, error: null }),
          }
        }
        return chain
      }
      if (table === "action_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            actionLogRow = row
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      // Default no-op for any unexpected table touch.
      const stub: Record<string, unknown> = {}
      const noop = () => stub
      stub.select = noop
      stub.eq = noop
      stub.single = () => Promise.resolve({ data: null, error: null })
      stub.insert = () => Promise.resolve({ data: null, error: null })
      stub.update = () => ({ eq: () => Promise.resolve({ data: null, error: null }) })
      return stub
    },
  },
}))

// dbWriteSafe is a thin wrapper — mock it to call through to the underlying
// supabaseAdmin chain so our captures still fire, returning the same shape.
vi.mock("@/lib/db", () => ({
  dbWriteSafe: async (promise: Promise<{ data: unknown; error: { message: string } | null }>, _label: string) => {
    const res = await promise
    return { data: res.data, error: res.error?.message ?? null }
  },
}))

import {
  applyOnboardingAccountUpgrades,
  parsePrice,
  findInstallment,
  findSetupFeeSection,
} from "@/lib/operations/onboarding-account-upgrade"

beforeEach(() => {
  accountFixture = null
  accountReadError = null
  accountUpdatePatch = null
  accountUpdateError = null
  actionLogRow = null
})

// ── Pure parser tests ───────────────────────────────────────────────────────

describe("parsePrice", () => {
  it("parses USD with $ symbol and comma thousands", () => {
    expect(parsePrice("$1,500")).toEqual({ amount: 1500, currency: "USD" })
  })
  it("parses EUR with € symbol", () => {
    expect(parsePrice("€3,800")).toEqual({ amount: 3800, currency: "EUR" })
  })
  it("parses USD when only USD substring is present", () => {
    expect(parsePrice("USD 2,500")).toEqual({ amount: 2500, currency: "USD" })
  })
  it("defaults to USD when no symbol or ISO code", () => {
    expect(parsePrice("1000")).toEqual({ amount: 1000, currency: "USD" })
  })
  it("returns null on empty / nonsense input", () => {
    expect(parsePrice(null)).toBeNull()
    expect(parsePrice("")).toBeNull()
    expect(parsePrice("included")).toBeNull()
    expect(parsePrice("$0")).toBeNull()
  })
})

describe("findInstallment", () => {
  const rows = [
    { label: "1st Installment (January)", price: "$1000", currency: "USD" },
    { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
    { label: "Annual Total", price: "$2,000", currency: "USD" },
  ]
  it("finds January installment, skips Annual Total", () => {
    expect(findInstallment(rows, "jan")?.label).toBe("1st Installment (January)")
  })
  it("finds June installment", () => {
    expect(findInstallment(rows, "jun")?.label).toBe("2nd Installment (June)")
  })
  it("returns null on empty", () => {
    expect(findInstallment([], "jan")).toBeNull()
    expect(findInstallment(null, "jan")).toBeNull()
  })
  it("matches Italian labels (genn/giugno)", () => {
    const it = [
      { label: "Prima Rata (Gennaio)", price: "€1500" },
      { label: "Seconda Rata (Giugno)", price: "€1500" },
    ]
    expect(findInstallment(it, "jan")?.label).toContain("Gennaio")
    expect(findInstallment(it, "jun")?.label).toContain("Giugno")
  })
})

describe("findSetupFeeSection", () => {
  it("finds the Setup Fee section by label", () => {
    const rows = [{ label: "Setup Fee", total: "$1,500" }]
    expect(findSetupFeeSection(rows)?.total).toBe("$1,500")
  })
  it("falls back to first section when no Setup Fee label", () => {
    const rows = [{ label: "Total Cost", total: "$2,000" }]
    expect(findSetupFeeSection(rows)?.total).toBe("$2,000")
  })
})

// ── Helper for building a complete account fixture with overrides ──────────

function makeAccount(overrides: Partial<AccountFixture> = {}): AccountFixture {
  return {
    id: "acc-1",
    account_type: "One-Time",
    setup_fee_amount: null,
    setup_fee_currency: null,
    installment_1_amount: null,
    installment_1_currency: null,
    installment_2_amount: null,
    installment_2_currency: null,
    ...overrides,
  }
}

// ── Integration-style branch tests ──────────────────────────────────────────

describe("applyOnboardingAccountUpgrades", () => {
  it("happy path: One-Time + recurring → flips to Client and writes all three columns", async () => {
    accountFixture = makeAccount()
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$3,800" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
          { label: "Annual Total", price: "$2,000", currency: "USD" },
        ],
      },
    })

    expect(result.applied).toBe(true)
    expect(result.account_type_flipped).toBe(true)
    expect(result.account_type_after).toBe("Client")
    expect(result.setup_fee_written).toEqual({ amount: 3800, currency: "USD" })
    expect(result.installment_1_written).toEqual({ amount: 1000, currency: "USD" })
    expect(result.installment_2_written).toEqual({ amount: 1000, currency: "USD" })

    expect(accountUpdatePatch).toMatchObject({
      account_type: "Client",
      setup_fee_amount: 3800,
      setup_fee_currency: "USD",
      installment_1_amount: 1000,
      installment_1_currency: "USD",
      installment_2_amount: 1000,
      installment_2_currency: "USD",
    })

    expect(actionLogRow).not.toBeNull()
    expect((actionLogRow as { action_type: string }).action_type).toBe("onboarding_account_upgrade")
  })

  it("setup-fee-only offer: no recurring → stays One-Time, only setup_fee written", async () => {
    accountFixture = makeAccount()
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [], // explicitly empty — pure one-shot
      },
    })

    expect(result.account_type_flipped).toBe(false)
    expect(result.account_type_after).toBe("One-Time")
    expect(result.setup_fee_written).toEqual({ amount: 500, currency: "USD" })
    expect(result.installment_1_written).toBeNull()
    expect(result.installment_2_written).toBeNull()

    // Patch contains setup fee but NOT account_type
    expect(accountUpdatePatch?.account_type).toBeUndefined()
    expect(accountUpdatePatch?.setup_fee_amount).toBe(500)
  })

  it("already Client: no flip, columns still propagated when null", async () => {
    accountFixture = makeAccount({ account_type: "Client" })
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$1000" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1250", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1250", currency: "USD" },
        ],
      },
    })

    expect(result.account_type_flipped).toBe(false)
    expect(result.account_type_after).toBe("Client")
    expect(result.account_type_before).toBe("Client")
    // columns still written because they were null
    expect(result.installment_1_written).toEqual({ amount: 1250, currency: "USD" })
    expect(accountUpdatePatch?.account_type).toBeUndefined()
    expect(accountUpdatePatch?.installment_1_amount).toBe(1250)
  })

  it("all columns already populated: no overwrite, idempotent re-run", async () => {
    accountFixture = makeAccount({
      account_type: "Client",
      setup_fee_amount: 9999,
      setup_fee_currency: "EUR",
      installment_1_amount: 999,
      installment_1_currency: "EUR",
      installment_2_amount: 888,
      installment_2_currency: "EUR",
    })
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$1,000" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
        ],
      },
    })

    expect(result.account_type_flipped).toBe(false)
    expect(result.setup_fee_written).toBeNull()
    expect(result.installment_1_written).toBeNull()
    expect(result.installment_2_written).toBeNull()
    // No update should have been issued at all.
    expect(accountUpdatePatch).toBeNull()
    // No action log when nothing changed.
    expect(actionLogRow).toBeNull()
  })

  it("parse failure on one installment: writes the parseable one, notes the failure", async () => {
    accountFixture = makeAccount()
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: "garbage" }, // unparseable
        ],
      },
    })

    expect(result.installment_1_written).toEqual({ amount: 1000, currency: "USD" })
    expect(result.installment_2_written).toBeNull()
    expect(result.account_type_flipped).toBe(true) // still flips because at least one installment parsed
    expect(result.notes.some(n => n.includes("installment_2") && n.includes("could not parse"))).toBe(true)
  })

  it("mixed currency (€ setup fee + $ installments): both saved with their respective currencies", async () => {
    accountFixture = makeAccount()
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "€3,800" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1250", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1250", currency: "USD" },
        ],
      },
    })

    expect(result.setup_fee_written).toEqual({ amount: 3800, currency: "EUR" })
    expect(result.installment_1_written).toEqual({ amount: 1250, currency: "USD" })
    expect(accountUpdatePatch?.setup_fee_currency).toBe("EUR")
    expect(accountUpdatePatch?.installment_1_currency).toBe("USD")
  })

  it("non-onboarding contract_type: early return, no writes", async () => {
    accountFixture = makeAccount()
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "formation",
        cost_summary: [{ label: "Setup Fee", total: "$1000" }],
        recurring_costs: [{ label: "1st Installment (January)", price: "$1000" }],
      },
    })
    expect(result.applied).toBe(false)
    expect(accountUpdatePatch).toBeNull()
    expect(actionLogRow).toBeNull()
  })

  it("account read failure: graceful skip with error note, no writes", async () => {
    accountFixture = null
    accountReadError = { message: "no rows" }
    const result = await applyOnboardingAccountUpgrades({
      accountId: "missing",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [{ label: "1st Installment (January)", price: "$1000" }],
      },
    })
    // Read failure short-circuits before `applied=true` is set — caller treats
    // it like a soft skip, no writes.
    expect(result.applied).toBe(false)
    expect(result.account_type_flipped).toBe(false)
    expect(result.notes.some(n => n.includes("account not found"))).toBe(true)
    expect(accountUpdatePatch).toBeNull()
  })

  it("account_type starts as null: treated like One-Time, flips to Client when recurring present", async () => {
    accountFixture = makeAccount({ account_type: null })
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
        ],
      },
    })
    expect(result.account_type_before).toBeNull()
    expect(result.account_type_flipped).toBe(true)
    expect(result.account_type_after).toBe("Client")
  })

  it("account_type is something else (e.g. Closed): never downgrades", async () => {
    accountFixture = makeAccount({ account_type: "Closed" })
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
          { label: "2nd Installment (June)", price: "$1000", currency: "USD" },
        ],
      },
    })
    expect(result.account_type_flipped).toBe(false)
    expect(result.account_type_after).toBe("Closed")
    expect(accountUpdatePatch?.account_type).toBeUndefined()
  })

  it("update error: rolls back optimistic flags so caller knows nothing landed", async () => {
    accountFixture = makeAccount()
    accountUpdateError = { message: "RLS violation" }
    const result = await applyOnboardingAccountUpgrades({
      accountId: "acc-1",
      offer: {
        contract_type: "onboarding",
        cost_summary: [{ label: "Setup Fee", total: "$500" }],
        recurring_costs: [
          { label: "1st Installment (January)", price: "$1000", currency: "USD" },
        ],
      },
    })
    expect(result.account_type_flipped).toBe(false)
    expect(result.setup_fee_written).toBeNull()
    expect(result.installment_1_written).toBeNull()
    expect(result.notes.some(n => n.includes("accounts.update failed"))).toBe(true)
  })
})
