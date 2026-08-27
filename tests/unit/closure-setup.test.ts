import { describe, it, expect, vi, beforeEach } from "vitest"

// Independent post-build review (Senior Engineer + Bug Hunter, both run at
// Antonio's request) found the handler never reported ok:false on ANY
// failure path — a closure job that actually failed was still marked
// "completed" in job_queue, defeating both retry and the Exception Center's
// Silent-Failed-Jobs detection. Mocking the delegated route lets these
// branches be pinned without dragging in Drive/Gmail/DB.
const mockPost = vi.fn()
vi.mock("@/app/api/closure-form-completed/route", () => ({
  POST: (...args: unknown[]) => mockPost(...args),
}))

function makeJob(payload: Record<string, unknown>) {
  return {
    id: "test-job-id",
    job_type: "closure_setup",
    payload,
    status: "processing",
    priority: 3,
    result: null,
    error: null,
    attempts: 1,
    max_attempts: 3,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    created_by: "test",
    account_id: null,
    lead_id: null,
    related_entity_type: null,
    related_entity_id: null,
  }
}

describe("closure-setup handler — ok flag (dev job fbbf4abe, post-build review fix)", () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it("reports ok:false when the delegated route itself fails (non-2xx or body.ok:false)", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    mockPost.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    })
    const result = await handleClosureSetup(makeJob({ token: "t1", submission_id: "s1" }) as never)
    expect(result.ok).toBe(false)
  })

  it("reports ok:false when the route answers 200/ok:true but an internal step actually errored", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    mockPost.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        results: [
          { step: "sd_created", status: "ok" },
          { step: "drive_save", status: "error", detail: "Drive API blip" },
        ],
      }),
    })
    const result = await handleClosureSetup(makeJob({ token: "t1", submission_id: "s1" }) as never)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/1 error/)
  })

  it("reports ok:true (not false) when every step succeeds", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    mockPost.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        results: [{ step: "sd_created", status: "ok" }],
      }),
    })
    const result = await handleClosureSetup(makeJob({ token: "t1", submission_id: "s1" }) as never)
    expect(result.ok).toBe(true)
  })

  it("reports ok:false when invoking the route throws", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    mockPost.mockRejectedValue(new Error("network blip"))
    const result = await handleClosureSetup(makeJob({ token: "t1", submission_id: "s1" }) as never)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/threw/)
  })
})

describe("closure-setup handler", () => {
  it("module exports handleClosureSetup function", async () => {
    // Smoke test: the module loads and exports the handler (matches the
    // established pattern in itin-wizard-setup.test.ts).
    const mod = await import("@/lib/jobs/handlers/closure-setup")
    expect(typeof mod.handleClosureSetup).toBe("function")
  })

  it("is registered in the job handler registry under closure_setup", async () => {
    const { getJobHandler, getRegisteredJobTypes } = await import("@/lib/jobs/registry")
    const handler = getJobHandler("closure_setup")
    expect(typeof handler).toBe("function")
    expect(getRegisteredJobTypes()).toContain("closure_setup")
  })

  it("returns a validation error step when payload is missing submission_id", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    const result = await handleClosureSetup({
      id: "test-job-id",
      job_type: "closure_setup",
      payload: { token: "portal-test-2026" }, // missing submission_id
      status: "processing",
      priority: 3,
      result: null,
      error: null,
      attempts: 1,
      max_attempts: 3,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
      created_by: "test",
      account_id: null,
      lead_id: null,
      related_entity_type: null,
      related_entity_id: null,
    })
    expect(result.steps.length).toBeGreaterThan(0)
    expect(result.steps[0].name).toBe("validate_payload")
    expect(result.steps[0].status).toBe("error")
    expect(result.summary).toMatch(/invalid payload/)
    expect(result.ok).toBe(false)
  })

  it("returns a validation error step when payload is missing token", async () => {
    const { handleClosureSetup } = await import("@/lib/jobs/handlers/closure-setup")
    const result = await handleClosureSetup({
      id: "test-job-id",
      job_type: "closure_setup",
      payload: { submission_id: "uuid-1" }, // missing token
      status: "processing",
      priority: 3,
      result: null,
      error: null,
      attempts: 1,
      max_attempts: 3,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
      created_by: "test",
      account_id: null,
      lead_id: null,
      related_entity_type: null,
      related_entity_id: null,
    })
    expect(result.steps[0].status).toBe("error")
    expect(result.steps[0].detail).toMatch(/token/)
  })
})
