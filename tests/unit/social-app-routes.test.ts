/**
 * TD Social — the two routes under /api/marketing/app/ (dev job 2072bc3e, Step 2 pull request A).
 * The ORDER is the safety: switch first (nothing is read while it is off), then signed in, then (register) a tab, then the server knows
 * what it is and the bundle id fits, then the body, then the write. The person always comes from the session, never from the body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const h = vi.hoisted(() => ({
  enabled: true,
  who: null as null | { user: { id: string; email: string | null; name: string }; identity: Record<string, unknown> },
  order: [] as string[],
  registered: [] as Array<{ userId: string; reg: unknown }>,
  removed: [] as Array<{ userId: string; token: string; bundleId: string }>,
  registerResult: { ok: true } as { ok: true } | { ok: false; code: string },
  removeResult: { ok: true, removed: 1 } as { ok: true; removed: number } | { ok: false; code: string },
}))

vi.mock("@/lib/app/enabled", () => ({
  SOCIAL_APP_NOT_ENABLED: { error: "TD Social is not switched on yet.", code: "APP_NOT_ENABLED" },
  isSocialAppEnabled: async () => { h.order.push("enabled"); return h.enabled },
}))
vi.mock("@/lib/app/identity", () => ({ resolveAppIdentity: async () => { h.order.push("identity"); return h.who } }))
vi.mock("@/lib/app/devices", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/app/devices")>()
  return {
    ...real,
    registerDevice: async (userId: string, reg: unknown) => { h.order.push("register"); h.registered.push({ userId, reg }); return h.registerResult },
    removeDevice: async (userId: string, token: string, bundleId: string) => { h.order.push("remove"); h.removed.push({ userId, token, bundleId }); return h.removeResult },
  }
})
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

import { GET } from "@/app/api/marketing/app/me/route"
import { PUT, DELETE } from "@/app/api/marketing/app/devices/route"

const SANDBOX_URL = "https://xjcxlmlpeywtwkhstjlw.supabase.co"
const BUNDLE = "com.tonydurante.tdsocial.sandbox"
const TOKEN = "cd".repeat(32)
const body = { token: TOKEN, bundleId: BUNDLE, apnsEnv: "production", deviceName: "iPhone" }
const req = (b: unknown) => ({ json: async () => b }) as never
const brokenReq = { json: async () => { throw new Error("bad json") } } as never

const staff = { user: { id: "u-staff", email: "s@x.y", name: "S" }, identity: { authRole: "team", isAdmin: false, isStaff: true, marketingChat: false } }
const client = { user: { id: "u-client", email: "c@x.y", name: "C" }, identity: { authRole: "client", isAdmin: false, isStaff: false, marketingChat: false } }

beforeEach(() => {
  h.enabled = true; h.who = staff; h.order = []; h.registered = []; h.removed = []
  h.registerResult = { ok: true }; h.removeResult = { ok: true, removed: 1 }
  process.env.NEXT_PUBLIC_SUPABASE_URL = SANDBOX_URL
})

describe("GET /api/marketing/app/me", () => {
  it("answers 'not switched on' FIRST: nobody is looked up while the switch is off", async () => {
    h.enabled = false
    const res = await GET()
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("APP_NOT_ENABLED")
    expect(h.order).toEqual(["enabled"])
  })

  it("401 when nobody is signed in", async () => {
    h.who = null
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("returns the tabs for a staff login, no-store", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const j = await res.json()
    expect(j.loginKind).toBe("staff")
    expect(j.tabs.map((t: { id: string }) => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(j.notSetUp).toBe(false)
  })

  it("a login with no tab gets an empty list and notSetUp, not an error", async () => {
    h.who = client
    const j = await (await GET()).json()
    expect(j.tabs).toEqual([])
    expect(j.notSetUp).toBe(true)
    expect(j.loginKind).toBe("none")
  })
})

describe("PUT /api/marketing/app/devices (register)", () => {
  it("switch off: 503 and NOTHING else ran (no identity, no database)", async () => {
    h.enabled = false
    const res = await PUT(req(body))
    expect(res.status).toBe(503)
    expect(h.order).toEqual(["enabled"])
  })

  it("401 when nobody is signed in; nothing is written", async () => {
    h.who = null
    expect((await PUT(req(body))).status).toBe(401)
    expect(h.registered).toHaveLength(0)
  })

  it("403 NO_TABS for a client, a partner or an unknown login; nothing is written", async () => {
    h.who = client
    const res = await PUT(req(body))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("NO_TABS")
    expect(h.registered).toHaveLength(0)
  })

  it("503 when the server cannot tell what it is (a local stack or a look-alike address)", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"
    const res = await PUT(req(body))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("APP_ENV_UNKNOWN")
    expect(h.registered).toHaveLength(0)
  })

  it("400 for the other server's app, a bad token, an address as the Apple system, or a body that is not JSON", async () => {
    for (const b of [
      { ...body, bundleId: "com.tonydurante.tdsocial" },
      { ...body, token: "xyz" },
      { ...body, apnsEnv: "attacker.example" },
      null,
    ]) {
      expect((await PUT(req(b))).status).toBe(400)
    }
    expect((await PUT(brokenReq)).status).toBe(400)
    expect(h.registered).toHaveLength(0)
  })

  it("registers for the SESSION's person and ignores any person id the body carries", async () => {
    const res = await PUT(req({ ...body, userId: "someone-else", user_id: "someone-else", id: "someone-else" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(h.registered).toHaveLength(1)
    expect(h.registered[0].userId).toBe("u-staff")
    expect(JSON.stringify(h.registered[0].reg)).not.toContain("someone-else")
  })

  it("runs the checks in the documented order", async () => {
    await PUT(req(body))
    expect(h.order).toEqual(["enabled", "identity", "register"])
  })

  it("409 at the cap, 500 on a database error", async () => {
    h.registerResult = { ok: false, code: "TOO_MANY_DEVICES" }
    expect((await PUT(req(body))).status).toBe(409)
    h.registerResult = { ok: false, code: "DB_ERROR" }
    expect((await PUT(req(body))).status).toBe(500)
  })
})

describe("DELETE /api/marketing/app/devices (remove)", () => {
  it("switch off: 503 and nothing else ran", async () => {
    h.enabled = false
    expect((await DELETE(req(body))).status).toBe(503)
    expect(h.order).toEqual(["enabled"])
  })

  it("401 when nobody is signed in", async () => {
    h.who = null
    expect((await DELETE(req(body))).status).toBe(401)
  })

  it("removes the SESSION person's phone only, and does not need a tab (a person can always remove their own phone)", async () => {
    h.who = client
    const res = await DELETE(req({ ...body, userId: "someone-else" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, removed: 1 })
    expect(h.removed).toEqual([{ userId: "u-client", token: TOKEN, bundleId: BUNDLE }])
  })

  it("400 for a bad token or the other server's app", async () => {
    expect((await DELETE(req({ ...body, token: "zz" }))).status).toBe(400)
    expect((await DELETE(req({ ...body, bundleId: "com.tonydurante.tdsocial" }))).status).toBe(400)
    expect(h.removed).toHaveLength(0)
  })

  it("500 on a database error", async () => {
    h.removeResult = { ok: false, code: "DB_ERROR" }
    expect((await DELETE(req(body))).status).toBe(500)
  })
})

describe("source guard: the switch is the first thing each route does, and no route takes a person id from the request", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8")
  const me = read("app/api/marketing/app/me/route.ts")
  const devices = read("app/api/marketing/app/devices/route.ts")

  it("me: isSocialAppEnabled is awaited before resolveAppIdentity", () => {
    expect(me.indexOf("isSocialAppEnabled()")).toBeGreaterThan(-1)
    expect(me.indexOf("isSocialAppEnabled()")).toBeLessThan(me.indexOf("resolveAppIdentity()"))
  })

  it("devices: the gate (switch, then identity) comes before any parse or write", () => {
    expect(devices.indexOf("isSocialAppEnabled()")).toBeLessThan(devices.indexOf("resolveAppIdentity()"))
    expect(devices.indexOf("resolveAppIdentity()")).toBeLessThan(devices.indexOf("parseRegistration("))
    expect(devices.indexOf("parseRegistration(")).toBeLessThan(devices.indexOf("registerDevice("))
  })

  it("the person written to the list is the session's (g.who.user.id), never a value read from the body", () => {
    expect(devices).toContain("registerDevice(g.who.user.id,")
    expect(devices).toContain("removeDevice(g.who.user.id,")
    expect(devices).not.toMatch(/body\.(userId|user_id)/)
    expect(devices).not.toMatch(/parsed\.value\.(userId|user_id)/)
  })
})
