import { describe, it, expect } from "vitest"

describe("itin-wizard-setup handler", () => {
  it("module exports handleItinWizardSetup function", async () => {
    // Smoke test: the module loads and exports the handler
    // (matches the established pattern in tax-return-intake.test.ts).
    const mod = await import("@/lib/jobs/handlers/itin-wizard-setup")
    expect(typeof mod.handleItinWizardSetup).toBe("function")
  })

  it("is registered in the job handler registry under itin_wizard_setup", async () => {
    const { getJobHandler, getRegisteredJobTypes } = await import("@/lib/jobs/registry")
    const handler = getJobHandler("itin_wizard_setup")
    expect(typeof handler).toBe("function")
    expect(getRegisteredJobTypes()).toContain("itin_wizard_setup")
  })

  it("returns a validation error step when payload is missing submission_id", async () => {
    // Pure unit test: invalid payload returns a validation error without
    // touching the DB, gmail, or Drive. Does not exercise the happy path
    // (which requires real supabase/gmail/drive clients).
    const { handleItinWizardSetup } = await import("@/lib/jobs/handlers/itin-wizard-setup")
    const result = await handleItinWizardSetup({
      id: "test-job-id",
      job_type: "itin_wizard_setup",
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
    const { handleItinWizardSetup } = await import("@/lib/jobs/handlers/itin-wizard-setup")
    const result = await handleItinWizardSetup({
      id: "test-job-id",
      job_type: "itin_wizard_setup",
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

// Note: a direct test of the private getSubmissionTable/getJobType functions
// in wizard-submit/route.ts is not feasible because (a) they are not
// exported and (b) importing the route pulls in next/server which needs
// Next.js's dev/test runtime. The runtime smoke for this path is the
// Phase 0 pre-rescue verification gate (post-deploy curl + a disposable
// portal ITIN submission).
