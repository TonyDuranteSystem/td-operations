/**
 * Unit tests for revertServiceDelivery in lib/operations/service-delivery.ts
 *
 * Covers: stepping back one stage by NAME (stage_order on the SD is ignored),
 * deletion of documents stamped with the PREVIOUS (target) stage, the
 * first-stage guard, the completed→active status reset, and the -1-year
 * renewal-date undo when leaving a "Closed" renewal final (State Annual Report
 * / State RA Renewal). Collaborators (account op, action-log, db wrappers) are
 * mocked so we test the helper's orchestration in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/service-delivery", () => ({ advanceServiceDelivery: vi.fn() }))
vi.mock("@/lib/services", () => ({ getEntryByServiceType: vi.fn() }))
vi.mock("@/lib/tasks/default-assignee", () => ({ defaultTaskAssignee: () => "Luca" }))

// ─── Collaborator mocks ────────────────────────────────

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

// ─── supabaseAdmin mock harness ────────────────────────

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
  due_date?: string | null
}

interface StageRow {
  stage_name: string
  stage_order: number
}

let sdRow: SDRow | null = null
let stagesRows: StageRow[] = []
let acctRow: Record<string, unknown> | null = null
let deletedDocs: { id: string }[] | null = []

let capturedSDUpdate: { patch: Record<string, unknown> | null } = { patch: null }
let capturedDocMatch: Record<string, unknown> | null = null

function resolveFor(table: string, op: string) {
  if (table === "service_deliveries") {
    return op === "update" ? { data: { id: "sd-1" }, error: null } : { data: sdRow, error: null }
  }
  if (table === "pipeline_stages") return { data: stagesRows, error: null }
  if (table === "documents") return { data: deletedDocs, error: null }
  if (table === "accounts") return { data: acctRow, error: null }
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
          return chain
        },
        update(patch: Record<string, unknown>) {
          ctx.op = "update"
          if (table === "service_deliveries") capturedSDUpdate.patch = patch
          return chain
        },
        delete() {
          ctx.op = "delete"
          return chain
        },
        match(q: Record<string, unknown>) {
          if (table === "documents") capturedDocMatch = q
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

import { revertServiceDelivery } from "@/lib/operations/service-delivery"

beforeEach(() => {
  vi.clearAllMocks()
  sdRow = null
  stagesRows = []
  acctRow = null
  deletedDocs = []
  capturedSDUpdate = { patch: null }
  capturedDocMatch = null
  updateAccount.mockResolvedValue({ success: true, outcome: "updated" })
})

describe("revertServiceDelivery", () => {
  it("steps back one stage by name and deletes documents stamped with the PREVIOUS stage", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Company Formation",
      service_name: "Formation",
      stage: "Stage C",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = [
      { stage_name: "Stage A", stage_order: 1 },
      { stage_name: "Stage B", stage_order: 2 },
      { stage_name: "Stage C", stage_order: 3 },
    ]
    deletedDocs = [{ id: "doc-1" }, { id: "doc-2" }]

    const res = await revertServiceDelivery({ delivery_id: "sd-1", actor: "flow-action" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("reverted")
    expect(res.to_stage).toBe("Stage B")
    expect(res.to_order).toBe(2)
    expect(res.documents_deleted).toBe(2)
    // Deletes docs at the TARGET (previous) stage, not the current one.
    expect(capturedDocMatch).toEqual({ service_delivery_id: "sd-1", flow_stage: "Stage B" })
    expect(capturedSDUpdate.patch?.stage).toBe("Stage B")
    expect(capturedSDUpdate.patch?.stage_order).toBe(2)
    // Non-completed SD: status untouched, account dates untouched.
    expect(capturedSDUpdate.patch?.status).toBeUndefined()
    expect(updateAccount).not.toHaveBeenCalled()
    expect(res.status_reset).toBe(false)
    expect(logAction).toHaveBeenCalled()
  })

  it("ignores the SD's own stage_order and resolves the previous stage by name", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Company Formation",
      service_name: "Formation",
      stage: "Stage C",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: null,
      end_date: null,
    }
    stagesRows = [
      { stage_name: "Stage A", stage_order: 1 },
      { stage_name: "Stage B", stage_order: 2 },
      { stage_name: "Stage C", stage_order: 3 },
    ]

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })
    expect(res.to_stage).toBe("Stage B")
    // stage_history starts a fresh array when the column was null.
    expect(Array.isArray(capturedSDUpdate.patch?.stage_history)).toBe(true)
    expect((capturedSDUpdate.patch?.stage_history as unknown[]).length).toBe(1)
  })

  it("returns at_first_stage when there is no earlier stage (no SD update)", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Company Formation",
      service_name: "Formation",
      stage: "Stage A",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = [
      { stage_name: "Stage A", stage_order: 1 },
      { stage_name: "Stage B", stage_order: 2 },
    ]

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("at_first_stage")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("resets status completed→active and clears end_date, and undoes the +1y annual_report bump", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State Annual Report",
      service_name: "Annual Report",
      stage: "Closed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-06-14",
    }
    stagesRows = [
      { stage_name: "Upcoming", stage_order: 1 },
      { stage_name: "Filed", stage_order: 2 },
      { stage_name: "Closed", stage_order: 3 },
    ]
    acctRow = { annual_report_due_date: "2027-05-01" }

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })

    expect(res.success).toBe(true)
    expect(res.to_stage).toBe("Filed")
    expect(res.status_reset).toBe(true)
    expect(capturedSDUpdate.patch?.status).toBe("active")
    expect(capturedSDUpdate.patch?.end_date).toBeNull()
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct-1", patch: { annual_report_due_date: "2026-05-01" } }),
    )
    expect(res.renewal_date_reverted).toEqual({
      column: "annual_report_due_date",
      from: "2027-05-01",
      to: "2026-05-01",
    })
  })

  it("undoes the +1y ra_renewal_date bump for State RA Renewal leaving Closed", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      stage: "Closed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-06-14",
    }
    stagesRows = [
      { stage_name: "Upcoming", stage_order: 1 },
      { stage_name: "Filed", stage_order: 2 },
      { stage_name: "Closed", stage_order: 3 },
    ]
    acctRow = { ra_renewal_date: "2027-06-21" }

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { ra_renewal_date: "2026-06-21" } }),
    )
    expect(res.renewal_date_reverted?.to).toBe("2026-06-21")
  })

  it("does not touch account dates when leaving Closed but the account date is empty", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      stage: "Closed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-06-14",
    }
    stagesRows = [
      { stage_name: "Filed", stage_order: 2 },
      { stage_name: "Closed", stage_order: 3 },
    ]
    acctRow = { ra_renewal_date: null }

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })
    expect(res.success).toBe(true)
    expect(updateAccount).not.toHaveBeenCalled()
    expect(res.renewal_date_reverted).toBeNull()
  })

  it("AL GROUP REGRESSION: un-rolls on a final stage named 'Completed' (not just 'Closed'), targeting the SD's own cycle date", async () => {
    // Wrongly-recorded 2026 filing rolled the account to 2027; Luca reverts
    // the SD. The old guard only fired on stage 'Closed' → date stayed 2027
    // and the company vanished from the 2026 calendar (2026-08-07).
    sdRow = {
      id: "sd-1",
      service_type: "State Annual Report",
      service_name: "Annual Report",
      stage: "Completed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-07-15",
      due_date: "2026-12-15",
    }
    stagesRows = [
      { stage_name: "Upcoming", stage_order: 1 },
      { stage_name: "In Progress", stage_order: 2 },
      { stage_name: "Completed", stage_order: 3 },
    ]
    acctRow = { annual_report_due_date: "2027-12-15" }

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })

    expect(res.success).toBe(true)
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct-1", patch: { annual_report_due_date: "2026-12-15" } }),
    )
    expect(res.renewal_date_reverted).toEqual({
      column: "annual_report_due_date",
      from: "2027-12-15",
      to: "2026-12-15",
    })
  })

  it("never moves the date FORWARD or when it already matches the reopened cycle", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State Annual Report",
      service_name: "Annual Report",
      stage: "Completed",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: "2026-07-15",
      due_date: "2026-12-15",
    }
    stagesRows = [
      { stage_name: "Upcoming", stage_order: 1 },
      { stage_name: "Completed", stage_order: 2 },
    ]
    // Someone already repaired the date to the reopened cycle — nothing to undo.
    acctRow = { annual_report_due_date: "2026-12-15" }

    const res = await revertServiceDelivery({ delivery_id: "sd-1" })

    expect(res.success).toBe(true)
    expect(updateAccount).not.toHaveBeenCalled()
    expect(res.renewal_date_reverted).toBeNull()
  })

  it("returns not_found when the SD does not exist", async () => {
    sdRow = null
    const res = await revertServiceDelivery({ delivery_id: "missing" })
    expect(res.outcome).toBe("not_found")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("returns error when the current stage is not part of the pipeline", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Company Formation",
      service_name: "Formation",
      stage: "Ghost Stage",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      stage_history: [],
      end_date: null,
    }
    stagesRows = [
      { stage_name: "Stage A", stage_order: 1 },
      { stage_name: "Stage B", stage_order: 2 },
    ]
    const res = await revertServiceDelivery({ delivery_id: "sd-1" })
    expect(res.outcome).toBe("error")
    expect(capturedSDUpdate.patch).toBeNull()
  })
})
