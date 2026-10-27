/**
 * Job f4f73e82 (2026-10-27): uploading the Articles for a formation whose state is recorded nowhere showed only
 * "Pick the state manually to continue" and a locked Confirm button — the check route had dropped `needs_state` /
 * `needs_entity_type`, so the window never showed its pickers. These tests pin the contract between the route that
 * sends the answer and the window that reads it, plus the fallback on `failure`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { buildPreflightResponseBody, pickersFromPreflight } from "@/lib/flows/materialize-preflight-response"
import type { FormationMaterializePreflightResult } from "@/lib/operations/formation-materialize"

const STATE_ERROR = "No formation state captured anywhere — not the client's questionnaire, the submitted form, or a signed contract. Pick the state manually to continue."

const noState: FormationMaterializePreflightResult = { ok: false, failure: "invalid_state", error: STATE_ERROR, chosen_name: "Tanto per LLC", needs_state: true, needs_entity_type: false }
const noEntity: FormationMaterializePreflightResult = { ok: false, failure: "missing_entity_type", error: "no entity type", chosen_name: "Acme LLC", needs_state: false, needs_entity_type: true }
const noBoth: FormationMaterializePreflightResult = { ok: false, failure: "invalid_state", error: `${STATE_ERROR} Also: no entity type`, chosen_name: "Acme LLC", needs_state: true, needs_entity_type: true }
const noName: FormationMaterializePreflightResult = { ok: false, failure: "missing_chosen_name", error: "Mark the state-approved name as filed first.", chosen_name: null }
const fine: FormationMaterializePreflightResult = { ok: true, chosen_name: "Acme LLC", state_code: "NM", state_source: "offer", entity_code: "SMLLC", entity_source: "contract" }

describe("buildPreflightResponseBody — the answer carries both flags (the regression)", () => {
  it("state missing: needs_state true, needs_entity_type false", () => {
    const b = buildPreflightResponseBody(noState, "Tanto per LLC")
    expect(b).toMatchObject({ success: true, applicable: true, ok: false, failure: "invalid_state", needs_state: true, needs_entity_type: false })
  })
  it("LLC type missing: needs_entity_type true", () => {
    expect(buildPreflightResponseBody(noEntity, "Acme LLC")).toMatchObject({ needs_state: false, needs_entity_type: true })
  })
  it("both missing: both flags true", () => {
    expect(buildPreflightResponseBody(noBoth, "Acme LLC")).toMatchObject({ needs_state: true, needs_entity_type: true })
  })
  it("everything resolved: both flags are explicit false (never undefined), and the resolved facts come through", () => {
    const b = buildPreflightResponseBody(fine, "Acme LLC")
    expect(b).toMatchObject({ ok: true, needs_state: false, needs_entity_type: false, state_code: "NM", state_source: "offer", entity_code: "SMLLC", failure: null, error: null })
  })
  it("falls back on the confirmed name when the check does not echo one", () => {
    expect(buildPreflightResponseBody({ ok: true }, "Filed Name LLC").chosen_name).toBe("Filed Name LLC")
    expect(buildPreflightResponseBody({ ok: true }, null).chosen_name).toBeNull()
  })
})

describe("pickersFromPreflight — what the Articles window shows", () => {
  it("state missing: the state picker shows, no blocking text", () => {
    expect(pickersFromPreflight(buildPreflightResponseBody(noState, "x"))).toEqual({ state: true, entityType: false, nameProblem: null, blocked: null })
  })
  it("LLC type missing: the LLC-type picker shows", () => {
    expect(pickersFromPreflight(buildPreflightResponseBody(noEntity, "x"))).toEqual({ state: false, entityType: true, nameProblem: null, blocked: null })
  })
  it("both missing: both pickers show together (fixing one must not just reveal the other)", () => {
    expect(pickersFromPreflight(buildPreflightResponseBody(noBoth, "x"))).toEqual({ state: true, entityType: true, nameProblem: null, blocked: null })
  })
  it("a problem no picker can fix (no filed name yet) is shown as text and the window stays locked", () => {
    const p = pickersFromPreflight(buildPreflightResponseBody(noName, null))
    expect(p.state).toBe(false)
    expect(p.entityType).toBe(false)
    expect(p.blocked).toContain("Mark the state-approved name")
  })
  it("a refusal with no message still produces some blocking text, never a silent pass", () => {
    expect(pickersFromPreflight({ applicable: true, ok: false, failure: "missing_submission" }).blocked).toBe("The company cannot be created yet.")
  })
  it("an answer WITHOUT the flags (the old broken shape) still gets the right picker from `failure`", () => {
    // exactly what the route used to send for Alessandro Girino's formation
    const old = { success: true, applicable: true, ok: false, failure: "invalid_state", error: STATE_ERROR } as never
    expect(pickersFromPreflight(old)).toEqual({ state: true, entityType: false, nameProblem: null, blocked: null })
    const oldEntity = { success: true, applicable: true, ok: false, failure: "missing_entity_type", error: "x" } as never
    expect(pickersFromPreflight(oldEntity)).toEqual({ state: false, entityType: true, nameProblem: null, blocked: null })
  })
  it("nothing to show when the check passes, does not apply, failed to load, or is empty", () => {
    const none = { state: false, entityType: false, nameProblem: null, blocked: null }
    expect(pickersFromPreflight(buildPreflightResponseBody(fine, "x"))).toEqual(none)
    expect(pickersFromPreflight({ success: true, applicable: false } as never)).toEqual(none)
    expect(pickersFromPreflight({})).toEqual(none)
    expect(pickersFromPreflight(null)).toEqual(none)
    expect(pickersFromPreflight(undefined)).toEqual(none)
  })
})

// ─── The real route, called the way the window calls it ─────────────────────────

const h = vi.hoisted(() => ({
  sd: null as null | Record<string, unknown>,
  pre: null as unknown,
  preInput: null as null | Record<string, unknown>,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.sd, error: null }) }) }) }),
  },
}))
vi.mock("@/lib/operations/formation-materialize", () => ({
  preflightFormationMaterialization: async (input: Record<string, unknown>) => {
    h.preInput = input
    return h.pre
  },
}))

const call = async (id = "sd-1") => {
  const { GET } = await import("@/app/api/flows/[id]/materialize-preflight/route")
  const res = await GET(new NextRequest(`http://localhost/api/flows/${id}/materialize-preflight`), { params: { id } })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.sd = { id: "sd-1", service_type: "Company Formation", account_id: null, contact_id: "c-1", name_checks: [] }
  h.pre = noState
  h.preInput = null
})

describe("GET /api/flows/[id]/materialize-preflight — end to end through the real route", () => {
  it("a formation with no state recorded: the HTTP answer has needs_state:true and the window shows the state picker", async () => {
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.needs_state).toBe(true)
    expect(body.needs_entity_type).toBe(false)
    expect(pickersFromPreflight(body)).toEqual({ state: true, entityType: false, nameProblem: null, blocked: null })
  })
  it("both missing → both flags in the HTTP answer", async () => {
    h.pre = noBoth
    const { body } = await call()
    expect(body.needs_state).toBe(true)
    expect(body.needs_entity_type).toBe(true)
  })
  it("resolved → ok, flags false, nothing for the window to show", async () => {
    h.pre = fine
    const { body } = await call()
    expect(body).toMatchObject({ ok: true, needs_state: false, needs_entity_type: false })
    expect(pickersFromPreflight(body)).toEqual({ state: false, entityType: false, nameProblem: null, blocked: null })
  })
  it("not applicable (already has a company, or not a formation): nothing to ask", async () => {
    h.sd = { id: "sd-1", service_type: "Company Formation", account_id: "acct-1", contact_id: "c-1", name_checks: [] }
    expect((await call()).body).toEqual({ success: true, applicable: false })
    h.sd = { id: "sd-1", service_type: "EIN", account_id: null, contact_id: "c-1", name_checks: [] }
    expect((await call()).body).toEqual({ success: true, applicable: false })
  })
  it("unknown flow → 404, not a crash", async () => {
    h.sd = null
    expect((await call()).status).toBe(404)
  })
})

// ─── Job 80cce1cb: the legal name travels in the same answer ─────────────────────────────────────────────────

describe("legal name in the check's answer", () => {
  it("carries legal_name and needs_legal_name from the check", () => {
    const ok = buildPreflightResponseBody({ ok: true, chosen_name: "Tanto per LLC", legal_name: "Tanto per LLC" }, "Tanto per")
    expect(ok).toMatchObject({ ok: true, needs_legal_name: false, legal_name: "Tanto per LLC", chosen_name: "Tanto per LLC" })
    const bad = buildPreflightResponseBody({ ok: false, failure: "invalid_name", error: 'The name "Acme Inc" ends in "Inc", which is not an LLC ending.', needs_legal_name: true, chosen_name: "Acme Inc" }, "Acme Inc")
    expect(bad).toMatchObject({ ok: false, failure: "invalid_name", needs_legal_name: true, legal_name: null })
  })

  it("a name problem is shown next to the legal-name field and NEVER locks the window", () => {
    const body = buildPreflightResponseBody({ ok: false, failure: "invalid_name", error: "not an LLC ending", needs_legal_name: true }, "Acme Inc")
    const p = pickersFromPreflight(body)
    expect(p.nameProblem).toContain("not an LLC ending")
    expect(p.blocked).toBeNull()
  })

  it("an answer without the flag still gets the name problem from `failure` (invalid_name)", () => {
    const p = pickersFromPreflight({ applicable: true, ok: false, failure: "invalid_name", error: "not an LLC ending" })
    expect(p).toEqual({ state: false, entityType: false, nameProblem: "not an LLC ending", blocked: null })
  })

  it("state + name together: both are reported", () => {
    const p = pickersFromPreflight({ applicable: true, ok: false, failure: "invalid_state", error: "x", needs_state: true, needs_legal_name: true })
    expect(p.state).toBe(true)
    expect(p.nameProblem).toBe("x")
  })
})
