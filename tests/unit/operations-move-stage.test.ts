/**
 * Unit tests for moveServiceDeliveryToStage in lib/operations/move-stage.ts
 *
 * The flow Workspace clickable-stepper move. It is a SHORTCUT for the action
 * buttons + Go Back, so it must dispatch by direction and fire the real side
 * effects via the existing helpers:
 *   - FORWARD  → ONE advanceServiceDelivery({ target_stage }) call.
 *   - BACKWARD → iterate revertServiceDelivery until the SD reaches the target.
 *
 * Both helpers are mocked (they live in OTHER modules) so we test the
 * orchestration: direction detection by name-resolved stage_order, the single
 * forward call, the backward loop count, the same-stage no-op, requires_approval
 * propagation, unknown target, and missing SD.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const advanceServiceDelivery = vi.fn()
const revertServiceDelivery = vi.fn()

vi.mock("@/lib/service-delivery", () => ({
  advanceServiceDelivery: (p: unknown) => advanceServiceDelivery(p),
}))
vi.mock("@/lib/operations/service-delivery", () => ({
  revertServiceDelivery: (p: unknown) => revertServiceDelivery(p),
}))

interface SDRow {
  id: string
  service_type: string
  stage: string | null
}
interface StageRow {
  stage_name: string
  stage_order: number
}

let sdRow: SDRow | null = null
let stagesRows: StageRow[] = []

function resolveFor(table: string) {
  if (table === "service_deliveries") return { data: sdRow, error: null }
  if (table === "pipeline_stages") return { data: stagesRows, error: null }
  return { data: null, error: null }
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select() {
          return chain
        },
        eq() {
          return chain
        },
        order() {
          return chain
        },
        maybeSingle: () => Promise.resolve(resolveFor(table)),
        then: (res: (v: unknown) => void) => res(resolveFor(table)),
      }
      return chain
    },
  },
}))

import { moveServiceDeliveryToStage } from "@/lib/operations/move-stage"

const TAX_STAGES: StageRow[] = [
  { stage_name: "Extension Due", stage_order: 10 },
  { stage_name: "Data Submitted", stage_order: 60 },
  { stage_name: "Under Review", stage_order: 65 },
  { stage_name: "Completed", stage_order: 100 },
]

beforeEach(() => {
  vi.clearAllMocks()
  sdRow = null
  stagesRows = []
})

describe("moveServiceDeliveryToStage", () => {
  it("FORWARD: one advanceServiceDelivery call to the target (full side effects)", async () => {
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Extension Due" }
    stagesRows = TAX_STAGES
    advanceServiceDelivery.mockResolvedValue({
      success: true,
      from_stage: "Extension Due",
      to_stage: "Completed",
      to_order: 100,
      is_completed: true,
      created_tasks: ["File return"],
    })

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Completed" })

    expect(advanceServiceDelivery).toHaveBeenCalledTimes(1)
    expect(advanceServiceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_id: "sd-1", target_stage: "Completed" }),
    )
    expect(revertServiceDelivery).not.toHaveBeenCalled()
    expect(res.success).toBe(true)
    expect(res.outcome).toBe("advanced")
    expect(res.direction).toBe("forward")
    expect(res.completed).toBe(true)
  })

  it("FORWARD: propagates requires_approval from advanceServiceDelivery", async () => {
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Data Submitted" }
    stagesRows = TAX_STAGES
    advanceServiceDelivery.mockResolvedValue({
      success: false,
      requires_approval: true,
      from_stage: "Data Submitted",
      error: "Current stage requires approval. Complete the approval task first.",
    })

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Under Review" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("requires_approval")
    expect(res.error).toMatch(/approval/i)
  })

  it("BACKWARD: iterates revertServiceDelivery until reaching the target", async () => {
    // Start at Completed (100), target Data Submitted (60): revert hops
    // Completed → Under Review → Data Submitted = 2 revert calls.
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Completed" }
    stagesRows = TAX_STAGES
    const hops = ["Under Review", "Data Submitted"]
    let i = 0
    revertServiceDelivery.mockImplementation(() =>
      Promise.resolve({ success: true, to_stage: hops[i++], documents_deleted: 1, renewal_date_reverted: null }),
    )

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })

    expect(advanceServiceDelivery).not.toHaveBeenCalled()
    expect(revertServiceDelivery).toHaveBeenCalledTimes(2)
    expect(res.success).toBe(true)
    expect(res.outcome).toBe("reverted")
    expect(res.direction).toBe("backward")
    expect(res.to_stage).toBe("Data Submitted")
    expect(res.documents_deleted).toBe(2)
  })

  it("BACKWARD: surfaces a failing revert as an error and stops", async () => {
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Completed" }
    stagesRows = TAX_STAGES
    revertServiceDelivery.mockResolvedValue({ success: false, error: "boom" })

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("error")
    expect(res.error).toBe("boom")
    expect(revertServiceDelivery).toHaveBeenCalledTimes(1)
  })

  it("same_stage no-op: neither helper called", async () => {
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Data Submitted" }
    stagesRows = TAX_STAGES

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })
    expect(res.outcome).toBe("same_stage")
    expect(advanceServiceDelivery).not.toHaveBeenCalled()
    expect(revertServiceDelivery).not.toHaveBeenCalled()
  })

  it("stage_not_found for an unknown target", async () => {
    sdRow = { id: "sd-1", service_type: "Tax Return", stage: "Data Submitted" }
    stagesRows = TAX_STAGES

    const res = await moveServiceDeliveryToStage({ delivery_id: "sd-1", target_stage: "Ghost Stage" })
    expect(res.outcome).toBe("stage_not_found")
    expect(advanceServiceDelivery).not.toHaveBeenCalled()
  })

  it("not_found when the SD does not exist", async () => {
    sdRow = null
    const res = await moveServiceDeliveryToStage({ delivery_id: "missing", target_stage: "Completed" })
    expect(res.outcome).toBe("not_found")
  })
})
