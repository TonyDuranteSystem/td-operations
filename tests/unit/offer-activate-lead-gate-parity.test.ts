/**
 * Offer builder Part 1, step 1.1 — what ACTIVATE LEAD answers today, frozen BEFORE the Send checks are moved into one
 * shared function (dev job d2971d11, plan "Offer Builder Plan v4 — ADDENDUM 1").
 *
 * Activate Lead is NOT the same check as Send: it looks at the lead's latest offer in ANY status and checks only the
 * service readiness and the approved wording. It has no yearly-fee check, no client-email check and no status check.
 * That difference is real today, so it is recorded as it is. Part 1 keeps every answer below; lining Activate Lead up with
 * Send is Part 3.
 *
 * The database is faked and the run stops where the real thing would start (the portal-user lookup, mocked to fail with a
 * sentinel), so "the check passed" = the sentinel answer, and nothing is created or sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Res = { data: unknown; error: { message: string } | null }
interface Chain {
  select: (cols?: string) => Chain
  eq: () => Chain
  in: () => Chain
  order: () => Chain
  limit: () => Chain
  single: () => Promise<Res>
  maybeSingle: () => Promise<Res>
  then: (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>
}

const h = vi.hoisted(() => ({
  allowed: true,
  lead: { data: null, error: null } as Res, // leads ... .single()
  latest: { data: null, error: null } as Res, // offers (token, status, client_email) ... .maybeSingle() — the lead's latest offer
  body: { data: null, error: null } as Res, // offers (services, bundled_pipelines, packages, contract_type) ... .maybeSingle()
  catalog: { data: [], error: null } as Res,
  stages: { data: [], error: null } as Res,
  texts: { data: [], error: null } as Res,
  ensure: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
}))
vi.mock("@/lib/permissions", () => ({ canPerform: () => h.allowed }))
vi.mock("@/lib/offers/contract-texts-snapshot", () => ({ ensureOfferContractTexts: (...a: unknown[]) => h.ensure(...a) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    auth: { admin: { listUsers: async () => ({ error: { message: "SENTINEL" }, data: { users: [] } }) } },
    from: (table: string): Chain => {
      let cols = ""
      const pick = (): Res =>
        table === "catalog_entries" ? h.catalog
        : table === "pipeline_stages" ? h.stages
        : table === "service_contract_texts" ? h.texts
        : { data: null, error: null }
      const chain: Chain = {
        select: (c?: string) => { cols = c ?? ""; return chain },
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(table === "leads" ? h.lead : { data: null, error: null }),
        maybeSingle: () => Promise.resolve(table === "offers" ? (cols.startsWith("token, status") ? h.latest : h.body) : { data: null, error: null }),
        then: (resolve, reject) => Promise.resolve(pick()).then(resolve, reject),
      }
      return chain
    },
  },
}))

import { POST } from "@/app/api/crm/admin-actions/activate-lead/route"

const post = async (body: unknown = { lead_id: "l1" }) => {
  const res = await POST(new Request("http://localhost/api/crm/admin-actions/activate-lead", { method: "POST", body: JSON.stringify(body) }) as never)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const PASSED = { status: 500, error: "Failed to check portal users: SENTINEL" }
const lead = { id: "l1", full_name: "Jane Doe", email: "jane@example.com", language: "en", phone: null }
const apostilleLines = [{ name: "Apostille", price: "$100", pipeline_type: "Apostille" }]

beforeEach(() => {
  h.allowed = true
  h.lead = { data: lead, error: null }
  h.latest = { data: { token: "tok-1", status: "draft", client_email: "jane@example.com" }, error: null }
  h.body = { data: { services: [{ name: "Tax Return" }], bundled_pipelines: null, packages: null, contract_type: "tax_return" }, error: null }
  h.catalog = { data: [], error: null }
  h.stages = { data: [], error: null }
  h.texts = { data: [], error: null }
  h.ensure.mockReset()
  h.ensure.mockResolvedValue({ texts: {}, missing: [], changed: false })
})

describe("Activate Lead — what it answers today (frozen from the current code)", () => {
  it("someone who may not activate leads is refused", async () => {
    h.allowed = false
    const r = await post()
    expect(r.status).toBe(403)
    expect(r.json.error).toBe("Admin access required")
  })

  it("a request without a lead", async () => {
    const r = await post({})
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("lead_id is required")
  })

  it("a lead that does not exist", async () => {
    h.lead = { data: null, error: { message: "no rows" } }
    const r = await post()
    expect(r.status).toBe(404)
    expect(r.json.error).toBe("Lead not found")
  })

  it("a lead with no email", async () => {
    h.lead = { data: { ...lead, email: null }, error: null }
    const r = await post()
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("Lead has no email — cannot create portal login")
  })

  it("a lead with no offer", async () => {
    h.latest = { data: null, error: null }
    const r = await post()
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("No offer found for this lead. Create an offer first.")
  })

  it("an ordinary draft offer passes the checks and goes on; the wording is frozen fresh", async () => {
    const r = await post()
    expect(r.status).toBe(PASSED.status)
    expect(r.json.error).toBe(PASSED.error)
    expect(h.ensure).toHaveBeenCalledWith("tok-1", { refresh: true })
  })

  it("a new service that is not ready refuses with the engine's list", async () => {
    h.body = { data: { services: apostilleLines, bundled_pipelines: null, packages: null, contract_type: "shipping" }, error: null }
    const r = await post()
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toContain('Cannot activate: "Apostille" is not in the Service Catalog')
    expect((r.json.blockers as Array<{ kind: string }>).map((b) => b.kind)).toEqual(["not_in_catalog"])
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it("a failed lookup of the new services refuses (closed)", async () => {
    h.body = { data: { services: apostilleLines, bundled_pipelines: null, packages: null, contract_type: "shipping" }, error: null }
    h.catalog = { data: null, error: { message: "db down" } }
    const r = await post()
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("Cannot activate: could not check the services on this offer (db down) — try again.")
  })

  it("wording missing for a new service", async () => {
    h.ensure.mockResolvedValue({ texts: {}, missing: ["Apostille"], changed: false })
    const r = await post()
    expect(r.status).toBe(400)
    expect(r.json.error).toBe("Cannot activate: no approved contract wording for Apostille — approve the service's contract in the Service Catalog first.")
  })

  it("the wording freeze throws: a 500 that says to try again", async () => {
    h.ensure.mockRejectedValue(new Error("boom"))
    const r = await post()
    expect(r.status).toBe(500)
    expect(r.json.error).toBe("Cannot activate: could not save the contract wording on the offer (boom) — try again.")
  })
})

describe("Activate Lead — what it does NOT check today (Part 3 lines these up with Send; Part 1 changes none of them)", () => {
  it("TODAY: an offer that is already SIGNED passes (no status check); the wording is not re-frozen", async () => {
    h.latest = { data: { token: "tok-1", status: "signed", client_email: "jane@example.com" }, error: null }
    const r = await post()
    expect(r.status).toBe(PASSED.status)
    expect(r.json.error).toBe(PASSED.error)
    expect(h.ensure).toHaveBeenCalledWith("tok-1", {})
  })

  it("TODAY: an offer with no client email passes (only the lead's own email is looked at)", async () => {
    h.latest = { data: { token: "tok-1", status: "draft", client_email: null }, error: null }
    expect((await post()).json.error).toBe(PASSED.error)
  })

  it("TODAY: a formation offer with no yearly fee passes (no yearly-fee check)", async () => {
    h.body = { data: { services: [{ name: "Formation", pipeline_type: "Company Formation" }], bundled_pipelines: null, packages: null, contract_type: "formation" }, error: null }
    expect((await post()).json.error).toBe(PASSED.error)
  })
})
