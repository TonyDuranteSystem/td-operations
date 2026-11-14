import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { miniDb, type MiniDb } from "./helpers/mini-db"
import { ROLES } from "./helpers/five-roles"
import { OFF_REFUSAL, OFF_TEXT, OFF_TITLE } from "@/lib/booking/mode-text"

/**
 * The Booking page TURNED OFF (Antonio, 14 Nov: "I want to see it in product but turned off"). While the `booking` setting is absent, malformed or "off":
 * an administrator still sees the page read-only; every route that changes or sends anything refuses in plain words; no write reaches the database and nothing reaches Calendly.
 * `page` and `live` work as before. Reads (the lists) keep working, including on a database whose booking tables are empty or not there yet.
 */
const h = vi.hoisted(() => ({ user: null as unknown, db: null as unknown }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: new Proxy({}, { get: (_t, k) => (h.db as Record<string | symbol, unknown>)[k] }) }))
vi.mock("@/lib/open-services/audience", () => ({ requireOpenServicesAccess: async () => ({ ok: false }) }))
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND") }, redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) } }))

const ROOT = path.resolve(__dirname, "../..")
const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [])
const routeFiles = walk(path.join(ROOT, "app", "api", "booking")).filter((f) => /route\.ts$/.test(f)).sort()
const CHANGING = ["POST", "PUT", "PATCH", "DELETE"]
const HOST = "app.example.com"
const req = (method: string, body: unknown = {}) =>
  new NextRequest(`https://${HOST}/api/booking/x?q=zz`, { method, headers: { host: HOST, ...(method === "GET" ? {} : { "content-type": "application/json", origin: `https://${HOST}` }) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) })
const ctx = { params: Promise.resolve({ id: "d0000000-0000-4000-8000-000000000001", slug: "client" }) }
const handlersOf = async (file: string) => {
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>
  return ["GET", ...CHANGING].filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as (r: NextRequest, c: typeof ctx) => Promise<Response>] as const)
}
const OFF_SETTINGS: Array<[string, Array<Record<string, unknown>>]> = [
  ["no setting at all", []],
  ["mode off", [{ key: "booking", value: { mode: "off" } }]],
  ["a malformed value", [{ key: "booking", value: { mode: "banana" } }]],
  ["a value that is not an object", [{ key: "booking", value: "live-ish" }]],
  ["an empty value", [{ key: "booking", value: null }]],
]

let fetchCalls = 0
beforeEach(() => {
  h.user = ROLES.admin
  fetchCalls = 0
  vi.stubGlobal("fetch", vi.fn(async () => { fetchCalls++; throw new Error("the network must not be used while the page is off") }))
})

describe("while the page is OFF, no change and no send gets through any route", () => {
  for (const [label, settings] of OFF_SETTINGS) {
    it(`${label}: every changing handler of every booking route answers 403 'Turned off', writes nothing and never calls Calendly`, async () => {
      const seen: string[] = []
      for (const file of routeFiles) {
        for (const [method, fn] of await handlersOf(file)) {
          if (method === "GET") continue
          const db: MiniDb = miniDb({ app_settings: settings, booking_links: [], call_checks: [], contacts: [], leads: [] })
          h.db = db
          const res = await fn(req(method, { person: { type: "new" }, kindSlug: "client", minutes: 45, answer: "dismiss", name: "X", choice: "record", rename: "Y" }), ctx)
          expect(res.status, `${path.relative(ROOT, file)} ${method}`).toBe(403)
          expect(await res.json()).toEqual({ error: OFF_REFUSAL, off: true })
          // the only thing it may have done is READ the setting
          for (const entry of db.log) expect(`${entry.table}:${entry.op}`, `${path.relative(ROOT, file)} ${method}`).toBe("app_settings:select")
          seen.push(`${path.relative(ROOT, file)}:${method}`)
        }
      }
      expect(fetchCalls).toBe(0)
      expect(seen.length).toBe(6) // links POST, revoke POST, kinds POST, kinds PATCH, preview POST, checks answer POST
    })
  }
  it("a non-admin is still refused first (the ordinary 403), off or not", async () => {
    h.user = ROLES.team
    h.db = miniDb({ app_settings: [] })
    for (const file of routeFiles) for (const [method, fn] of await handlersOf(file)) expect((await fn(req(method), ctx)).status).toBe(403)
  })
})

