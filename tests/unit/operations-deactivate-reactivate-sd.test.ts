/**
 * Unit tests for deactivateSD / reactivateSD in lib/operations/service-delivery.ts
 *
 * Covers: status flips, open-task cancellation, renewal-date clearing (only for
 * renewal service types with clear flag), no-op guards (already terminal / not
 * cancelled / not found / stale), and the renewal-date-empty warning on
 * reactivate. Collaborators (task + account operations, action-log, db wrappers)
 * are mocked so we test the helper's orchestration logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/service-delivery", () => ({ advanceServiceDelivery: vi.fn() }))
vi.mock("@/lib/services", () => ({
  getEntryByServiceType: vi.fn(),
  isPerPersonServiceType: vi.fn(async () => false),
}))
vi.mock("@/lib/tasks/default-assignee", () => ({ defaultTaskAssignee: () => "Luca" }))

// ─── Collaborator mocks ────────────────────────────────

const updateTasksBulk = vi.fn()
const updateAccount = vi.fn()
const logAction = vi.fn()

vi.mock("@/lib/operations/task", () => ({ updateTasksBulk: (p: unknown) => updateTasksBulk(p) }))
vi.mock("@/lib/operations/account", () => ({ updateAccount: (p: unknown) => updateAccount(p) }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (p: unknown) => logAction(p) }))

// dbWrite/dbWriteSafe just await the (mocked) query and unwrap it.
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
  status: string
  account_id: string | null
  contact_id: string | null
  updated_at: string | null
  notes?: string | null
}

let sdRow: SDRow | null = null
let sdUpdateResult: { id: string } | null = { id: "sd-1" }
let acctRow: Record<string, unknown> | null = null
let capturedSDUpdate: { patch: Record<string, unknown> | null; filters: Record<string, string> } = {
  patch: null,
  filters: {},
}
let capturedTaskInsert: Record<string, unknown> | null = null
/** Rows returned by deactivateSD's unlinked-open-tasks lookup. */
let looseTaskRows: Array<{ id: string; task_title: string }> = []
/** Rows returned by reactivateSD's "another active per-person SD?" lookup. */
let perPersonConflictRows: Array<{ id: string }> = []

function resolveFor(table: string, op: string) {
  if (table === "service_deliveries") {
    // reactivateSD's per-person conflict lookup terminates on .limit()
    if (op === "perPersonLookup") return { data: perPersonConflictRows, error: null }
    return op === "update" ? { data: sdUpdateResult, error: null } : { data: sdRow, error: null }
  }
  if (table === "accounts") return { data: acctRow, error: null }
  if (table === "tasks") {
    // deactivateSD's loose-task lookup terminates on .limit() and expects a list.
    if (op === "looseTasks") return { data: looseTaskRows, error: null }
    return { data: { id: "task-new" }, error: null }
  }
  return { data: null, error: null }
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const ctx = { op: "select" as "select" | "update" | "insert" }
      const chain: Record<string, unknown> = {
        select(this: unknown) {
          return chain
        },
        insert(payload: Record<string, unknown>) {
          ctx.op = "insert"
          if (table === "tasks") capturedTaskInsert = payload
          return chain
        },
        update(patch: Record<string, unknown>) {
          ctx.op = "update"
          if (table === "service_deliveries") capturedSDUpdate.patch = patch
          return chain
        },
        eq(col: string, value: string) {
          if (table === "service_deliveries" && ctx.op === "update") capturedSDUpdate.filters[col] = value
          return chain
        },
        // Used by deactivateSD's "unlinked open tasks" lookup
        // (.eq(contact).is(delivery_id, null).in(status).limit(20)).
        is: () => chain,
        in: () => chain,
        neq: () => chain,
        or: () => chain,
        limit: () =>
          Promise.resolve(
            resolveFor(table, table === "service_deliveries" ? "perPersonLookup" : "looseTasks"),
          ),
        maybeSingle: () => Promise.resolve(resolveFor(table, ctx.op)),
        single: () => Promise.resolve(resolveFor(table, ctx.op)),
        then: (res: (v: unknown) => void) => res(resolveFor(table, ctx.op)),
      }
      return chain
    },
  },
}))

import { deactivateSD, reactivateSD } from "@/lib/operations/service-delivery"
import { isPerPersonServiceType } from "@/lib/services"

