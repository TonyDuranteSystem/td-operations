/**
 * Unit tests for failJob's client-notification hook (lib/jobs/queue.ts).
 *
 * Verifies that the wizard failure notification:
 *  - fires once when a job transitions into status='failed' (final attempt)
 *  - does NOT fire on a retry (attempts < max_attempts)
 *  - does NOT fire when the TOCTOU guard returns no transitioned row
 *    (someone else already flipped the job to failed)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface Fixtures {
  jobRow: {
    attempts: number
    max_attempts: number
    job_type: string
    account_id: string | null
    payload: Record<string, unknown>
  }
  transitioned: Array<{ id: string }>
}
const fixtures: Fixtures = {
  jobRow: { attempts: 2, max_attempts: 3, job_type: "tax_form_setup", account_id: "acc-1", payload: {} },
  transitioned: [{ id: "job-1" }],
}

function makeBuilder() {
  const state = { isUpdate: false }
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.neq = chain
  b.update = () => {
    state.isUpdate = true
    return b
  }
  b.single = async () =>
    state.isUpdate ? { data: fixtures.transitioned, error: null } : { data: fixtures.jobRow, error: null }
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(
      state.isUpdate ? { data: fixtures.transitioned, error: null } : { data: fixtures.jobRow, error: null },
    ).then(onFulfilled)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => makeBuilder() },
}))

const notifyMock = vi.fn(async () => ({ notified: true }))
vi.mock("@/lib/jobs/wizard-failure-notify", () => ({
  notifyClientOfWizardJobFailure: (...args: unknown[]) => notifyMock(...args),
}))

import { failJob } from "@/lib/jobs/queue"

beforeEach(() => {
  notifyMock.mockClear()
  fixtures.jobRow = { attempts: 2, max_attempts: 3, job_type: "tax_form_setup", account_id: "acc-1", payload: {} }
  fixtures.transitioned = [{ id: "job-1" }]
})

describe("failJob → client notification", () => {
  it("notifies the client once on the final-failure transition", async () => {
    await failJob("job-1", "boom")
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith({
      id: "job-1",
      job_type: "tax_form_setup",
      account_id: "acc-1",
      payload: {},
    })
  })

  it("does NOT notify on a retry (attempts below max)", async () => {
    fixtures.jobRow = { ...fixtures.jobRow, attempts: 0, max_attempts: 3 }
    await failJob("job-1", "transient")
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("does NOT notify when the TOCTOU guard returns no transitioned row", async () => {
    fixtures.transitioned = [] // job was already 'failed' — guard excluded it
    await failJob("job-1", "boom")
    expect(notifyMock).not.toHaveBeenCalled()
  })
})
