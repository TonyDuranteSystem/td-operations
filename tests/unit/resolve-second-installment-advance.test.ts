/**
 * lib/services/stages.ts — resolveSecondInstallmentAdvance unit tests
 *
 * The 2nd-installment advance rule is DATA-DRIVEN: the target stage is the one
 * flagged auto_actions.second_installment_target, and the source stages are
 * derived from stage_order (>= 1 and below the target), so renames/reorders in
 * /config don't break it and the standalone-intake stages (order <= 0) are
 * never auto-skipped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface StageRow {
  stage_name: string
  stage_order: number
  auto_actions: Record<string, unknown> | null
}

let stagesFixture: StageRow[] = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: stagesFixture, error: null }),
      }
      return chain
    },
  },
}))

import { resolveSecondInstallmentAdvance } from "@/lib/services/stages"

// Mirrors the real Tax Return pipeline ordering.
const TAX_STAGES: StageRow[] = [
  { stage_name: "Company Data Pending", stage_order: -1, auto_actions: null },
  { stage_name: "Paid - Awaiting Data", stage_order: 0, auto_actions: null },
  { stage_name: "1st Installment Paid", stage_order: 1, auto_actions: null },
  { stage_name: "Extension Filed", stage_order: 2, auto_actions: null },
  { stage_name: "Awaiting 2nd Payment", stage_order: 3, auto_actions: null },
  { stage_name: "Wizard Available", stage_order: 4, auto_actions: { second_installment_target: true } },
  { stage_name: "Data Received", stage_order: 5, auto_actions: null },
]

beforeEach(() => {
  stagesFixture = TAX_STAGES.map(s => ({ ...s }))
})

describe("resolveSecondInstallmentAdvance", () => {
  it("returns the flagged stage as target and order-derived bundle stages as sources", async () => {
    const rule = await resolveSecondInstallmentAdvance("Tax Return")
    expect(rule).not.toBeNull()
    expect(rule!.target_stage).toBe("Wizard Available")
    expect(rule!.source_stages).toEqual([
      "1st Installment Paid",
      "Extension Filed",
      "Awaiting 2nd Payment",
    ])
  })

  it("excludes the standalone-intake stages (stage_order <= 0)", async () => {
    const rule = await resolveSecondInstallmentAdvance("Tax Return")
    expect(rule!.source_stages).not.toContain("Company Data Pending")
    expect(rule!.source_stages).not.toContain("Paid - Awaiting Data")
  })

  it("excludes the target stage and anything at/after it", async () => {
    const rule = await resolveSecondInstallmentAdvance("Tax Return")
    expect(rule!.source_stages).not.toContain("Wizard Available")
    expect(rule!.source_stages).not.toContain("Data Received")
  })

  it("follows the marker after a rename (no hardcoded names)", async () => {
    // Rename "Wizard Available" → "Data Wizard" and move the marker with it.
    stagesFixture = stagesFixture.map(s =>
      s.stage_name === "Wizard Available" ? { ...s, stage_name: "Data Wizard" } : s,
    )
    const rule = await resolveSecondInstallmentAdvance("Tax Return")
    expect(rule!.target_stage).toBe("Data Wizard")
    expect(rule!.source_stages).toEqual([
      "1st Installment Paid",
      "Extension Filed",
      "Awaiting 2nd Payment",
    ])
  })

  it("returns null when no stage is flagged as the target", async () => {
    stagesFixture = stagesFixture.map(s => ({ ...s, auto_actions: null }))
    const rule = await resolveSecondInstallmentAdvance("Tax Return")
    expect(rule).toBeNull()
  })
})
