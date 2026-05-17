/**
 * Slice 9 — sd.mark_complete handler unit tests
 *
 * Generic primitive used by closure_progress, formation_progress, and
 * onboarding_progress final actions. Parameterized by handler_params
 * (spawn_next_sds + send_review_request) so a new SD-lifecycle workflow
 * gets the same closing behavior via SQL only.
 *
 * Cases:
 *   - missing delivery_id → clean error
 *   - preview mode → no side effects, preview payload
 *   - happy path: SD closed, next SDs spawned
 *   - already-completed SD → no_op
 *   - duplicate spawn protection (existing active SD of same type → skipped)
 *   - send_review_request notification path
 *   - empty spawn_next_sds (closure case) → only closes SD
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let sdRow: {
  status: string
  end_date: string | null
  account_id: string | null
  contact_id: string | null
} | null = null
let existingSdMap: Record<string, { id: string } | null> = {}
let createSdShouldThrow: string | null = null
let portalNotifyShouldThrow = false

const createSdCalls: Array<Record<string, unknown>> = []
const updateCalls: Array<{ table: string; payload: Record<string, unknown> }> = []
const portalNotifyCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      let pendingUpdate: Record<string, unknown> | null = null
      let pendingSelect = ""
      const filters: Record<string, string> = {}

      Object.assign(chain, {
        select: vi.fn((cols: string) => {
          pendingSelect = cols
          return chain
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          pendingUpdate = payload
          return chain
        }),
        eq: vi.fn((col: string, value: string) => {
          filters[col] = value
          return chain
        }),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        single: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate })
          pendingUpdate = null
          return { data: null, error: null }
        }
        // Read path
        if (table === "service_deliveries") {
          // Two read patterns: load by id (returns sdRow) OR look up active SD by type (returns existingSdMap)
          if (filters.service_type) {
            return { data: existingSdMap[filters.service_type] ?? null, error: null }
          }
          return { data: sdRow, error: null }
        }
        void pendingSelect
        return { data: null, error: null }
      }
      return chain
    },
  },
}))

vi.mock("@/lib/operations/service-delivery", () => ({
  createSD: vi.fn(async (params: Record<string, unknown>) => {
    createSdCalls.push(params)
    if (createSdShouldThrow) throw new Error(createSdShouldThrow)
    return {
      id: `new-sd-${createSdCalls.length}`,
      service_type: params.service_type as string,
      service_name: (params.service_type as string),
      stage: "Stage 1",
      stage_order: 1,
      account_id: (params.account_id as string) ?? null,
      contact_id: (params.contact_id as string) ?? null,
    }
  }),
}))

vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: vi.fn(async (args: Record<string, unknown>) => {
    portalNotifyCalls.push(args)
    if (portalNotifyShouldThrow) throw new Error("portal notify failed")
    return { id: "notif-1" }
  }),
}))

import { sdMarkComplete } from "@/lib/tasks/workflow-handlers/sd-mark-complete"
import type { HandlerContext } from "@/lib/tasks/types"

function makeCtx(over: {
  handler_params?: Record<string, unknown>
  delivery_id?: string | null
  account_id?: string | null
  mode?: "execute" | "preview"
} = {}): HandlerContext {
  return {
    task: {
      id: "task-1",
      account_id: over.account_id === undefined ? "11111111-1111-4111-8111-111111111111" : over.account_id,
      contact_id: null,
      delivery_id: over.delivery_id === undefined ? "22222222-2222-4222-8222-222222222222" : over.delivery_id,
      task_meta: {},
    } as unknown as HandlerContext["task"],
    workflow: { slug: "closure_progress", default_assignee: "Luca" } as unknown as HandlerContext["workflow"],
    action: {
      slug: "mark_complete",
      handler: "sd.mark_complete",
      handler_params: over.handler_params ?? {},
    } as unknown as HandlerContext["action"],
    params: {},
    actor: { id: "actor-1" } as unknown as HandlerContext["actor"],
    idempotencyKey: "idem-1",
    serviceCatalog: null,
    supabase: {} as unknown as HandlerContext["supabase"],
    mode: over.mode ?? "execute",
  }
}

beforeEach(() => {
  sdRow = {
    status: "active",
    end_date: null,
    account_id: "11111111-1111-4111-8111-111111111111",
    contact_id: null,
  }
  existingSdMap = {}
  createSdShouldThrow = null
  portalNotifyShouldThrow = false
  createSdCalls.length = 0
  updateCalls.length = 0
  portalNotifyCalls.length = 0
})

describe("sd.mark_complete handler", () => {
  it("errors when delivery_id is missing", async () => {
    const result = await sdMarkComplete(makeCtx({ delivery_id: null }))
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe("NO_DELIVERY")
  })

  it("preview mode: no side effects, returns preview payload", async () => {
    const result = await sdMarkComplete(
      makeCtx({
        mode: "preview",
        handler_params: { spawn_next_sds: ["State RA Renewal"], send_review_request: true },
      }),
    )
    expect(result.success).toBe(true)
    expect(updateCalls.length).toBe(0)
    expect(createSdCalls.length).toBe(0)
    expect(portalNotifyCalls.length).toBe(0)
    expect(result.side_effects.some((s) => s.kind === "sd.close.preview")).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "sd.spawn.preview")).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "review_request.preview")).toBe(true)
  })

  it("closure case (empty spawn list, no review): just closes SD", async () => {
    const result = await sdMarkComplete(makeCtx({ handler_params: {} }))
    expect(result.success).toBe(true)
    expect(createSdCalls.length).toBe(0)
    expect(portalNotifyCalls.length).toBe(0)
    expect(updateCalls.some((u) => u.table === "service_deliveries" && u.payload.status === "completed")).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "sd.closed")).toBe(true)
  })

  it("formation case: closes SD + spawns 2 next SDs + sends review", async () => {
    const result = await sdMarkComplete(
      makeCtx({
        handler_params: {
          spawn_next_sds: ["State RA Renewal", "State Annual Report"],
          send_review_request: true,
        },
      }),
    )
    expect(result.success).toBe(true)
    expect(createSdCalls.length).toBe(2)
    expect(createSdCalls[0].service_type).toBe("State RA Renewal")
    expect(createSdCalls[1].service_type).toBe("State Annual Report")
    expect(portalNotifyCalls.length).toBe(1)
    expect(result.side_effects.filter((s) => s.kind === "sd.spawned").length).toBe(2)
    expect(result.side_effects.some((s) => s.kind === "review_request.sent")).toBe(true)
  })

  it("dedup: existing active SD of same type → skipped (no duplicate spawn)", async () => {
    existingSdMap["State RA Renewal"] = { id: "existing-ra-sd" }
    const result = await sdMarkComplete(
      makeCtx({ handler_params: { spawn_next_sds: ["State RA Renewal"] } }),
    )
    expect(result.success).toBe(true)
    expect(createSdCalls.length).toBe(0)
    expect(result.side_effects.some((s) => s.kind === "sd.spawn.skipped")).toBe(true)
  })

  it("already-completed SD → no_op on close, still attempts spawn", async () => {
    sdRow = { status: "completed", end_date: "2026-05-01", account_id: "11111111-1111-4111-8111-111111111111", contact_id: null }
    const result = await sdMarkComplete(
      makeCtx({ handler_params: { spawn_next_sds: ["State RA Renewal"] } }),
    )
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "sd.close.no_op")).toBe(true)
    // Update was NOT called for the SD close
    expect(updateCalls.some((u) => u.payload.status === "completed")).toBe(false)
    // But spawn still ran
    expect(createSdCalls.length).toBe(1)
  })

  it("createSD failure surfaces but does not fail the whole handler", async () => {
    createSdShouldThrow = "pipeline_stages lookup failed"
    const result = await sdMarkComplete(
      makeCtx({ handler_params: { spawn_next_sds: ["NoSuchService"] } }),
    )
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "sd.spawn.failed")).toBe(true)
    // SD was still closed
    expect(result.side_effects.some((s) => s.kind === "sd.closed")).toBe(true)
  })

  it("portal notify failure surfaces but does not fail the whole handler", async () => {
    portalNotifyShouldThrow = true
    const result = await sdMarkComplete(
      makeCtx({ handler_params: { send_review_request: true } }),
    )
    expect(result.success).toBe(true)
    expect(result.side_effects.some((s) => s.kind === "review_request.failed")).toBe(true)
  })

  it("send_review_request=true with no account_id → skipped silently", async () => {
    sdRow = { status: "active", end_date: null, account_id: null, contact_id: "33333333-3333-4333-8333-333333333333" }
    const result = await sdMarkComplete(
      makeCtx({ account_id: null, handler_params: { send_review_request: true } }),
    )
    expect(result.success).toBe(true)
    expect(portalNotifyCalls.length).toBe(0)
    expect(result.side_effects.some((s) => s.kind === "review_request.sent")).toBe(false)
  })
})