beforeEach(() => {
  vi.clearAllMocks()
  // Default: not a per-person service. clearAllMocks wipes the factory default,
  // so re-arm it here or every reactivate test sees `undefined` (falsy but
  // not a promise) and the awaited call misbehaves.
  vi.mocked(isPerPersonServiceType).mockResolvedValue(false)
  sdRow = null
  sdUpdateResult = { id: "sd-1" }
  acctRow = null
  capturedSDUpdate = { patch: null, filters: {} }
  capturedTaskInsert = null
  looseTaskRows = []
  perPersonConflictRows = []
  updateTasksBulk.mockResolvedValue({ success: true, outcome: "updated", count: 0 })
  updateAccount.mockResolvedValue({ success: true, outcome: "updated" })
})

// ─── deactivateSD ──────────────────────────────────────

describe("deactivateSD", () => {
  it("cancels a non-renewal active service, cancels its open tasks, does not touch account dates", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "2026-05-26T00:00:00Z",
      notes: null,
    }
    updateTasksBulk.mockResolvedValue({ success: true, outcome: "updated", count: 2 })

    const res = await deactivateSD({ delivery_id: "sd-1", reason: "client handles it" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("deactivated")
    expect(res.tasks_cancelled).toBe(2)
    expect(res.renewal_date_cleared).toBe(false)
    expect(capturedSDUpdate.patch?.status).toBe("cancelled")
    expect(capturedSDUpdate.patch?.end_date).toBeTruthy()
    expect(updateTasksBulk).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_id: "sd-1", patch: { status: "Cancelled" } }),
    )
    expect(updateAccount).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalled()
  })

  it("clears the account renewal date for State RA Renewal when clear_renewal_date=true", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "2026-05-26T00:00:00Z",
      notes: null,
    }
    acctRow = { ra_renewal_date: "2026-06-21" }

    const res = await deactivateSD({ delivery_id: "sd-1", clear_renewal_date: true })

    expect(res.success).toBe(true)
    expect(res.renewal_date_cleared).toBe(true)
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acct-1", patch: { ra_renewal_date: null } }),
    )
  })

  it("clears annual_report_due_date for State Annual Report", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State Annual Report",
      service_name: "Annual Report",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
      notes: null,
    }
    acctRow = { annual_report_due_date: "2026-06-01" }

    const res = await deactivateSD({ delivery_id: "sd-1", clear_renewal_date: true })

    expect(res.renewal_date_cleared).toBe(true)
    expect(updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { annual_report_due_date: null } }),
    )
  })

  it("does NOT clear the renewal date when clear_renewal_date is not set", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
      notes: null,
    }
    acctRow = { ra_renewal_date: "2026-06-21" }

    const res = await deactivateSD({ delivery_id: "sd-1" })

    expect(res.renewal_date_cleared).toBe(false)
    expect(updateAccount).not.toHaveBeenCalled()
  })

  it("does not clear when the account renewal date is already null", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
      notes: null,
    }
    acctRow = { ra_renewal_date: null }

    const res = await deactivateSD({ delivery_id: "sd-1", clear_renewal_date: true })

    expect(res.renewal_date_cleared).toBe(false)
    expect(updateAccount).not.toHaveBeenCalled()
  })

  it("is a clean no-op when already cancelled", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax",
      status: "cancelled",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    const res = await deactivateSD({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("already_terminal")
    expect(capturedSDUpdate.patch).toBeNull()
    expect(updateTasksBulk).not.toHaveBeenCalled()
  })

  it("is a clean no-op when already completed", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "Tax Return",
      service_name: "Tax",
      status: "completed",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    const res = await deactivateSD({ delivery_id: "sd-1" })
    expect(res.outcome).toBe("already_terminal")
  })

  it("returns not_found when the SD does not exist", async () => {
    sdRow = null
    const res = await deactivateSD({ delivery_id: "missing" })
    expect(res.outcome).toBe("not_found")
  })

  it("returns stale when expected_updated_at does not match", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "2026-05-26T00:00:00Z",
    }
    const res = await deactivateSD({ delivery_id: "sd-1", expected_updated_at: "different" })
    expect(res.outcome).toBe("stale")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("returns stale when the guarded update matches 0 rows (concurrent change)", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    sdUpdateResult = null // update matched nothing
    const res = await deactivateSD({ delivery_id: "sd-1" })
    expect(res.outcome).toBe("stale")
    expect(updateTasksBulk).not.toHaveBeenCalled()
  })
})

