/**
 * Slice 8 Pass 6 — banking.approve_form handler unit tests
 *
 * Covers the unified banking handler that reads handler_params.followup_task
 * from the catalog row (provider-specific copy as DATA, not code).
 *
 * Cases:
 *   - handler_params missing followup_task → clean error
 *   - handler_params present but malformed → clean error
 *   - title_template references a token missing from task_meta → loud failure
 *   - approveAndApplyBankingReview returns alreadyApplied → no follow-up spawn
 *   - approveAndApplyBankingReview fails → handler fails
 *   - happy path: spawns follow-up task with interpolated title/description
 *   - preview mode: no side effects
 *   - dedup: existing task with same title → skipped (no duplicate insert)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mocks for the operations helper ─────────────────────────────────────

let helperReturn: {
  ok: boolean
  alreadyApplied?: boolean
  provider?: string
  services_update?: string
  services_update_error?: string
  error?: string
} = { ok: true, services_update: "no_row", provider: "payset" }

vi.mock("@/lib/operations/banking-review", () => ({
  approveAndApplyBankingReview: vi.fn(async () => helperReturn),
}))

// ─── Mocks for supabase ──────────────────────────────────────────────────

let existingTaskRow: { id: string } | null = null
let insertReturnRow: { id: string } | null = { id: "new-task-id" }
let insertError: { message: string } | null = null

const insertCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      const chain: Record<string, unknown> = {}
      let pendingInsert: Record<string, unknown> | null = null

      Object.assign(chain, {
        select: vi.fn(() => chain),
        insert: vi.fn((payload: Record<string, unknown>) => {
          pendingInsert = payload
          return chain
        }),
        update: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        single: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingInsert) {
          insertCalls.push(pendingInsert)
          const data = insertError ? null : insertReturnRow
          const result = { data, error: insertError }
          pendingInsert = null
          return result
        }
        // Read path — tasks dedup lookup
        return { data: existingTaskRow, error: null }
      }
      return chain
    },
  },
}))

import { bankingApproveForm } from "@/lib/tasks/workflow-handlers/banking-approve-form"
import type { HandlerContext } from "@/lib/tasks/types"

// ─── Test fixtures ───────────────────────────────────────────────────────

const validHandlerParams = {
  followup_task: {
    title_template: "Schedule Payset session — {company_name}",
    description_template: "Payset for {company_name} reviewed. Token {token}.",
    assignee: "Luca",
    priority: "High",
    category: "Banking",
  },
}

// Sentinel used to distinguish "key omitted from overrides" (use default) from
// "key explicitly set to undefined" (pass undefined to the handler). The ??
// operator cannot make this distinction.
const USE_DEFAULT = Symbol("USE_DEFAULT")

function makeCtx(overrides: {
  handler_params?: unknown | typeof USE_DEFAULT
  task_meta?: Record<string, unknown>
  mode?: "execute" | "preview"
} = {}): HandlerContext {
  const handlerParams = "handler_params" in overrides ? overrides.handler_params : validHandlerParams
  const meta = overrides.task_meta ?? {
    submission_id: "11111111-1111-1111-1111-111111111111",
    provider: "payset",
    account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    contact_id: null,
    token: "tk-1",
    company_name: "ACME LLC",
  }
  return {
    task: {
      id: "task-1",
      account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      contact_id: null,
      delivery_id: null,
      task_meta: meta,
    } as unknown as HandlerContext["task"],
    workflow: { slug: "banking_review_payset" } as unknown as HandlerContext["workflow"],
    action: {
      slug: "approve_and_apply",
      handler: "banking.approve_form",
      handler_params: handlerParams,
    } as unknown as HandlerContext["action"],
    params: {},
    actor: { id: "actor-1" } as unknown as HandlerContext["actor"],
    idempotencyKey: "idem-1",
    serviceCatalog: null,
    supabase: {} as unknown as HandlerContext["supabase"],
    mode: overrides.mode ?? "execute",
  }
}

beforeEach(() => {
  helperReturn = { ok: true, services_update: "no_row", provider: "payset" }
  existingTaskRow = null
  insertReturnRow = { id: "new-task-id" }
  insertError = null
  insertCalls.length = 0
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe("banking.approve_form handler", () => {
  it("returns error when handler_params is missing", async () => {
    const result = await bankingApproveForm(makeCtx({ handler_params: undefined }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("HANDLER_PARAMS_INVALID")
  })

  it("returns error when handler_params lacks followup_task", async () => {
    const result = await bankingApproveForm(makeCtx({ handler_params: { other: "thing" } }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("HANDLER_PARAMS_INVALID")
  })

  it("returns error when followup_task is missing required fields", async () => {
    const result = await bankingApproveForm(
      makeCtx({
        handler_params: {
          followup_task: { title_template: "x" /* missing other fields */ },
        },
      }),
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("HANDLER_PARAMS_INVALID")
  })

  it("preview mode: no side effects, returns preview payload", async () => {
    const result = await bankingApproveForm(makeCtx({ mode: "preview" }))
    expect(result.success).toBe(true)
    expect(insertCalls.length).toBe(0)
    expect(result.side_effects.some((s) => s.kind === "task.spawn.preview")).toBe(true)
    expect(result.preview?.portal_message).toContain("ACME LLC")
  })

  it("propagates helper error as handler failure", async () => {
    helperReturn = { ok: false, error: "DB connection refused" }
    const result = await bankingApproveForm(makeCtx())
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("BANKING_REVIEW_APPLY_FAILED")
    expect(result.error?.message).toMatch(/DB connection refused/)
    expect(insertCalls.length).toBe(0)
  })

  it("alreadyApplied: no follow-up spawn, returns success with marker", async () => {
    helperReturn = { ok: true, alreadyApplied: true, provider: "payset", services_update: "no_row" }
    const result = await bankingApproveForm(makeCtx())
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "submission.review.already_applied")).toBe(true)
    expect(insertCalls.length).toBe(0)
    expect(result.result?.already_applied).toBe(true)
  })

  it("happy path: spawns follow-up with interpolated title/description from handler_params", async () => {
    helperReturn = { ok: true, services_update: "updated", provider: "payset" }
    existingTaskRow = null
    const result = await bankingApproveForm(makeCtx())

    expect(result.success).toBe(true)
    expect(insertCalls.length).toBe(1)
    expect(insertCalls[0].task_title).toBe("Schedule Payset session — ACME LLC")
    expect(insertCalls[0].description).toBe("Payset for ACME LLC reviewed. Token tk-1.")
    expect(insertCalls[0].assigned_to).toBe("Luca")
    expect(insertCalls[0].priority).toBe("High")
    expect(insertCalls[0].category).toBe("Banking")
    expect(result.side_effects.some((s) => s.kind === "task.spawned")).toBe(true)
  })

  it("uses different copy when handler_params switches templates (Relay variant)", async () => {
    const relayParams = {
      followup_task: {
        title_template: "Submit Relay — {company_name}",
        description_template: "Relay app submission for {company_name}.",
        assignee: "Antonio",
        priority: "Urgent",
        category: "Banking",
      },
    }
    const result = await bankingApproveForm(makeCtx({ handler_params: relayParams }))
    expect(result.success).toBe(true)
    expect(insertCalls[0].task_title).toBe("Submit Relay — ACME LLC")
    expect(insertCalls[0].assigned_to).toBe("Antonio")
    expect(insertCalls[0].priority).toBe("Urgent")
  })

  it("dedup: existing task with same title → no duplicate insert", async () => {
    existingTaskRow = { id: "existing-task-id" }
    const result = await bankingApproveForm(makeCtx())
    expect(result.success).toBe(true)
    expect(insertCalls.length).toBe(0)
    expect(result.side_effects.some((s) => s.kind === "task.spawn.skipped")).toBe(true)
  })

  it("missing token in task_meta → soft warning, helper already applied (no rollback)", async () => {
    // Remove company_name from meta — title_template references {company_name}
    const result = await bankingApproveForm(
      makeCtx({
        task_meta: {
          submission_id: "11111111-1111-1111-1111-111111111111",
          provider: "payset",
          account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          contact_id: null,
          token: "tk-1",
          // company_name missing
        },
      }),
    )
    // Helper already ran (ok=true above) — handler returns success with
    // task.spawn.failed side effect rather than rolling back the apply.
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "task.spawn.failed")).toBe(true)
    expect(insertCalls.length).toBe(0)
    expect(result.result?.followup_skipped).toBe(true)
  })

  it("services update error surfaced but does not fail the handler", async () => {
    helperReturn = {
      ok: true,
      services_update: "error",
      services_update_error: "RLS denied",
      provider: "payset",
    }
    const result = await bankingApproveForm(makeCtx())
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "services.update.error")).toBe(true)
    // Follow-up still spawned
    expect(insertCalls.length).toBe(1)
  })
})
