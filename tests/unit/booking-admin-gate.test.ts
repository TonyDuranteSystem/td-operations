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

describe("the scan (the checker itself) — routes", () => {
  const G = `const denied = await requireAdminRoute()\n  if (denied) return denied\n`
  const GJ = `const denied = await requireAdminJsonRoute(req)\n  if (denied) return denied\n`
  const good = `import { requireAdminRoute } from "@/lib/auth/require-admin-route"\nexport async function GET() {\n  ${G}  const x = await db()\n}`
  const v = (src: string) => adminRouteViolations("r.ts", src)

  describe("a handler that opens with the gate passes, in EVERY export form", () => {
    it("export async function", () => expect(v(good)).toEqual([]))
    it("export function (non-async) is refused: the gate is an await", () => expect(v(`export function GET() {\n  return 1\n}`)).toHaveLength(1))
    it("export const X = async () => {}", () => expect(v(`export const GET = async () => {\n  ${G}}`)).toEqual([]))
    it("export const X = async function () {}", () => expect(v(`export const POST = async function (req) {\n  ${GJ}}`)).toEqual([]))
    it("export const X = async (req: NextRequest): Promise<NextResponse> => {}", () => expect(v(`export const POST = async (req: NextRequest): Promise<NextResponse> => {\n  ${GJ}}`)).toEqual([]))
    it("typed parameters and a return type that itself holds braces", () => {
      expect(v(`export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response | { ok: boolean }> {\n  ${G}}`)).toEqual([])
    })
    it("export { name as GET } resolved to a function in the same file", () => expect(v(`async function h() {\n  ${G}}\nexport { h as GET }`)).toEqual([]))
    it("export { POST } resolved to a const arrow in the same file", () => expect(v(`const POST = async (req) => {\n  ${GJ}}\nexport { POST }`)).toEqual([]))
    it("a route that only exports page settings (no handler) passes", () => expect(v(`export const dynamic = "force-dynamic"\nexport const maxDuration = 30`)).toEqual([]))
    it("exported types are ignored", () => expect(v(`export type Body = { a: number }\nexport interface Q { b: string }\n${good}`)).toEqual([]))
  })

  describe("the same forms FAIL when the gate is missing", () => {
    it("export async function", () => expect(v(`export async function GET() {\n  const r = await db()\n}`)).toHaveLength(1))
    it("export const arrow", () => expect(v(`export const GET = async () => {\n  const r = await db()\n}`)).toHaveLength(1))
    it("export const async function expression", () => expect(v(`export const POST = async function (req) {\n  const r = await db()\n}`)).toHaveLength(1))
    it("export { name as POST }", () => expect(v(`async function h(req) {\n  const r = await db()\n}\nexport { h as POST }`)).toHaveLength(1))
    it("export { POST } of a const", () => expect(v(`const POST = async (req) => {\n  const r = await db()\n}\nexport { POST }`)).toHaveLength(1))
    it("HEAD and OPTIONS handlers need the gate too", () => {
      expect(v(`export async function HEAD() {\n  const r = await db()\n}`)).toHaveLength(1)
      expect(v(`export async function OPTIONS() {\n  const r = await db()\n}`)).toHaveLength(1)
    })
  })

  describe("a file with one correct handler cannot hide a bad one (the hole this scan used to have)", () => {
    it("correct GET + `export const POST = async` with no gate", () => {
      expect(v(`${good}\nexport const POST = async (req) => {\n  const r = await db()\n}`)).toHaveLength(1)
    })
    it("correct GET + `export { h as POST }` with no gate", () => {
      expect(v(`${good}\nasync function h(req) {\n  const r = await db()\n}\nexport { h as POST }`)).toHaveLength(1)
    })
    it("correct GET + a DELETE written as a const function expression with no gate", () => {
      expect(v(`${good}\nexport const DELETE = async function (req) {\n  const r = await db()\n}`)).toHaveLength(1)
    })
    it("a handler with NO await followed by a handler WITH the gate: the first is not excused by the second", () => {
      expect(v(`export async function GET() {\n  return 1\n}\nexport async function POST(req) {\n  ${GJ}}`)).toHaveLength(1)
    })
  })

  describe("anything this scan cannot read is a violation, never a pass", () => {
    it("export { h as POST } from another file", () => expect(v(`export { h as POST } from "./elsewhere"`)).toHaveLength(1))
    it("export * from another file", () => expect(v(`export * from "./elsewhere"`)).toHaveLength(1))
    it("a handler wrapped in a call: export const POST = wrap(async () => {})", () => expect(v(`export const POST = wrap(async (req) => {\n  ${GJ}})`)).toHaveLength(1))
    it("a re-export of something not defined here", () => expect(v(`export { missing as GET }`)).toHaveLength(1))
    it("an expression-bodied arrow (the gate cannot be seen)", () => expect(v(`export const GET = async () => json()`)).toHaveLength(1))
    it("a default export in a route", () => expect(v(`export default async function () {\n  ${G}}`)).toHaveLength(1))
    it("an unknown value export in a route", () => expect(v(`${good}\nexport const helper = 1`)).toHaveLength(1))
    it("destructured exports", () => expect(v(`export const { GET } = handlers`)).toHaveLength(1))
    it("a quote inside a regex literal does not hide a later ungated export", () => {
      expect(v(`const re = /"/\nexport const POST = async (req) => {\n  const r = await db()\n}`)).toHaveLength(1)
    })
    it("an await inside a template expression counts as an await before the gate", () => {
      const tpl = ["`x ", "$", "{await db()} y`"].join("")
      expect(v(`export async function GET() {\n  const s = ${tpl}\n  const denied = await requireAdminRoute()\n  if (denied) return denied\n}`)).toHaveLength(1)
    })
    it("a file that ends inside a string / comment", () => {
      expect(v(`export async function GET() {\n  ${G}}\nconst s = "unterminated`)).toHaveLength(1)
      expect(v(`export async function GET() {\n  ${G}}\n/* never closed`)).toHaveLength(1)
    })
  })

  describe("the gate has to be real, not just present", () => {
    it("a POST must use the JSON gate", () => {
      expect(v(`export async function POST(req) {\n  ${GJ}}`)).toEqual([])
      expect(v(`export async function POST(req) {\n  ${G}}`)).toHaveLength(1)
    })
    it("a database read BEFORE the gate fails (a gate that comes late is no gate)", () => {
      expect(v(`export async function GET() {\n  const rows = await db.from("x")\n  ${G}}`)).toHaveLength(1)
    })
    it("dead code does not fool it: the word in a comment, a string or an unused import is not a gate", () => {
      expect(v(`// requireAdminRoute\nimport { requireAdminRoute } from "x"\nexport async function GET() {\n  const r = await db()\n}`)).toHaveLength(1)
      expect(v(`export async function GET() {\n  const s = "await requireAdminRoute()"\n  // const denied = await requireAdminRoute()\n  const r = await db()\n}`)).toHaveLength(1)
      expect(v(`export async function GET() {\n  const s = \`\n  await requireAdminRoute()\n  \`\n  const r = await db()\n}`)).toHaveLength(1)
    })
    it("the gate called but its refusal ignored is no gate", () => {
      expect(v(`export async function GET() {\n  await requireAdminRoute()\n  const r = await db()\n}`)).toHaveLength(1)
      expect(v(`export async function GET() {\n  const denied = await requireAdminRoute()\n  const r = await db()\n}`)).toHaveLength(1)
    })
    it("a refusal written as a block is fine", () => {
      expect(v(`export async function GET() {\n  const denied = await requireAdminRoute()\n  if (denied) { return denied }\n}`)).toEqual([])
    })
    it("the weaker checks are forbidden", () => {
      expect(v(`${good}\nimport { requireStaffRoute } from "y"`).length).toBeGreaterThan(0)
      expect(v(`${good}\nif (!isDashboardUser(u)) {}`).length).toBeGreaterThan(0)
    })
    it("sync statements before the gate are fine; the gate must still be the first await", () => {
      expect(v(`export async function GET(req) {\n  const url = new URL(req.url)\n  ${G}}`)).toEqual([])
    })
  })
})

