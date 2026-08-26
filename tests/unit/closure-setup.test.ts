import { describe, it, expect } from "vitest"

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
