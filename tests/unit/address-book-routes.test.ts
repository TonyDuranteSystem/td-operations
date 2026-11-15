import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { ROLES, throwingDb, type FakeUser } from "./helpers/five-roles"

/**
 * The five-role test for EVERY address book handler and for the page. The route files are found by walking app/api/address-book, so a route added later is tested without anyone listing it.
 * The Company book is for STAFF: an administrator or a team login. Everyone else (a partner, a client, a marketing login, a signed-out visitor, a login that only CLAIMS a role in its
 * own writable profile, an unknown or empty role) is refused with 403 and no-store, and the database is never touched. A request that changes something from another website is refused too.
 */
const h = vi.hoisted(() => ({ user: null as unknown, touched: 0 }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/supabase-admin", async () => {
  const { throwingDb: t } = await import("./helpers/five-roles")
  return { supabaseAdmin: t(() => { h.touched++ }) }
})
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND") },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
}))

const ROOT = path.resolve(__dirname, "../..")
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [])
const routeFiles = walk(path.join(ROOT, "app", "api", "address-book")).filter((f) => /route\.ts$/.test(f)).sort()
const relOf = (f: string) => path.relative(ROOT, f).split(path.sep).join("/")

const HOST = "app.example.com"
const make = (method: string, good: boolean) =>
  new NextRequest(`https://${HOST}/api/address-book/x`, {
    method,
    headers: { host: HOST, ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json", origin: good ? `https://${HOST}` : "https://evil.example.net" }) },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  })
const ctx = { params: { id: "d0000000-0000-4000-8000-000000000001" } }
const STAFF = ["admin", "team"]
const GATE_ANSWERS = ["Not authorized", "Not allowed from here"]

type Handler = (req: NextRequest, c: typeof ctx) => Promise<Response>
async function call(fn: Handler, req: NextRequest): Promise<{ status: number | null; error: string | null; noStore: boolean }> {
  try {
    const res = await fn(req, ctx)
    let error: string | null = null
    try { error = ((await res.clone().json()) as { error?: string }).error ?? null } catch { /* not JSON */ }
    return { status: res.status, error, noStore: res.headers.get("cache-control") === "no-store" }
  } catch {
    // a handler that throws after the gate (the throwing database) has, by definition, got past the gate
    return { status: null, error: null, noStore: false }
  }
}

const EXPECTED: Record<string, string[]> = {
  "app/api/address-book/check/route.ts": ["POST"],
  "app/api/address-book/label/route.ts": ["POST"],
  "app/api/address-book/people/[id]/route.ts": ["DELETE", "PATCH"],
  "app/api/address-book/people/route.ts": ["POST"],
  "app/api/address-book/route.ts": ["GET"],
  "app/api/address-book/types/[id]/route.ts": ["PATCH"],
  "app/api/address-book/types/route.ts": ["GET", "POST"],
}

beforeEach(() => { h.user = null; h.touched = 0 })

describe("the walk", () => {
  it("finds exactly the seven routes (a silent empty walk would test nothing) and their methods", async () => {
    expect(routeFiles.map(relOf)).toEqual(Object.keys(EXPECTED).sort())
    for (const f of routeFiles) {
      const mod = (await import(/* @vite-ignore */ f)) as Record<string, unknown>
      expect(METHODS.filter((m) => typeof mod[m] === "function").sort(), relOf(f)).toEqual(EXPECTED[relOf(f)])
    }
  })
  it("the gate is the first statement of every handler", () => {
    for (const f of routeFiles) {
      const src = fs.readFileSync(f, "utf8")
      for (const m of EXPECTED[relOf(f)]) {
        const at = src.indexOf(`export async function ${m}(`)
        expect(at, `${relOf(f)} ${m}`).toBeGreaterThan(-1)
        const body = src.slice(src.indexOf("{", src.indexOf(")", at)) + 1)
        const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"))
        expect(first, `${relOf(f)} ${m}`).toMatch(/await require(Staff|StaffJson)\(/)
      }
    }
  })
})

for (const file of routeFiles) {
  const rel = relOf(file)
  describe(rel, () => {
    let handlers: Array<[string, Handler]> = []
    beforeEach(async () => {
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
      handlers = METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler])
    })
    for (const role of Object.keys(ROLES)) {
      it(`${role}: ${STAFF.includes(role) ? "gets past the gate" : "is refused (403, no-store) before the database"}`, async () => {
        for (const [method, fn] of handlers) {
          h.user = ROLES[role] as FakeUser | null
          h.touched = 0
          const r = await call(fn, make(method, true))
          if (STAFF.includes(role)) {
            expect(r.status === 403 && r.error !== null && GATE_ANSWERS.includes(r.error), `${method} as ${role} must pass the gate`).toBe(false)
          } else {
            expect(r.status, `${method} as ${role}`).toBe(403)
            expect(r.noStore, `${method} as ${role} no-store`).toBe(true)
            expect(h.touched, `${method} as ${role} touched the database`).toBe(0)
          }
        }
      })
    }
    it("a staff login from another website is refused on every handler that changes something, before the database", async () => {
      for (const role of STAFF) {
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

describe("the Address book page", () => {
  it("anyone who is not an administrator or a team login gets the ordinary not-found page, before any read", async () => {
    const Page = (await import("../../app/(dashboard)/address-book/page")).default
    for (const role of Object.keys(ROLES).filter((r) => !STAFF.includes(r))) {
      h.user = ROLES[role] as FakeUser | null
      await expect(Page(), role).rejects.toThrow("NEXT_NOT_FOUND")
    }
    expect(h.touched).toBe(0)
  })
  for (const role of STAFF) {
    it(`${role}: the page opens (and reaches the database)`, async () => {
      const Page = (await import("../../app/(dashboard)/address-book/page")).default
      h.user = ROLES[role]
      const el = await Page()
      expect(el).toBeTruthy()
      expect(h.touched).toBeGreaterThan(0)
    })
  }
})

describe("the CRM is only ever read", () => {
  it("no address book file inserts, updates, upserts or deletes on contacts, accounts, account_contacts, partners or leads", () => {
    const files = [...walk(path.join(ROOT, "lib", "address-book")), ...walk(path.join(ROOT, "components", "address-book")), ...routeFiles]
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) {
      const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
      expect(code, relOf(f)).not.toMatch(/\.from\(\s*["'`](contacts|accounts|account_contacts|partners|leads)["'`]\s*\)\s*\.(insert|update|upsert|delete)\b/)
      expect(code, relOf(f)).not.toMatch(/\.from\(\s*["'`](contacts|accounts|account_contacts|partners|leads)["'`]\s*\)\s*[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/)
    }
  })
})

void throwingDb
