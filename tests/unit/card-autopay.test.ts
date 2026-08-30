/**
 * lib/operations/card-autopay.ts unit tests
 *
 * Scope note: functions that call the live Stripe SDK directly (creating a
 * customer, creating a setup Checkout Session, detaching a payment method)
 * follow this codebase's existing convention (lib/stripe-checkout.ts,
 * lib/finance/stripe-payouts.ts) of not being unit-mocked against the
 * "stripe" package — only their DB-side control flow is covered here.
 *
 * Covers:
 *   - getOrCreateStripeCustomerForAccount short-circuits on an existing id
 *     WITHOUT requiring a Stripe key (no customer needs to be created)
 *   - getOrCreateStripeCustomerForAccount surfaces "Account not found"
 *   - saveAutopayCard writes all four account fields + logs to action_log
 *   - disableAutopayCard clears the account fields even with no Stripe key
 *     configured (detach is best-effort, not a hard dependency)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Row {
  autopay_stripe_customer_id?: string | null
  autopay_stripe_payment_method_id?: string | null
  company_name?: string
}

let accountRow: Row | null = null
let accountFetchError: { message: string } | null = null
let killSwitchEnabled = true
// Terminal resolution for a chain ending in .select() (the disable-autopay
// concurrency-guarded update) — defaults to "one row matched", the normal
// case. Override per-test to simulate the optimistic-concurrency race (0
// rows matched because the value changed underneath the WHERE clause).
let updateSelectResult: { data: { id: string }[] | null; error: { message: string } | null } = { data: [{ id: "acc-1" }], error: null }
const updateCalls: Array<{ table: string; payload: Record<string, unknown> }> = []
const insertCalls: Array<{ table: string; payload: Record<string, unknown> }> = []

vi.mock("@/lib/payments/card-autopay-config", () => ({
  isCardAutopayEnabled: () => Promise.resolve(killSwitchEnabled),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain = {
        // select() has two shapes here: mid-chain (accounts read, followed by
        // .eq().single()) where callers need further chaining, vs. terminal
        // (the disable-autopay concurrency-guarded update, followed by
        // nothing — awaited directly). Returning `chain` itself covers both:
        // it's still chainable AND thenable (below), so `await x.select("id")`
        // resolves via updateSelectResult.
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        is: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve({ data: accountRow, error: accountFetchError })),
        update: vi.fn((payload: Record<string, unknown>) => {
          updateCalls.push({ table, payload })
          return chain
        }),
        insert: vi.fn((payload: Record<string, unknown>) => {
          insertCalls.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        }),
        then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(updateSelectResult),
      }
      return chain
    },
  },
}))

import {
  getOrCreateStripeCustomerForAccount,
  saveAutopayCard,
  disableAutopayCard,
} from "@/lib/operations/card-autopay"

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  accountRow = null
  accountFetchError = null
  killSwitchEnabled = true
  updateSelectResult = { data: [{ id: "acc-1" }], error: null }
  updateCalls.length = 0
  insertCalls.length = 0
})

describe("getOrCreateStripeCustomerForAccount", () => {
  it("returns the existing customer id without needing a Stripe key", async () => {
    accountRow = { autopay_stripe_customer_id: "cus_existing_123" }
    const result = await getOrCreateStripeCustomerForAccount("acc-1")
    expect(result).toEqual({ customerId: "cus_existing_123" })
  })

  it("returns an error when the account is not found", async () => {
    accountRow = null
    accountFetchError = { message: "no rows" }
    const result = await getOrCreateStripeCustomerForAccount("acc-missing")
    expect(result).toEqual({ error: "Account not found" })
  })

  it("surfaces STRIPE_SECRET_KEY not set only when a new customer must be created", async () => {
    accountRow = { autopay_stripe_customer_id: null, company_name: "ACME LLC" }
    const result = await getOrCreateStripeCustomerForAccount("acc-2")
    expect(result).toEqual({ error: "STRIPE_SECRET_KEY not set" })
  })
})

describe("saveAutopayCard", () => {
  it("writes all four fields and logs to action_log", async () => {
    await saveAutopayCard({
      accountId: "acc-1",
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      last4: "4242",
    })

    const accountsUpdate = updateCalls.find((u) => u.table === "accounts")
    expect(accountsUpdate?.payload).toEqual({
      autopay_stripe_customer_id: "cus_1",
      autopay_stripe_payment_method_id: "pm_1",
      autopay_card_last4: "4242",
      autopay_card_enabled: true,
    })

    const logInsert = insertCalls.find((i) => i.table === "action_log")
    expect(logInsert?.payload).toMatchObject({ action_type: "card_autopay_enrolled", account_id: "acc-1" })
  })

  it("refuses to enable the account while the global kill switch is off — a session created before the switch flipped off must not arm on completion", async () => {
    killSwitchEnabled = false
    await saveAutopayCard({
      accountId: "acc-1",
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      last4: "4242",
    })
    expect(updateCalls.find((u) => u.table === "accounts")).toBeUndefined()
  })
})

describe("disableAutopayCard", () => {
  it("clears the account fields even when no Stripe key is configured (detach is best-effort)", async () => {
    accountRow = { autopay_stripe_payment_method_id: "pm_1" }
    const result = await disableAutopayCard("acc-1")
    expect(result).toEqual({ ok: true })

    const accountsUpdate = updateCalls.find((u) => u.table === "accounts")
    expect(accountsUpdate?.payload).toEqual({
      autopay_card_enabled: false,
      autopay_stripe_payment_method_id: null,
      autopay_card_last4: null,
    })
  })

  it("returns ok=false when the account fetch errors", async () => {
    accountFetchError = { message: "connection reset" }
    const result = await disableAutopayCard("acc-1")
    expect(result).toEqual({ ok: false, error: "connection reset" })
  })

  it("refuses instead of silently wiping a brand-new card when the payment method changed concurrently (a re-enrollment mid-flight)", async () => {
    accountRow = { autopay_stripe_payment_method_id: "pm_1" }
    updateSelectResult = { data: [], error: null }
    const result = await disableAutopayCard("acc-1")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("changed at the same moment")
  })
})
