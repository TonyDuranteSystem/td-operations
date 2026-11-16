import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { ROLES, throwingDb, type FakeUser } from "./helpers/five-roles"
import { bookingRouteAccess, bookingPageAccess, type BookingAccess } from "@/lib/security/booking-access-gate-check"

/**
 * The five-role behaviour test for EVERY real Booking handler and page (Stage 1b, widened to staff in dev job a1839d8b). The route files are found by walking app/api/booking, so a route
 * added later is tested without anyone remembering to list it. Each handler DECLARES its level by the gate it uses (the access scan reads it): "staff" = an administrator or a team login,
 * "admin" = an administrator only. Every handler is called as admin, team, partner, client, marketing, anonymous, a login that only CLAIMS admin or team in its own writable profile, a
 * login with an unknown role and a login with no role — with a database that throws on any use. The rule:
 *   - a level the person has  -> the gate lets the call through (it is not answered with the gate's 403);
 *   - a level the person lacks -> 403, no-store, and the database is never touched.
 * Every real route is also PINNED to its level below, so a route cannot be narrowed or widened silently.
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
const relOf = (f: string) => path.relative(ROOT, f).split(path.sep).join("/")

const HOST = "app.example.com"
const make = (method: string, good: boolean) =>
  new NextRequest(`https://${HOST}/api/booking/x?q=zz`, {
    method,
    headers: { host: HOST, ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json", origin: good ? `https://${HOST}` : "https://evil.example.net" }) },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  })
const ctx = { params: Promise.resolve({ id: "d0000000-0000-4000-8000-000000000001", slug: "client" }) }

/** Who may do what: a level, and who has it. */
const ALLOWED: Record<BookingAccess, string[]> = { staff: ["admin", "team"], admin: ["admin"] }
const allowedFor = (access: BookingAccess, role: string) => ALLOWED[access].includes(role)
const GATE_ANSWERS = ["Not authorized", "Not allowed from here"]

/** Call a handler; a handler that throws after the gate (the throwing database) has, by definition, got past the gate. */
async function call(fn: (req: NextRequest, c: typeof ctx) => Promise<Response>, req: NextRequest): Promise<{ status: number | null; error: string | null; noStore: boolean }> {
  try {
    const res = await fn(req, ctx)
    let error: string | null = null
    try { error = ((await res.clone().json()) as { error?: string }).error ?? null } catch { /* not JSON */ }
    return { status: res.status, error, noStore: res.headers.get("cache-control") === "no-store" }
  } catch {
    return { status: null, error: null, noStore: false }
  }
}

/** Every real route is pinned to its level: all eleven are "staff" today (Antonio, 14 Nov: use it like the admin). To narrow one to admin, change its gate AND this table. */
const PINNED: Record<string, Record<string, BookingAccess>> = {
  "app/api/booking/checks/[id]/answer/route.ts": { POST: "staff" },
  "app/api/booking/kinds/[slug]/route.ts": { PATCH: "staff" },
  "app/api/booking/kinds/route.ts": { GET: "staff", POST: "staff" },
  "app/api/booking/links/[id]/cancel-call/route.ts": { POST: "staff" },
  "app/api/booking/links/[id]/not-charging/route.ts": { POST: "staff" },
  "app/api/booking/links/[id]/revoke/route.ts": { POST: "staff" },
  "app/api/booking/links/[id]/sent/route.ts": { POST: "staff" },
  "app/api/booking/links/route.ts": { GET: "staff", POST: "staff" },
  "app/api/booking/people/route.ts": { GET: "staff" },
  "app/api/booking/preview/route.ts": { POST: "staff" },
  "app/api/booking/questions/route.ts": { GET: "staff" },
}

beforeEach(() => { h.user = null; h.touched = 0 })

describe("every booking route is found, declares a level, and is pinned to it", () => {
  it("the walk finds the eleven routes (a silent empty walk would test nothing)", () => {
    expect(routeFiles.map(relOf)).toEqual(Object.keys(PINNED).sort())
  })
  for (const file of routeFiles) {
    it(`${relOf(file)} declares exactly the pinned level on each of its handlers`, () => {
      expect(bookingRouteAccess(relOf(file), fs.readFileSync(file, "utf8"))).toEqual(PINNED[relOf(file)])
    })
  }
})

