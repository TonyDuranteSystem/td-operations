import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { ROLES, NON_ADMIN_ROLES, throwingDb, type FakeUser } from "./helpers/five-roles"

/**
 * The five-role behaviour test for EVERY real Booking handler and page (Stage 1b). The route files are found by walking app/api/booking, so a route added later is
 * tested without anyone remembering to list it. Each handler is called as team, partner, client, marketing, anonymous and a login that only CLAIMS admin in its own
 * writable profile, with a database that throws on any use: all must get 403 and the database must never be touched.
 */
const h = vi.hoisted(() => ({ user: null as unknown, touched: 0 }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/supabase-admin", async () => {
  const { throwingDb: t } = await import("./helpers/five-roles")
  return { supabaseAdmin: t(() => { h.touched++ }) }
})
// the Calendar guard uses React's per-request cache, which the plain-node test runner does not have; it is not what is being tested here
vi.mock("@/lib/open-services/audience", () => ({ requireOpenServicesAccess: async () => ({ ok: false }) }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND") },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

const ROOT = path.resolve(__dirname, "../..")
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [])
const routeFiles = walk(path.join(ROOT, "app", "api", "booking")).filter((f) => /route\.ts$/.test(f)).sort()

const HOST = "app.example.com"
const make = (method: string, good: boolean) =>
  new NextRequest(`https://${HOST}/api/booking/x?q=zz`, {
    method,
    headers: { host: HOST, ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json", origin: good ? `https://${HOST}` : "https://evil.example.net" }) },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  })
const ctx = { params: Promise.resolve({ id: "d0000000-0000-4000-8000-000000000001", slug: "client" }) }

beforeEach(() => { h.user = null; h.touched = 0 })

describe("every booking route is found and covered", () => {
  it("the walk finds the seven routes (a silent empty walk would test nothing)", () => {
    const rel = routeFiles.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    expect(rel).toEqual([
      "app/api/booking/checks/[id]/answer/route.ts",
      "app/api/booking/kinds/[slug]/route.ts",
      "app/api/booking/kinds/route.ts",
      "app/api/booking/links/[id]/revoke/route.ts",
      "app/api/booking/links/route.ts",
      "app/api/booking/people/route.ts",
      "app/api/booking/preview/route.ts",
    ])
  })
})

for (const file of routeFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/")
  describe(rel, () => {
    let handlers: Array<[string, (req: NextRequest, c: typeof ctx) => Promise<Response>]> = []
    beforeEach(async () => {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
      handlers = METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as never])
    })
    it("has at least one handler", () => { expect(handlers.length).toBeGreaterThan(0) })
    for (const role of NON_ADMIN_ROLES) {
      it(`${role}: every handler answers 403, no-store, and never touches the database`, async () => {
        h.user = ROLES[role] as FakeUser | null
        for (const [method, fn] of handlers) {
          const res = await fn(make(method, true), ctx)
          expect(res.status, `${method} as ${role}`).toBe(403)
          expect(res.headers.get("cache-control")).toBe("no-store")
        }
        expect(h.touched).toBe(0)
      })
    }
    it("an admin from another website is refused on every handler that changes something, before the database", async () => {
      h.user = ROLES.admin
      for (const [method, fn] of handlers) {
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") continue
        const res = await fn(make(method, false), ctx)
        expect(res.status, method).toBe(403)
      }
      expect(h.touched).toBe(0)
    })
  })
}

describe("the Booking page", () => {
  it("anyone but an admin gets the ordinary not-found page, before any read", async () => {
    const Page = (await import("../../app/(dashboard)/booking/page")).default
    for (const role of NON_ADMIN_ROLES) {
      h.user = ROLES[role] as FakeUser | null
      await expect(Page(), role).rejects.toThrow("NEXT_NOT_FOUND")
    }
    expect(h.touched).toBe(0)
  })
  it("an admin passes the check and the page opens even though its switch is unreadable (= off): it is shown read-only, never hidden", async () => {
    const Page = (await import("../../app/(dashboard)/booking/page")).default
    h.user = ROLES.admin
    const el = (await Page()) as { props: { children: { props: { mode: string } } } }
    expect(el.props.children.props.mode).toBe("off")
    expect(h.touched).toBeGreaterThan(0)
  })
})

describe("the Booking page's Calls to check section", () => {
  it("the answer route is the only way cards change, and it is in the walk above (admin-only)", () => {
    expect(routeFiles.some((f) => /checks[\\/]\[id\][\\/]answer[\\/]route\.ts$/.test(f))).toBe(true)
  })
})

// keep the helper import used (the throwing database is also built inside the mock factory)
void throwingDb
