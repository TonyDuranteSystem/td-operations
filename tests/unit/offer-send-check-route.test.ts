/**
 * GET /api/crm/admin-actions/offer-send-check — the read-only route behind the box beside the Send buttons.
 * Who may ask (the real staff rule: admin and team only), what it answers, and that it can never write or send.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const h = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata?: Record<string, unknown> },
  offer: { data: null, error: null } as { data: unknown; error: { message: string } | null },
  check: vi.fn(),
  writes: 0,
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => h.offer,
        insert: () => { h.writes++; return chain },
        update: () => { h.writes++; return chain },
        delete: () => { h.writes++; return chain },
        upsert: () => { h.writes++; return chain },
      }
      return chain
    },
  },
}))
vi.mock("@/lib/offers/send-check", () => ({ offerSendCheck: (...a: unknown[]) => h.check(...a) }))

import { GET } from "@/app/api/crm/admin-actions/offer-send-check/route"

const call = async (token: string | null = "tok-1") => {
  const url = `http://localhost/api/crm/admin-actions/offer-send-check${token === null ? "" : `?token=${encodeURIComponent(token)}`}`
  const res = await GET(Object.assign(new Request(url), { nextUrl: new URL(url) }) as never)
  return { status: res.status, cache: res.headers.get("Cache-Control"), json: (await res.json()) as Record<string, unknown> }
}

const draft = { token: "tok-1", status: "draft", client_email: "jane@example.com", services: [], bundled_pipelines: null, recurring_costs: null, installment_currency: null, contract_type: "tax_return" }

beforeEach(() => {
  h.user = { id: "u1", app_metadata: { role: "admin" } }
  h.offer = { data: draft, error: null }
  h.writes = 0
  h.check.mockReset()
  h.check.mockResolvedValue({ blockers: [{ step: "email", message: "client_email is not set on this offer. Update it first." }], risks: ["r1"], notChecked: ["n1"], willSendTo: "jane@example.com" })
})

describe("offer-send-check route — who may ask", () => {
  it("nobody signed in: 401", async () => {
    h.user = null
    expect((await call()).status).toBe(401)
    expect(h.check).not.toHaveBeenCalled()
  })

  it.each([["client"], ["partner"], ["marketing"], [""], ["Admin2"]])("a '%s' login is refused with 403 and nothing is checked", async (role) => {
    h.user = { id: "u2", app_metadata: { role } }
    const r = await call()
    expect(r.status).toBe(403)
    expect(r.json.error).toBe("Staff access required")
    expect(h.check).not.toHaveBeenCalled()
  })

  it("a login with no role at all is refused", async () => {
    h.user = { id: "u3" }
    expect((await call()).status).toBe(403)
  })

  it.each([["admin"], ["team"]])("a '%s' login is allowed", async (role) => {
    h.user = { id: "u4", app_metadata: { role } }
    expect((await call()).status).toBe(200)
  })
})

describe("offer-send-check route — what it answers", () => {
  it("no token: 400", async () => {
    expect((await call(null)).status).toBe(400)
    expect((await call("   ")).status).toBe(400)
  })

  it("an unknown offer: 404", async () => {
    h.offer = { data: null, error: null }
    const r = await call("nope")
    expect(r.status).toBe(404)
    expect(h.check).not.toHaveBeenCalled()
  })

  it("a database error reading the offer: 500, not a made-up 'fine'", async () => {
    h.offer = { data: null, error: { message: "db down" } }
    const r = await call()
    expect(r.status).toBe(500)
    expect(String(r.json.error)).toContain("db down")
  })

  it("a draft: runs the shared check in PREVIEW mode for the Send door and returns its three lists", async () => {
    const r = await call()
    expect(r.status).toBe(200)
    expect(h.check).toHaveBeenCalledWith({ offer: draft, mode: "preview" })
    expect(r.json).toMatchObject({ applicable: true, status: "draft", risks: ["r1"], notChecked: ["n1"], willSendTo: "jane@example.com" })
    expect((r.json.blockers as Array<{ step: string }>)[0].step).toBe("email")
    expect(typeof r.json.checkedAt).toBe("string")
  })

  it.each([["sent"], ["viewed"], ["signed"], ["completed"], ["expired"]])("an offer that is '%s' has nothing to check", async (status) => {
    h.offer = { data: { ...draft, status }, error: null }
    const r = await call()
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ applicable: false, status })
    expect(h.check).not.toHaveBeenCalled()
  })

  it("if the check itself throws: 500 with a plain message", async () => {
    h.check.mockRejectedValue(new Error("boom"))
    const r = await call()
    expect(r.status).toBe(500)
    expect(String(r.json.error)).toContain("boom")
  })

  it("every answer says 'do not cache' (a stale list must never be shown as fresh)", async () => {
    expect((await call()).cache).toBe("no-store")
    h.user = null
    expect((await call()).cache).toBe("no-store")
  })

  it("it never writes to the database", async () => {
    await call()
    h.offer = { data: { ...draft, status: "sent" }, error: null }
    await call()
    expect(h.writes).toBe(0)
  })
})

describe("offer-send-check route — where it lives", () => {
  it("is under the signed-in staff area, not under the public /api/offers prefix", () => {
    const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8")
    // '/api/offers' is public in the middleware (the client's own offer pages); '/api/crm' is not
    expect(mw).toMatch(/'\/api\/offers',/)
    expect(mw).not.toMatch(/'\/api\/crm/)
    const route = readFileSync(join(process.cwd(), "app/api/crm/admin-actions/offer-send-check/route.ts"), "utf8")
    expect(route).toContain("isStaffUser(user)")
  })
})