// ─── reactivateSD ──────────────────────────────────────

describe("reactivateSD", () => {
  // Regression: reactivating a cancelled ITIN while the person holds an active
  // one used to hit the DB unique index inside dbWrite, which THROWS — the
  // typed result contract was bypassed and the CRM button died with no toast.
  // Refusing is correct; refusing invisibly is not.
  it("refuses with a plain message when the person already has an active per-person service", async () => {
    vi.mocked(isPerPersonServiceType).mockResolvedValue(true)
    sdRow = {
      id: "sd-cancelled",
      service_type: "ITIN",
      service_name: "ITIN",
      status: "cancelled",
      account_id: null,
      contact_id: "contact-1",
      updated_at: "2026-07-20T00:00:00Z",
      notes: null,
    }
    perPersonConflictRows = [{ id: "other-active-itin" }]

    const res = await reactivateSD({ delivery_id: "sd-cancelled" })

    expect(res.success).toBe(false)
    expect(res.outcome).toBe("conflict")
    expect(res.error).toMatch(/already has a live ITIN/i)
    // it must NOT have attempted the status flip
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("still reactivates a per-person service when no other active one exists", async () => {
    vi.mocked(isPerPersonServiceType).mockResolvedValue(true)
    sdRow = {
      id: "sd-cancelled",
      service_type: "ITIN",
      service_name: "ITIN",
      status: "cancelled",
      account_id: null,
      contact_id: "contact-1",
      updated_at: "2026-07-20T00:00:00Z",
      notes: null,
    }
    perPersonConflictRows = [] // no competing active ITIN

    const res = await reactivateSD({ delivery_id: "sd-cancelled" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("reactivated")
    expect(capturedSDUpdate.patch?.status).toBe("active")
  })

  it("reactivates a cancelled service and creates a fresh tracked task", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "cancelled",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    const res = await reactivateSD({ delivery_id: "sd-1" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("reactivated")
    expect(res.task_created).toBe(true)
    expect(res.renewal_date_empty).toBe(false)
    expect(capturedSDUpdate.patch?.status).toBe("active")
    expect(capturedSDUpdate.patch?.end_date).toBeNull()
    expect(capturedTaskInsert?.delivery_id).toBe("sd-1")
    // tasks.attachments is NOT NULL with no DB default — the insert MUST set it
    // (regression guard: a real sandbox 23502 was caught here on 2026-05-26).
    expect(capturedTaskInsert?.attachments).toEqual([])
    expect(logAction).toHaveBeenCalled()
  })

  it("warns when a renewal service is reactivated but the account date is empty", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      status: "cancelled",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    acctRow = { ra_renewal_date: null }
    const res = await reactivateSD({ delivery_id: "sd-1" })
    expect(res.success).toBe(true)
    expect(res.renewal_date_empty).toBe(true)
  })

  it("does not warn when the renewal date is present", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "State RA Renewal",
      service_name: "RA Renewal",
      status: "cancelled",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    acctRow = { ra_renewal_date: "2026-06-21" }
    const res = await reactivateSD({ delivery_id: "sd-1" })
    expect(res.renewal_date_empty).toBe(false)
  })

  it("is a no-op when the service is not cancelled", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "active",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "t",
    }
    const res = await reactivateSD({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("not_cancelled")
    expect(capturedSDUpdate.patch).toBeNull()
  })

  it("returns not_found when the SD does not exist", async () => {
    sdRow = null
    const res = await reactivateSD({ delivery_id: "missing" })
    expect(res.outcome).toBe("not_found")
  })

  it("returns stale when expected_updated_at does not match", async () => {
    sdRow = {
      id: "sd-1",
      service_type: "CMRA Mailing Address",
      service_name: "CMRA",
      status: "cancelled",
      account_id: "acct-1",
      contact_id: null,
      updated_at: "2026-05-26T00:00:00Z",
    }
    const res = await reactivateSD({ delivery_id: "sd-1", expected_updated_at: "different" })
    expect(res.outcome).toBe("stale")
    expect(capturedSDUpdate.patch).toBeNull()
  })
})