for (const file of routeFiles) {
  const rel = relOf(file)
  describe(rel, () => {
    let handlers: Array<[string, (req: NextRequest, c: typeof ctx) => Promise<Response>]> = []
    const declared = bookingRouteAccess(rel, fs.readFileSync(file, "utf8"))
    beforeEach(async () => {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
      handlers = METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as never])
    })
    it("has at least one handler, and every handler declared a level", () => {
      expect(handlers.length).toBeGreaterThan(0)
      for (const [m] of handlers) expect(declared[m], `${m} declares a level`).toBeTruthy()
    })
    for (const role of Object.keys(ROLES)) {
      it(`${role}: allowed exactly where its level allows — refused (403, no-store, database never touched) everywhere else`, async () => {
        for (const [method, fn] of handlers) {
          h.user = ROLES[role] as FakeUser | null
          h.touched = 0
          const r = await call(fn, make(method, true))
          if (allowedFor(declared[method], role)) {
            // got past the gate: it is not the gate's own refusal
            expect(r.status === 403 && r.error !== null && GATE_ANSWERS.includes(r.error), `${method} as ${role} must pass the gate`).toBe(false)
          } else {
            expect(r.status, `${method} as ${role}`).toBe(403)
            expect(r.noStore, `${method} as ${role} no-store`).toBe(true)
            expect(h.touched, `${method} as ${role} touched the database`).toBe(0)
          }
        }
      })
    }
    it("a staff or admin login from another website is refused on every handler that changes something, before the database", async () => {
      for (const role of ["admin", "team"]) {
        for (const [method, fn] of handlers) {
          if (method === "GET" || method === "HEAD" || method === "OPTIONS") continue
          h.user = ROLES[role] as FakeUser
          h.touched = 0
          const r = await call(fn, make(method, false))
          expect(r.status, `${method} as ${role}`).toBe(403)
          expect(h.touched, `${method} as ${role}`).toBe(0)
        }
      }
    })
  })
}

describe("the Booking page", () => {
  const pageFile = path.join(ROOT, "app", "(dashboard)", "booking", "page.tsx")
  it("is pinned to the staff level", () => {
    expect(bookingPageAccess("app/(dashboard)/booking/page.tsx", fs.readFileSync(pageFile, "utf8"))).toBe("staff")
  })
  it("anyone who is not an administrator or a team login gets the ordinary not-found page, before any read — whatever the tab asked for", async () => {
    const Page = (await import("../../app/(dashboard)/booking/page")).default
    for (const role of Object.keys(ROLES).filter((r) => r !== "admin" && r !== "team")) {
      for (const sp of [{}, { tab: "links" }, { tab: "leads", q: "x" }]) {
        h.user = ROLES[role] as FakeUser | null
        await expect(Page({ searchParams: sp }), role).rejects.toThrow("NEXT_NOT_FOUND")
      }
    }
    expect(h.touched).toBe(0)
  })
  for (const role of ["admin", "team"]) {
    it(`${role}: passes the check and the page opens even though its switch is unreadable (= off): shown, never hidden`, async () => {
      const Page = (await import("../../app/(dashboard)/booking/page")).default
      h.user = ROLES[role]
      for (const sp of [{}, { tab: "links" }, { tab: "leads", q: "x", page: "2" }]) {
        h.touched = 0
        const el = (await Page({ searchParams: sp })) as { props: { children: Array<{ props: Record<string, unknown>; type: unknown }> } }
        expect(el).toBeTruthy()
        expect(h.touched, `${role} ${JSON.stringify(sp)} reaches the switch read`).toBeGreaterThan(0)
      }
    })
  }
})

describe("the Booking page's Calls to check section", () => {
  it("the answer route is the only way cards change, and it is in the walk above (staff level)", () => {
    expect(routeFiles.some((f) => /checks[\\/]\[id\][\\/]answer[\\/]route\.ts$/.test(f))).toBe(true)
  })
})

// keep the helper import used (the throwing database is also built inside the mock factory)
void throwingDb
