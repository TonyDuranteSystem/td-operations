import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { ROLES, NON_ADMIN_ROLES, throwingDb, type FakeUser } from "./helpers/five-roles"
import { adminRouteViolations, adminPageViolations } from "@/lib/security/booking-admin-gate-check"

const h = vi.hoisted(() => ({ user: null as unknown, throwOn: null as null | "client" | "getUser", touched: 0 }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    if (h.throwOn === "client") throw new Error("no client")
    return { auth: { getUser: async () => { if (h.throwOn === "getUser") throw new Error("auth down"); return { data: { user: h.user } } } } }
  },
}))

import { requireAdminRoute, requireAdminJsonRoute } from "@/lib/auth/require-admin-route"

const db = throwingDb(() => { h.touched++ })

// A stand-in for a Stage 1b route: gate first, database after.
async function GET() {
  const denied = await requireAdminRoute()
  if (denied) return denied
  await (db as { from: (t: string) => unknown }).from("booking_links")
  return NextResponse.json({ ok: true })
}
async function POST(req: { headers: { get(n: string): string | null } }) {
  const denied = await requireAdminJsonRoute(req)
  if (denied) return denied
  return NextResponse.json({ ok: true })
}
const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

beforeEach(() => { h.user = null; h.throwOn = null; h.touched = 0 })

describe("requireAdminRoute — the five-role behaviour test", () => {
  for (const role of NON_ADMIN_ROLES) {
    it(`${role}: 403, no-store, and the database is never touched`, async () => {
      h.user = ROLES[role] as FakeUser | null
      const res = await GET()
      expect(res.status).toBe(403)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(h.touched).toBe(0)
    })
  }
  it("admin: passes the gate and reaches the database", async () => {
    h.user = ROLES.admin
    await expect(GET()).rejects.toThrow(/database was touched/)
    expect(h.touched).toBe(1)
  })
  it("an admin by app_metadata role alone also passes (the same rule as the rest of the CRM)", async () => {
    expect(await requireAdminRoute.call(null)).not.toBeNull() // no user yet: denied
    h.user = { id: "x", email: "other-admin@example.com", app_metadata: { role: "admin" } }
    expect(await requireAdminRoute()).toBeNull()
  })
  it("denies when the identity check itself breaks (never fails open)", async () => {
    h.throwOn = "getUser"
    expect((await requireAdminRoute())!.status).toBe(403)
    h.throwOn = "client"
    expect((await requireAdminRoute())!.status).toBe(403)
  })
})

describe("requireAdminJsonRoute — changing routes also prove they come from our own page", () => {
  const ok = headers({ "content-type": "application/json", origin: "https://app.example.com", host: "app.example.com" })
  it("admin + same-origin JSON passes", async () => {
    h.user = ROLES.admin
    expect((await POST({ headers: ok })).status).toBe(200)
  })
  it("admin from another origin, or without JSON, is refused", async () => {
    h.user = ROLES.admin
    expect((await POST({ headers: headers({ "content-type": "application/json", origin: "https://evil.example.net", host: "app.example.com" }) })).status).toBe(403)
    expect((await POST({ headers: headers({ "content-type": "text/plain", origin: "https://app.example.com", host: "app.example.com" }) })).status).toBe(403)
    expect((await POST({ headers: headers({ host: "app.example.com" }) })).status).toBe(403)
  })
  for (const role of NON_ADMIN_ROLES) {
    it(`${role} with a perfect request is still refused`, async () => {
      h.user = ROLES[role] as FakeUser | null
      expect((await POST({ headers: ok })).status).toBe(403)
    })
  }
})

describe("the scan (the checker itself)", () => {
  const good = `import { requireAdminRoute } from "@/lib/auth/require-admin-route"\nexport async function GET() {\n  const denied = await requireAdminRoute()\n  if (denied) return denied\n  const x = await db()\n}`
  it("a route that opens with the gate passes", () => expect(adminRouteViolations("r.ts", good)).toEqual([]))
  it("a POST must use the JSON gate", () => {
    expect(adminRouteViolations("r.ts", `export async function POST(req) {\n  const denied = await requireAdminJsonRoute(req)\n}`)).toEqual([])
    expect(adminRouteViolations("r.ts", `export async function POST(req) {\n  const denied = await requireAdminRoute()\n}`)).toHaveLength(1)
  })
  it("a database read BEFORE the gate fails (a gate that comes late is no gate)", () => {
    expect(adminRouteViolations("r.ts", `export async function GET() {\n  const rows = await db.from("x")\n  const denied = await requireAdminRoute()\n}`)).toHaveLength(1)
  })
  it("dead code does not fool it: the word in a comment or an unused import is not a gate", () => {
    expect(adminRouteViolations("r.ts", `// requireAdminRoute\nimport { requireAdminRoute } from "x"\nexport async function GET() {\n  const r = await db()\n}`)).toHaveLength(1)
  })
  it("the weaker checks are forbidden", () => {
    expect(adminRouteViolations("r.ts", `${good}\nimport { requireStaffRoute } from "y"`).length).toBeGreaterThan(0)
    expect(adminRouteViolations("r.ts", `${good}\nif (!isDashboardUser(u)) {}`).length).toBeGreaterThan(0)
  })
  it("a handler written in a form the scan cannot read is flagged, not skipped", () => {
    expect(adminRouteViolations("r.ts", `export const GET = async () => {}`)).toHaveLength(1)
  })
  it("pages and layouts must call isSecureAdmin", () => {
    expect(adminPageViolations("page.tsx", `if (!isSecureAdmin(user)) redirect("/")`)).toEqual([])
    expect(adminPageViolations("page.tsx", `export default function P() {}`)).toHaveLength(1)
    expect(adminPageViolations("page.tsx", `isSecureAdmin(u); isDashboardUser(u)`)).toHaveLength(1)
  })
})

describe("every real Booking route, page and layout keeps the gate (empty until Stage 1b adds them)", () => {
  const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [])
  const root = process.cwd()
  const routes = walk(path.join(root, "app", "api", "booking")).filter((f) => /route\.ts$/.test(f))
  const pages = walk(path.join(root, "app", "(dashboard)", "booking")).filter((f) => /(page|layout)\.tsx?$/.test(f))
  it("API routes", () => {
    const bad = routes.flatMap((f) => adminRouteViolations(path.relative(root, f), fs.readFileSync(f, "utf8")))
    expect(bad).toEqual([])
  })
  it("pages and layouts", () => {
    const bad = pages.flatMap((f) => adminPageViolations(path.relative(root, f), fs.readFileSync(f, "utf8")))
    expect(bad).toEqual([])
  })
})
