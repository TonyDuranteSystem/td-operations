/**
 * Regression test — the portal wizard-submit route must return 200 IMMEDIATELY,
 * without awaiting the heavy background handler.
 *
 * This is the guard against re-introducing the false "Submission failed" toast
 * (Daniel Pasztor / Borisz / Zhang Holding): the route used to `await` the
 * handler inline (~10-30s of PDF/Drive/email work), so a dropped connection
 * showed an error screen even though the data was already saved.
 *
 * Strategy: stub `handleTaxFormSetup` with a promise that NEVER resolves. If the
 * route ever awaits it again, `POST` will hang and the race below rejects with a
 * clear message. The correct (fire-and-forget) route resolves 200 at once.
 */

import { describe, it, expect, vi } from "vitest"
import type { NextRequest } from "next/server"

// ── supabase admin: chainable builder that satisfies every call the route makes ──
function resolveFor(table: string) {
  if (table.endsWith("_submissions")) return { data: { id: "sub-1" }, error: null }
  if (table === "tax_returns") return { data: { tax_year: 2025 }, error: null }
  if (table === "job_queue")
    return { data: { id: "job-1", job_type: "tax_form_setup", payload: {} }, error: null }
  if (table === "accounts")
    return {
      data: { drive_folder_id: null, company_name: "Acme LLC", state_of_formation: "NM" },
      error: null,
    }
  return { data: null, error: null }
}
function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.is = chain
  b.order = chain
  b.limit = chain
  b.neq = chain
  b.update = chain
  b.insert = chain
  b.upsert = chain
  b.single = async () => resolveFor(table)
  b.maybeSingle = async () => resolveFor(table)
  b.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolveFor(table)).then(onFulfilled)
  return b
}
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u1", email: "client@example.com", user_metadata: {} } },
      }),
    },
  }),
}))

vi.mock("@/lib/auth", () => ({ isClient: () => true }))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: vi.fn(async () => ({ id: "job-1" })),
  completeJob: vi.fn(async () => {}),
  failJob: vi.fn(async () => {}),
}))

vi.mock("@/lib/jobs/validation", () => ({
  validateWizardData: () => ({ valid: true, errors: [] }),
}))

vi.mock("@/lib/portal/wizard-uploads", () => ({ collectUploadPaths: () => [] }))

vi.mock("@/lib/portal/resolve-portal-identity", () => ({
  resolvePortalIdentity: async () => ({ kind: "contact", contactId: "c1" }),
}))

vi.mock("@/lib/portal/wizard-submit-access", () => ({ canSubmitWizard: () => true }))
vi.mock("@/lib/portal/formation-lead-access", () => ({ formationLeadOwned: () => true }))

// The "slow handler": a promise that never resolves. If the route awaits it
// inline, POST never returns and the race rejects.
vi.mock("@/lib/jobs/handlers/tax-form-setup", () => ({
  handleTaxFormSetup: () => new Promise(() => {}),
}))

import { POST } from "@/app/api/portal/wizard-submit/route"

function req(body: Record<string, unknown>): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

async function postWithDeadline(body: Record<string, unknown>, ms = 2000) {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("route blocked: POST did not resolve — handler awaited inline?")), ms),
  )
  return Promise.race([POST(req(body)), timeout])
}

describe("wizard-submit returns 200 without blocking on the background handler", () => {
  it("tax: returns 200 even though the handler never resolves", async () => {
    const res = (await postWithDeadline({
      wizard_type: "tax",
      data: { company_name: "Acme LLC", state_of_formation: "NM" },
      account_id: "acc-1",
      contact_id: "c1",
      progress_id: "wp-1",
    })) as Response
    expect(res.status).toBe(200)
  })

  it("ITIN: returns 200 (enqueue-only, no inline handler)", async () => {
    const res = (await postWithDeadline({
      wizard_type: "itin",
      data: { company_name: "Acme LLC" },
      account_id: "acc-1",
      contact_id: "c1",
      progress_id: "wp-2",
    })) as Response
    expect(res.status).toBe(200)
  })

  it("formation: returns 200 (contact-scoped, enqueue-only)", async () => {
    const res = (await postWithDeadline({
      wizard_type: "formation",
      data: { company_name: "Acme LLC", state_of_formation: "NM" },
      contact_id: "c1",
      progress_id: "wp-3",
    })) as Response
    expect(res.status).toBe(200)
  })

  it("onboarding: returns 200 (enqueue-only)", async () => {
    const res = (await postWithDeadline({
      wizard_type: "onboarding",
      data: { company_name: "Acme LLC" },
      account_id: "acc-1",
      contact_id: "c1",
      progress_id: "wp-4",
    })) as Response
    expect(res.status).toBe(200)
  })
})