describe("the scan — pages and layouts", () => {
  const p = (src: string) => adminPageViolations("page.tsx", src)
  const ok = `export default async function Page() {\n  const user = await getUser()\n  if (!isSecureAdmin(user)) redirect("/")\n  const rows = await db.from("x")\n}`
  it("a page whose render function turns a non-admin away passes", () => expect(p(ok)).toEqual([]))
  it("the compound form used elsewhere in the CRM passes too", () => {
    expect(p(`export default async function Page() {\n  const caller = await getUser()\n  if (!caller || !isSecureAdmin(caller)) {\n    notFound()\n  }\n}`)).toEqual([])
  })
  it("an arrow default export and a named default export resolve to the function", () => {
    expect(p(`const Page = async () => {\n  const u = await getUser()\n  if (!isSecureAdmin(u)) redirect("/")\n}\nexport default Page`)).toEqual([])
    expect(p(`const Page = async () => {\n  const r = await db.from("x")\n}\nexport default Page`)).toHaveLength(1)
  })
  it("the word anywhere else is no guard: a helper, a variable that is never acted on, an unused import", () => {
    expect(p(`import { isSecureAdmin } from "@/lib/auth"\nexport default function Page() {\n  return null\n}`)).toHaveLength(1)
    expect(p(`function helper(u) {\n  return isSecureAdmin(u)\n}\nexport default async function Page() {\n  const r = await db.from("x")\n}`)).toHaveLength(1)
    expect(p(`export default async function Page() {\n  const ok = isSecureAdmin(u)\n  const r = await db.from("x")\n}`)).toHaveLength(1)
  })
  it("a database read BEFORE the check fails", () => {
    expect(p(`export default async function Page() {\n  const rows = await db.from("x")\n  if (!isSecureAdmin(u)) redirect("/")\n}`)).toHaveLength(1)
  })
  it("a client component cannot guard anything", () => {
    expect(p(`"use client"\n${ok}`)).toHaveLength(1)
    expect(p(`// note\n'use client'\n${ok}`)).toHaveLength(1)
  })
  it("a page with no default export, or one it cannot read, fails", () => {
    expect(p(`export const dynamic = "force-dynamic"`)).toHaveLength(1)
    expect(p(`export default wrap(Page)`)).toHaveLength(1)
    expect(p(`export { Page as default } from "./elsewhere"`)).toHaveLength(1)
  })
  it("static exports are fine; a data-reading generateMetadata needs the guard too", () => {
    expect(p(`export const metadata = { title: "Booking" }\nexport const dynamic = "force-dynamic"\n${ok}`)).toEqual([])
    expect(p(`${ok}\nexport async function generateMetadata() {\n  const r = await db.from("x")\n}`)).toHaveLength(1)
    expect(p(`${ok}\nexport async function generateMetadata() {\n  if (!isSecureAdmin(u)) return {}\n}`)).toEqual([])
  })
  it("an unknown export fails", () => expect(p(`${ok}\nexport const helper = 1`)).toHaveLength(1))
  it("the weaker checks are forbidden", () => {
    expect(p(`${ok}\nisDashboardUser(u)`).length).toBeGreaterThan(0)
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
