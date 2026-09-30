/**
 * Unit tests for cancelLeaseDraft() in lib/operations/lease.ts
 *
 * Covers: lease-not-found / refuses any non-draft status (the safety guard) /
 * happy-path draft delete / TOCTOU (delete affected nothing) / cancelling a draft
 * never touches the company's locked suite or address.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

interface State {
  leaseRow: Record<string, unknown> | null
  deletedRows: Array<{ id: string }>
  delError: { message: string } | null
  acct: { physical_address: string | null } | null
  remaining: Array<{ suite_number: string }>
  accountUpdate: Record<string, unknown> | undefined
  suiteUpdate: Record<string, unknown> | undefined // the "Suite Assigned" release
  otherLeases: Array<{ id: string }>
}

let state: State
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const ctx: { op: string; selectCols: string; payload: Record<string, unknown> | null } = {
        op: "select",
        selectCols: "",
        payload: null,
      }
      const result = () => {
        if (table === "lease_agreements") {
          if (ctx.op === "delete") return { data: state.deletedRows, error: state.delError }
          if (ctx.selectCols.includes("status") && ctx.selectCols.includes("suite_number")) {
            return { data: state.leaseRow, error: null }
          }
          if (ctx.selectCols === "id") return { data: state.otherLeases, error: null } // any-other-lease read
          return { data: state.remaining, error: null } // remaining-suite read
        }
        if (table === "accounts") {
          if (ctx.op === "update") {
            if (ctx.payload && "suite_number" in ctx.payload) state.suiteUpdate = ctx.payload
            else state.accountUpdate = ctx.payload ?? undefined
            return { data: null, error: null }
          }
          return { data: state.acct, error: null }
        }
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: (cols: string) => {
          if (ctx.op !== "delete") ctx.op = "select"
          ctx.selectCols = cols
          return chain
        },
        delete: () => {
          ctx.op = "delete"
          return chain
        },
        update: (payload: Record<string, unknown>) => {
          ctx.op = "update"
          ctx.payload = payload
          return chain
        },
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown) => resolve(result()),
      })
      return chain
    },
  },
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: (params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  },
}))

// ─── Import under test (after mocks) ─────────────────────

import { cancelLeaseDraft } from "@/lib/operations/lease"

beforeEach(() => {
  state = {
    leaseRow: null,
    deletedRows: [],
    delError: null,
    acct: null,
    remaining: [],
    accountUpdate: undefined,
    suiteUpdate: undefined,
    otherLeases: [],
  }
  actionLogCalls.length = 0
})

// ─── Tests ───────────────────────────────────────────────

describe("cancelLeaseDraft", () => {
  it("returns not-found when the token matches no lease", async () => {
    state.leaseRow = null
    const res = await cancelLeaseDraft("nope-2026")
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(actionLogCalls).toHaveLength(0)
  })

  it("refuses to cancel a lease that is not a draft (sent/viewed/signed)", async () => {
    for (const status of ["sent", "viewed", "signed"]) {
      state.leaseRow = { id: "L1", status, tenant_company: "Acme LLC", account_id: "A1", contract_year: 2026, suite_number: "3D-113" }
      const res = await cancelLeaseDraft("acme-2026")
      expect(res.success).toBe(false)
      expect(res.error).toContain(status)
    }
    expect(actionLogCalls).toHaveLength(0)
  })

  it("deletes a draft and logs it (no suite → no address touch)", async () => {
    state.leaseRow = { id: "L1", status: "draft", tenant_company: "Acme LLC", account_id: "A1", contract_year: 2026, suite_number: null }
    state.deletedRows = [{ id: "L1" }]
    const res = await cancelLeaseDraft("acme-2026")
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/cancelled/i)
    expect(actionLogCalls).toHaveLength(1)
    expect(actionLogCalls[0].action_type).toBe("delete")
    expect(state.accountUpdate).toBeUndefined()
  })

  it("reports honestly when the conditional delete affected nothing (lost TOCTOU race)", async () => {
    state.leaseRow = { id: "L1", status: "draft", tenant_company: "Acme LLC", account_id: "A1", contract_year: 2026, suite_number: "3D-113" }
    state.deletedRows = [] // status flipped out of draft between read and delete
    const res = await cancelLeaseDraft("acme-2026")
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no longer a draft/i)
    expect(actionLogCalls).toHaveLength(0)
  })

  it("never touches the company's suite or address when a draft is cancelled — the suite is locked (only the owner's admin change releases it)", async () => {
    for (const other of [[], [{ id: "older-lease" }]]) {
      state.accountUpdate = undefined
      state.suiteUpdate = undefined
      state.leaseRow = { id: "L1", status: "draft", tenant_company: "Acme LLC", account_id: "A1", contract_year: 2026, suite_number: "3D-113" }
      state.deletedRows = [{ id: "L1" }]
      state.acct = { physical_address: "10225 Ulmerton Rd, Suite 3D-113, Largo, FL 33771" }
      state.otherLeases = other
      state.remaining = other.length ? [{ suite_number: "3D-113" }] : []
      const res = await cancelLeaseDraft("acme-2026")
      expect(res.success).toBe(true)
      expect(state.accountUpdate).toBeUndefined()
      expect(state.suiteUpdate).toBeUndefined()
    }
  })
})
