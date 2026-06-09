/**
 * lib/installment-handler.ts — onSecondInstallmentPaid unit tests
 *
 * Covers the two behaviours changed in the "Card = Truth" Phase 1 work:
 *   1.3 — the Tax Return SD advances to "Wizard Available" from ANY of the
 *         bundle pre-wizard stages (1st Installment Paid / Extension Filed /
 *         Awaiting 2nd Payment), not just "Awaiting 2nd Payment".
 *   1.1 — the "[READY] Send tax return to Accountant" task is idempotent: a second
 *         run with the same account/year does not insert a duplicate. The dedup
 *         lookup also matches the legacy "...to India" title during the rename
 *         transition (two-phase Slice 0, 2026-06-09).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/gmail", () => ({ gmailPost: vi.fn(() => Promise.resolve({})) }))
vi.mock("@/lib/settings", () => ({ isTaxSeasonPaused: vi.fn(() => Promise.resolve(false)) }))
vi.mock("@/lib/tax/reactivation", () => ({
  reactivateOnHoldTaxReturns: vi.fn(() => Promise.resolve({ reactivated: 0 })),
}))
vi.mock("@/lib/db", () => ({
  dbWrite: vi.fn(() => Promise.resolve({ data: null, error: null })),
  dbWriteSafe: vi.fn(() => Promise.resolve({ data: null, error: null })),
}))

// Capture advanceStageIfAt params + control its result.
const advanceCalls: Array<Record<string, unknown>> = []
let advanceResult = { advanced: true, current_stage: "1st Installment Paid", result: { success: true } }
vi.mock("@/lib/operations/service-delivery", () => ({
  createSD: vi.fn(() => Promise.resolve({ id: "sd-new" })),
  advanceStageIfAt: vi.fn((params: Record<string, unknown>) => {
    advanceCalls.push(params)
    return Promise.resolve(advanceResult)
  }),
}))

// The advance rule is resolved from pipeline_stages DATA (no hardcoded names).
// Mock it so the handler test asserts it PASSES THROUGH the resolved rule.
let ruleFixture: { target_stage: string; source_stages: string[] } | null = {
  target_stage: "Wizard Available",
  source_stages: ["1st Installment Paid", "Extension Filed", "Awaiting 2nd Payment"],
}
vi.mock("@/lib/services/stages", () => ({
  resolveSecondInstallmentAdvance: vi.fn(() => Promise.resolve(ruleFixture)),
}))

// Fixtures the supabaseAdmin mock serves per table.
let accountFixture: Record<string, unknown> | null = { id: "acct-1", company_name: "Test MMLLC LLC" }
let taxReturnFixture: Record<string, unknown> | null = {
  id: "tr-1", status: "Extension Filed", sent_to_accountant: false, data_received: true,
}
let sdFixture: Record<string, unknown> | null = { id: "sd-1", stage: "1st Installment Paid" }
let existingTaskFixture: Record<string, unknown> | null = null
const taskInserts: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => {
  function chainFor(table: string) {
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      update: vi.fn(() => chain),
      insert: vi.fn((payload: Record<string, unknown>) => {
        if (table === "tasks") taskInserts.push(payload)
        return chain
      }),
      single: vi.fn(() => Promise.resolve({ data: table === "accounts" ? accountFixture : null, error: null })),
      maybeSingle: vi.fn(() => {
        if (table === "tax_returns") return Promise.resolve({ data: taxReturnFixture, error: null })
        if (table === "service_deliveries") return Promise.resolve({ data: sdFixture, error: null })
        if (table === "tasks") return Promise.resolve({ data: existingTaskFixture, error: null })
        return Promise.resolve({ data: null, error: null })
      }),
      then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: null, error: null }),
    }
    return chain
  }
  return { supabaseAdmin: { from: (table: string) => chainFor(table) } }
})

import { onSecondInstallmentPaid } from "@/lib/installment-handler"

beforeEach(() => {
  advanceCalls.length = 0
  taskInserts.length = 0
  advanceResult = { advanced: true, current_stage: "1st Installment Paid", result: { success: true } }
  accountFixture = { id: "acct-1", company_name: "Test MMLLC LLC" }
  taxReturnFixture = { id: "tr-1", status: "Extension Filed", sent_to_accountant: false, data_received: true }
  sdFixture = { id: "sd-1", stage: "1st Installment Paid" }
  existingTaskFixture = null
  ruleFixture = {
    target_stage: "Wizard Available",
    source_stages: ["1st Installment Paid", "Extension Filed", "Awaiting 2nd Payment"],
  }
})

describe("onSecondInstallmentPaid — stage gate (1.3, data-driven)", () => {
  it("advances using the rule resolved from pipeline_stages (no hardcoded names)", async () => {
    await onSecondInstallmentPaid("acct-1", 2026)
    expect(advanceCalls).toHaveLength(1)
    expect(advanceCalls[0].if_current_stage).toEqual(ruleFixture!.source_stages)
    expect(advanceCalls[0].target_stage).toBe(ruleFixture!.target_stage)
  })

  it("skips (does NOT advance) when no 2nd-installment target stage is configured", async () => {
    ruleFixture = null
    await onSecondInstallmentPaid("acct-1", 2026)
    expect(advanceCalls).toHaveLength(0)
  })
})

describe("onSecondInstallmentPaid — accountant task idempotency (1.1)", () => {
  it("inserts the accountant task when none exists and data is received", async () => {
    existingTaskFixture = null
    await onSecondInstallmentPaid("acct-1", 2026)
    const accountantInserts = taskInserts.filter(t =>
      String(t.task_title).startsWith("[READY] Send tax return to Accountant"))
    expect(accountantInserts).toHaveLength(1)
  })

  it("does NOT insert a duplicate accountant task when one already exists", async () => {
    existingTaskFixture = { id: "task-existing" }
    await onSecondInstallmentPaid("acct-1", 2026)
    const accountantInserts = taskInserts.filter(t =>
      String(t.task_title).startsWith("[READY] Send tax return to Accountant"))
    expect(accountantInserts).toHaveLength(0)
  })
})
