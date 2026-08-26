/**
 * Unit tests for `applyFormationFinancialFills` — fills setup_fee_amount +
 * both installment amounts on a freshly-materialized formation account from
 * its signed offer, write-if-null via a per-column `.is(col, null)` guard.
 *
 * Strategy: mock supabaseAdmin's `accounts` table to capture each per-column
 * update call and simulate the "already set" (`.is` excludes the row) vs
 * "was null" (`.is` matches, write lands) cases via a settable current-value
 * map. `action_log` insert is captured for the audit-trail assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

let currentValues: Record<string, unknown> = {}
let updateCalls: Array<{ patch: Record<string, unknown>; guardCol: string }> = []
let actionLogRows: Record<string, unknown>[] = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              is: (guardCol: string, _guardVal: null) => {
                updateCalls.push({ patch, guardCol })
                const alreadySet = currentValues[guardCol] != null
                return {
                  select: () =>
                    alreadySet
                      ? Promise.resolve({ data: [], error: null })
                      : Promise.resolve({ data: [{ id: "acc-1" }], error: null }),
                }
              },
            }),
          }),
        }
      }
      if (table === "action_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            actionLogRows.push(row)
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

import { applyFormationFinancialFills } from "@/lib/operations/onboarding-account-upgrade"

beforeEach(() => {
  currentValues = {
    installment_1_amount: null,
    installment_2_amount: null,
    setup_fee_amount: null,
  }
  updateCalls = []
  actionLogRows = []
})

const offerWithCleanShape = {
  recurring_costs: [
    { label: "1st Installment (January)", price: "$1,250", currency: "USD" },
    { label: "2nd Installment (June)", price: "$1,250", currency: "USD" },
    { label: "Annual Total", price: "$2,500", currency: "USD" },
  ],
  cost_summary: [{ label: "Setup Fee", total: "$3,000" }],
}

describe("applyFormationFinancialFills", () => {
  it("writes all three fields when all are currently null", async () => {
    const applied = await applyFormationFinancialFills("acc-1", offerWithCleanShape)
    expect(applied).toEqual([
      "installment_1_amount=1250 USD",
      "installment_2_amount=1250 USD",
      "setup_fee_amount=3000 USD",
    ])
    expect(updateCalls.map(c => c.guardCol)).toEqual([
      "installment_1_amount",
      "installment_2_amount",
      "setup_fee_amount",
    ])
    expect(updateCalls[0].patch).toMatchObject({ installment_1_amount: 1250, installment_1_currency: "USD" })
  })

  it("skips a field that is already set, write-if-null only", async () => {
    currentValues.installment_1_amount = 999 // manually corrected earlier, must not be overwritten
    const applied = await applyFormationFinancialFills("acc-1", offerWithCleanShape)
    expect(applied).toEqual(["installment_2_amount=1250 USD", "setup_fee_amount=3000 USD"])
  })

  it("does not treat a real $0 as unset — parsePrice rejects zero, so it never attempts that column", async () => {
    const offer = {
      recurring_costs: [
        { label: "1st Installment (January)", price: "$0", currency: "USD" },
        { label: "2nd Installment (June)", price: "$1,000", currency: "USD" },
      ],
      cost_summary: null,
    }
    const applied = await applyFormationFinancialFills("acc-1", offer)
    expect(applied).toEqual(["installment_2_amount=1000 USD"])
  })

  it("a combined/unparseable price shape (DoctorGut LLC) is skipped, not written as a bogus number", async () => {
    const offer = {
      recurring_costs: [
        {
          label: "Annual LLC Management New Mexico (from 2027)",
          price: "$2,000/year ($1,000 Jan + $1,000 Jun)",
        },
      ],
      cost_summary: [{ label: "Setup Fee", total: "$3,000" }],
    }
    const applied = await applyFormationFinancialFills("acc-1", offer)
    // findInstallment's label regex doesn't match this row at all (no jan/jun
    // marker), so nothing for installments is even attempted — only the
    // Setup Fee section (a separate, cleanly-shaped field) gets written.
    expect(applied).toEqual(["setup_fee_amount=3000 USD"])
  })

  it("writes nothing and logs no action_log row when nothing parses", async () => {
    const offer = { recurring_costs: [], cost_summary: null }
    const applied = await applyFormationFinancialFills("acc-1", offer)
    expect(applied).toEqual([])
    expect(actionLogRows).toHaveLength(0)
  })

  it("logs a single action_log row summarizing every field actually written", async () => {
    await applyFormationFinancialFills("acc-1", offerWithCleanShape)
    expect(actionLogRows).toHaveLength(1)
    expect(actionLogRows[0]).toMatchObject({
      action_type: "formation_financial_fill",
      record_id: "acc-1",
      account_id: "acc-1",
    })
  })

  it("respects a EUR-tagged installment row over the USD default", async () => {
    const offer = {
      recurring_costs: [
        { label: "1st Installment (January)", price: "€1,000", currency: "EUR" },
      ],
      cost_summary: null,
    }
    const applied = await applyFormationFinancialFills("acc-1", offer)
    expect(applied).toEqual(["installment_1_amount=1000 EUR"])
    expect(updateCalls[0].patch).toMatchObject({ installment_1_amount: 1000, installment_1_currency: "EUR" })
  })
})