describe("while the page is OFF, the lists still load (read-only)", () => {
  it("the lists answer 200 on a database whose booking tables are empty", async () => {
    h.db = miniDb({ app_settings: [], booking_links: [], call_checks: [], catalog_entries: [], contacts: [], leads: [] })
    const { GET: links } = await import("../../app/api/booking/links/route")
    const { GET: kinds } = await import("../../app/api/booking/kinds/route")
    const { GET: people } = await import("../../app/api/booking/people/route")
    expect(await (await links()).json()).toEqual({ links: [] })
    expect(await (await kinds()).json()).toEqual({ kinds: [] })
    expect((await people(req("GET"))).status).toBe(200)
  })
  it("and on a database where the booking tables do not exist yet (the code is deployed before the tables are)", async () => {
    h.db = miniDb({ app_settings: [] }, { missing: ["booking_links", "call_checks", "contact_calls"] })
    const { GET: links } = await import("../../app/api/booking/links/route")
    expect(await (await links()).json()).toEqual({ links: [] })
  })
})

describe("the setting being page or live gives back today's behaviour", () => {
  for (const mode of ["page", "live"]) {
    it(`${mode}: a changing route gets past the 'Turned off' answer (here it stops at the next check, a bad request)`, async () => {
      const { POST } = await import("../../app/api/booking/preview/route")
      h.db = miniDb({ app_settings: [{ key: "booking", value: { mode } }] })
      const res = await POST(req("POST", { nonsense: true }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).not.toBe(OFF_REFUSAL)
    })
  }
})

describe("the page and the menu while off", () => {
  it("an administrator opens the page: the real workspace, in 'off' mode, with the reads still made", async () => {
    h.db = miniDb({ app_settings: [], catalog_entries: [], booking_links: [], call_checks: [] })
    const Page = (await import("../../app/(dashboard)/booking/page")).default
    const el = (await Page()) as { props: { children: { props: { mode: string; links: unknown[]; cards: unknown[]; kinds: unknown[] } } } }
    expect(el.props.children.props.mode).toBe("off")
    expect(el.props.children.props.links).toEqual([])
    expect(el.props.children.props.cards).toEqual([])
  })
  it("a non-admin still gets the ordinary not-found page", async () => {
    h.db = miniDb({ app_settings: [] })
    const Page = (await import("../../app/(dashboard)/booking/page")).default
    for (const role of ["team", "partner", "client", "marketing", "anonymous"] as const) {
      h.user = ROLES[role]
      await expect(Page(), role).rejects.toThrow("NEXT_NOT_FOUND")
    }
  })
  it("the page no longer turns an off setting into not-found; the menu item shows to every administrator, with an 'Off' tag while off", () => {
    const page = fs.readFileSync(path.join(ROOT, "app/(dashboard)/booking/page.tsx"), "utf8")
    expect(page).not.toMatch(/=== "off"\) notFound\(\)/)
    const layout = fs.readFileSync(path.join(ROOT, "app/(dashboard)/layout.tsx"), "utf8")
    expect(layout).toContain("const showBooking = !bare && admin")
    expect(layout).toContain("['booking', 'booking-off']")
    const sidebar = fs.readFileSync(path.join(ROOT, "components/dashboard/sidebar.tsx"), "utf8")
    expect(sidebar).toContain("item.id === 'booking' && enabledFeatures.includes('booking-off')")
    expect(sidebar).toContain("adminOnly: true, featureFlag: 'booking'")
  })
  it("every control that makes, stops or answers something is inactive while off, with the reason shown", () => {
    const maker = fs.readFileSync(path.join(ROOT, "components/booking/link-maker.tsx"), "utf8")
    expect(maker).toContain("<fieldset disabled={off}")
    expect(maker).toContain("const canMake = !off &&")
    expect(maker).toContain("OFF_REASON")
    const links = fs.readFileSync(path.join(ROOT, "components/booking/links-made.tsx"), "utf8")
    expect(links).toContain("disabled={off || busy === l.id}")
    expect(links).toContain("disabled={off}")
    expect(fs.readFileSync(path.join(ROOT, "components/calls-to-check/calls-tab.tsx"), "utf8")).toContain("disabled={off || busy !== null}")
    expect(fs.readFileSync(path.join(ROOT, "components/booking/booking-workspace.tsx"), "utf8")).toContain('data-testid="off-banner"')
  })
  it("the words are short and plain", () => {
    expect(OFF_TITLE).toBe("Turned off. Nothing here is live yet.")
    expect(OFF_TEXT).not.toMatch(/setting|mode|app_settings|flag|switch/i)
    expect(OFF_REFUSAL).toBe(OFF_TITLE)
  })
})
