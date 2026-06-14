/**
 * Unit tests for setServiceDeliveryStage in lib/operations/service-delivery.ts
 *
 * The flow Workspace stepper's "jump to any stage" control. Covers: forward and
 * backward moves by NAME (SD stage_order is ignored), terminal-stage status set
 * (Completed / TR Filed / Closed-for-renewal → completed + end_date), jumping
 * back out of a completed stage (active + cleared end_date), the same-stage
 * no-op, unknown target, and missing SD. It must NOT create auto-tasks, notify
 * the client, delete documents, or touch account renewal dates — verified by
 * asserting those collaborators are never called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/service-delivery", () => ({ advanceServiceDelivery: vi.fn() }))
vi.mock("@/lib/services", () => ({ getEntryByServiceType: vi.fn() }))
vi.mock("@/lib/tasks/default-assignee", () => ({ defaultTaskAssignee: () => "Luca" }))

const updateTasksBulk = vi.fn()
const updateAccount = vi.fn()
const logAction = vi.fn()

vi.mock("@/lib/operations/task", () => ({ updateTasksBulk: (p: unknown) => updateTasksBulk(p) }))
vi.mock("@/lib/operations/account", () => ({ updateAccount: (p: unknown) => updateAccount(p) }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (p: unknown) => logAction(p) }))

vi.mock("@/lib/db", () => ({
  dbWrite: async (q: Promise<{ data: unknown; error: unknown }>) => {
    const r = await q
    if (r.error) throw new Error(String((r.error as { message?: string }).message ?? r.error))
    return r.data
  },
  dbWriteSafe: async (q: Promise<{ data: unknown; error: unknown }>) => {
    const r = await q
    return { data: r.data, error: r.error ? String((r.error as { message?: string }).message) : null }
  },
}))

interface SDRow {
  id: string
  service_type: string
  service_name: string | null
  stage: string | null
  status: string
  account_id: string | null
  contact_id: string | null
  stage_history: unknown[] | null
  end_date: string | null
}

interface StageRow {
  stage_name: string
  stage_order: number
}

let sdRow: SDRow | null = null
let stagesRows: StageRow[] = []
let capturedSDUpdate: { patch: Record<string, unknown> | null } = { patch: null }
let insertCalled = false
let deleteCalled = false

function resolveFor(table: string, op: string) {
  if (table === "service_deliveries") {
    return op === "update" ? { data: { id: "sd-1" }, error: null } : { data: sdRow, error: null }
  }
  if (table === "pipeline_stages") return { data: stagesRows, error: null }
  return { data: null, error: null }
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const ctx = { op: "select" as "select" | "update" | "insert" | "delete" }
      const chain: Record<string, unknown> = {
        select() {
          return chain
        },
        insert() {
          ctx.op = "insert"
          insertCalled = true
          return chain
        },
        update(patch: Record<string, unknown>) {
          ctx.op = "update"
          if (table === "service_deliveries") capturedSDUpdate.patch = patch
          return chain
        },
        delete() {
          ctx.op = "delete"
          deleteCalled = true
          return chain
        },
        match() {
          return chain
        },
        eq() {
          return chain
        },
        order() {
          return chain
        },
        maybeSingle: () => Promise.resolve(resolveFor(table, ctx.op)),
        single: () => Promise.resolve(resolveFor(table, ctx.op)),
        then: (res: (v: unknown) => void) => res(resolveFor(table, ctx.op)),
      }
      return chain
    },
  },
}))

import { setServiceDeliveryStage } from "@/lib/operations/service-delivery"

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
  capturedSDUpdate = { patch: null }
  insertCalled = false
  deleteCalled = false
})

describe("setServiceDeliveryStage", () => {
  it("moves FORWARD to an arbitrary stage by name, status stays active", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Extension Due",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({
      delivery_id: "sd-1",
      target_stage: "Under Review",
      actor: "flow-stepper",
    })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("moved")
    expect(res.to_stage).toBe("Under Review")
    expect(res.to_order).toBe(65)
    expect(res.completed).toBe(false)
    expect(capturedSDUpdate.patch?.stage).toBe("Under Review")
    expect(capturedSDUpdate.patch?.stage_order).toBe(65)
    expect(capturedSDUpdate.patch?.status).toBe("active")
    expect(capturedSDUpdate.patch?.end_date).toBeNull()
    // History appended.
    expect((capturedSDUpdate.patch?.stage_history as unknown[]).length).toBe(1)
    // No side effects.
    expect(insertCalled).toBe(false)
    expect(deleteCalled).toBe(false)
    expect(updateAccount).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalled()
  })

  it("moves BACKWARD by name, ignoring the SD's own stage_order", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Under Review",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: null,
      end_date: null,
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })
    expect(res.success).toBe(true)
    expect(res.to_stage).toBe("Data Submitted")
    expect(res.to_order).toBe(60)
    // stage_history starts a fresh array when the column was null.
    expect(Array.isArray(capturedSDUpdate.patch?.stage_history)).toBe(true)
  })

  it("sets status completed + end_date when the target is a terminal stage", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Under Review",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Completed" })
    expect(res.completed).toBe(true)
    expect(capturedSDUpdate.patch?.status).toBe("completed")
    expect(capturedSDUpdate.patch?.end_date).toEqual(expect.any(String))
    // No renewal-date bump even on completion.
    expect(updateAccount).not.toHaveBeenCalled()
  })

  it("re-opens (active + cleared end_date) when jumping back OUT of a completed stage", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Completed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-06-14",
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })
    expect(res.completed).toBe(false)
    expect(capturedSDUpdate.patch?.status).toBe("active")
    expect(capturedSDUpdate.patch?.end_date).toBeNull()
  })

  it("treats Closed as terminal ONLY for the renewal flows", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      stage: "Document Uploaded",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = [
      { stage_name: "Renewal Due", stage_order: 10 },
      { stage_name: "Document Uploaded", stage_order: 30 },
      { stage_name: "Closed", stage_order: 40 },
    ]

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Closed" })
    expect(res.completed).toBe(true)
    expect(capturedSDUpdate.patch?.status).toBe("completed")
  })

  it("returns same_stage no-op when already at the target (no SD update)", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Data Submitted",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Data Submitted" })
    expect(res.outcome).toBe("same_stage")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("returns stage_not_found for an unknown target (no SD update)", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax Return",
      stage: "Data Submitted",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = TAX_STAGES

    const res = await setServiceDeliveryStage({ delivery_id: "sd-1", target_stage: "Ghost Stage" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("stage_not_found")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("returns not_found when the SD does not exist", async () => {
    sdRow = null
    const res = await setServiceDeliveryStage({ delivery_id: "missing", target_stage: "Completed" })
    expect(res.outcome).toBe("not_found")
    expect(capturedSDUpdate.patch).toBeNull()
  })
})
