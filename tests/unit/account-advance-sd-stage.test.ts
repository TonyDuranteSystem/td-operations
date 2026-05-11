/**
 * Unit tests for app/(dashboard)/accounts/[id]/actions.ts::advanceSDStage.
 *
 * Covers: unauthorized, SD not found, optimistic-lock failure on stale
 * updated_at, status guards (completed/cancelled/on_hold), happy-path call
 * to advanceServiceDelivery, and error propagation when the underlying
 * helper throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface SDRow {
  id: string
  updated_at: string
  status: string
  stage: string | null
  account_id: string | null
  contact_id: string | null
}

let authUser: { id: string; email: string | null } | null = null
let sdFixture: SDRow | null = null
let sdError: { message: string } | null = null
let advanceResult = {
  success: true,
  from_stage: "Data Collection",
  to_stage: "State Filing",
  to_order: 2,
  total_stages: 6,
  is_completed: false,
  created_tasks: ["task-1"],
  failed_tasks: [],
  auto_triggers: ["task created"],
}
let advanceShouldThrow: Error | null = null
let lastAdvanceArgs: Record<string, unknown> | null = null
const revalidatePathCalls: string[] = []

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path)
  },
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({ data: { user: authUser }, error: null }),
      ),
    },
  }),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (_table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: sdFixture, error: sdError }),
      ),
    }),
  },
}))

vi.mock("@/lib/service-delivery", () => ({
  advanceServiceDelivery: vi.fn((params: Record<string, unknown>) => {
    lastAdvanceArgs = params
    if (advanceShouldThrow) throw advanceShouldThrow
    return Promise.resolve(advanceResult)
  }),
}))

// Import after mocks are registered.
import { advanceSDStage } from "@/app/(dashboard)/accounts/[id]/actions"

beforeEach(() => {
  authUser = { id: "user-1", email: "admin@tonydurante.us" }
  sdFixture = {
    id: "sd-1",
    updated_at: "2026-05-11T10:00:00.000Z",
    status: "active",
    stage: "Data Collection",
    account_id: "acct-1",
    contact_id: "contact-1",
  }
  sdError = null
  advanceShouldThrow = null
  lastAdvanceArgs = null
  revalidatePathCalls.length = 0
  advanceResult = {
    success: true,
    from_stage: "Data Collection",
    to_stage: "State Filing",
    to_order: 2,
    total_stages: 6,
    is_completed: false,
    created_tasks: ["task-1"],
    failed_tasks: [],
    auto_triggers: ["task created"],
  }
})

describe("advanceSDStage", () => {
  it("rejects when user is not authenticated", async () => {
    authUser = null
    const result = await advanceSDStage("sd-1", "2026-05-11T10:00:00.000Z")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Unauthorized")
    expect(lastAdvanceArgs).toBeNull()
  })

  it("returns not-found when SD lookup yields no row", async () => {
    sdFixture = null
    const result = await advanceSDStage("sd-x", "2026-05-11T10:00:00.000Z")
    expect(result.success).toBe(false)
    expect(result.error).toBe("Service delivery not found")
    expect(lastAdvanceArgs).toBeNull()
  })

  it("rejects when updated_at no longer matches (optimistic-lock)", async () => {
    const result = await advanceSDStage("sd-1", "1999-01-01T00:00:00.000Z")
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/updated/i)
    expect(lastAdvanceArgs).toBeNull()
  })

  it.each([
    ["completed", "Service is already completed."],
    ["cancelled", "Service is cancelled."],
    ["on_hold", "Service is on hold. Resume it before advancing."],
  ])("rejects when SD status is %s", async (status, expectedError) => {
    sdFixture = { ...sdFixture!, status }
    const result = await advanceSDStage(
      "sd-1",
      sdFixture!.updated_at,
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(expectedError)
    expect(lastAdvanceArgs).toBeNull()
  })

  it("calls advanceServiceDelivery with dashboard actor and revalidates both pages", async () => {
    const result = await advanceSDStage(
      "sd-1",
      sdFixture!.updated_at,
      "State Filing",
    )
    expect(result.success).toBe(true)
    expect(result.from_stage).toBe("Data Collection")
    expect(result.to_stage).toBe("State Filing")
    expect(result.auto_triggers).toEqual(["task created"])
    expect(result.created_tasks).toEqual(["task-1"])

    expect(lastAdvanceArgs).toEqual({
      delivery_id: "sd-1",
      target_stage: "State Filing",
      actor: "dashboard:admin",
    })

    expect(revalidatePathCalls).toContain("/accounts/acct-1")
    expect(revalidatePathCalls).toContain("/contacts/contact-1")
  })

  it("revalidates only the contact page when account_id is null", async () => {
    sdFixture = { ...sdFixture!, account_id: null }
    await advanceSDStage("sd-1", sdFixture!.updated_at)
    expect(revalidatePathCalls).toEqual(["/contacts/contact-1"])
  })

  it("returns the error message when advanceServiceDelivery throws", async () => {
    advanceShouldThrow = new Error("pipeline_stages missing for Foo")
    const result = await advanceSDStage("sd-1", sdFixture!.updated_at)
    expect(result.success).toBe(false)
    expect(result.error).toBe("pipeline_stages missing for Foo")
  })

  it("forwards is_completed=true on terminal advance", async () => {
    advanceResult = {
      ...advanceResult,
      to_stage: "Closing",
      is_completed: true,
      auto_triggers: ["service completed"],
    }
    const result = await advanceSDStage("sd-1", sdFixture!.updated_at)
    expect(result.success).toBe(true)
    expect(result.is_completed).toBe(true)
    expect(result.to_stage).toBe("Closing")
  })
})
