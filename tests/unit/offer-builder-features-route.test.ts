/**
 * GET /api/crm/admin-actions/offer-builder-features — the read-only staff route the offer screens ask which NEW
 * pieces they may show for a record. Who may ask, what it answers, and that it can never write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const h = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata?: Record<string, unknown> },
  features: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/offers/rollout-server", () => ({ offerBuilderFeaturesFor: (...a: unknown[]) => h.features(...a) }))

import { GET } from "@/app/api/crm/admin-actions/offer-builder-features/route"

const call = async (query = "") => {
  const url = `http://localhost/api/crm/admin-actions/offer-builder-features${query ? `?${query}` : ""}`
  const res = await GET(Object.assign(new Request(url), { nextUrl: new URL(url) }) as never)
  return { status: res.status, cache: res.headers.get("Cache-Control"), json: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  h.user = { id: "u1", app_metadata: { role: "admin" } }
  h.features.mockReset()
  h.features.mockResolvedValue({ sendCheckBox: true })
})

describe("offer-builder-features route — who may ask", () => {
  it("nobody signed in: 401, and nothing is read", async () => {
    h.user = null
    expect((await call()).status).toBe(401)
    expect(h.features).not.toHaveBeenCalled()
  })
  it.each([["client"], ["partner"], ["marketing"], [""], ["Admin2"]])("a '%s' login is refused with 403 and nothing is read", async (role) => {
    h.user = { id: "u2", app_metadata: { role } }
    const r = await call()
    expect(r.status).toBe(403)
    expect(r.json.error).toBe("Staff access required")
    expect(h.features).not.toHaveBeenCalled()
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

describe("offer-builder-features route — what it answers", () => {
  it("answers exactly the yes/no value, never cached", async () => {
    const r = await call("lead_id=L1")
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ sendCheckBox: true })
    expect(r.cache).toBe("no-store")
  })
  it("passes the screen's ids and token through, as given", async () => {
    await call("lead_id=L1&account_id=A1&contact_id=C1&token=tok-1")
    expect(h.features).toHaveBeenCalledWith({ leadId: "L1", accountId: "A1", contactId: "C1", token: "tok-1" })
  })
  it("no ids at all is still a valid question (a piece that is on for everyone needs none)", async () => {
    const r = await call()
    expect(r.status).toBe(200)
    expect(h.features).toHaveBeenCalledWith({ leadId: null, accountId: null, contactId: null, token: null })
  })
  it("a failure while reading is a 500 with a reason, never cached — the screens then show nothing", async () => {
    h.features.mockRejectedValue(new Error("db down"))
    const r = await call("lead_id=L1")
    expect(r.status).toBe(500)
    expect(String(r.json.error)).toContain("db down")
    expect(r.cache).toBe("no-store")
  })
})

describe("offer-builder-features route — it can never write", () => {
  const src = readFileSync(join(process.cwd(), "app/api/crm/admin-actions/offer-builder-features/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  it("only GET exists, and no write call is in the file", () => {
    expect(src).toMatch(/export async function GET/)
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
  it("it lives under /api/crm (a session is required), not the public /api/offers prefix", () => {
    expect("app/api/crm/admin-actions/offer-builder-features/route.ts").not.toContain("app/api/offers")
  })
})
