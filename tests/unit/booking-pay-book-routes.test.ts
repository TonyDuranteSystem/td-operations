/**
 * Paid booking links (dev job 20af2e28, 16 Nov 2026): the two public JSON routes behind the "book and pay" page (/pay/b/<code>/times and /pay/b/<code>/book) and the redirect that
 * sends a paid link to that page instead of to Calendly. Pinned: hardened headers on every answer, the same-site check and the small body on the booking route, Calendly's own
 * words never reach the page, and a paid link never goes to a Calendly page (while a free link still does).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { miniDb, type MiniDb } from "./helpers/mini-db"
import type { CalendlyCtx } from "@/lib/calendly/api"

const h = vi.hoisted(() => ({ db: null as unknown as MiniDb, ctx: null as unknown as CalendlyCtx, posts: [] as string[] }))
vi.mock("@/lib/supabase-admin", () => ({ get supabaseAdmin() { return h.db } }))
vi.mock("@/lib/calendly/api", async (orig) => ({ ...(await orig<typeof import("@/lib/calendly/api")>()), calendlyCtxFromEnv: () => h.ctx }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async () => null }))

import { GET as timesGET } from "@/app/pay/b/[code]/times/route"
import { POST as bookPOST } from "@/app/pay/b/[code]/book/route"
import { decideRedirect } from "@/lib/booking/redirect"
import { payUrl } from "@/lib/booking/payment"

const CODE = "2hhvDHUcAPqPBTXdD8HMqw"
const PUBLIC_ID = "YajC1ZB9eYDY8WC8tnLnxA"
const TYPE_UUID = "0b859751-f477-47c1-a40a-56d04235d84e"
const EVENT_URI = "https://api.calendly.com/scheduled_events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INVITEE_URI = `${EVENT_URI}/invitees/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const ctx = (code: string) => ({ params: Promise.resolve({ code }) })

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "b0000000-0000-4000-8000-000000000001", public_id: PUBLIC_ID, contact_id: null, lead_id: null, person_name: "Maria Rossi", person_emails: ["maria@example.com"], claimed_event_uri: null, revoked_at: null,
  status: "open", expires_at: null, duration_minutes: 30, once: true, share_url: null, template_slug: "plain", open_count: 0, pay_amount_cents: 100, pay_currency: "USD", pay_label: "call", pay_mode: "credit",
  pay_code: CODE, stripe_session_id: null, session_expires_at: null, session_claim_at: null, paid_session_id: null, not_charging_at: null, ...over,
})
const settings = [
  { key: "booking", value: { mode: "page" } },
  { key: "booking_templates", value: { plain: { event_type_uri: `https://api.calendly.com/event_types/${TYPE_UUID}`, scheduling_url: "https://calendly.com/x/new-meeting" } } },
]

function calendlyCtx(over: { slots?: number; book?: number } = {}): CalendlyCtx {
  return {
    token: "t",
    http: async (req) => {
      const u = new URL(req.url)
      if (u.pathname === "/event_type_available_times") return { status: over.slots ?? 200, json: async () => ({ collection: [{ status: "available", start_time: "2099-01-05T18:00:00.000000Z" }] }) }
      if (u.pathname === "/invitees") {
        h.posts.push(req.body as string)
        return { status: over.book ?? 201, json: async () => ({ resource: { uri: INVITEE_URI, event: EVENT_URI } }) }
      }
      if (u.pathname.startsWith("/event_types/")) return { status: 200, json: async () => ({ resource: { uri: `https://api.calendly.com/event_types/${TYPE_UUID}`, name: "N", active: true, duration: 30, scheduling_url: "https://calendly.com/x/n", locations: [{ kind: "zoom_conference" }] } }) }
      return { status: 404, json: async () => ({}) }
    },
  }
}

beforeEach(() => {
  h.db = miniDb({ booking_links: [linkRow()], app_settings: settings })
  h.ctx = calendlyCtx()
  h.posts = []
})

const hardened = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  expect(res.headers.get("x-frame-options")).toBe("DENY")
  expect(res.headers.get("content-type")).toContain("application/json")
}

const soon = () => new Date(Date.now() + 3 * 86_400_000).toISOString()
const bookReq = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://app.example.com/pay/b/x/book", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", host: "app.example.com", ...headers } })
const good = (over: Record<string, unknown> = {}) => ({ start: soon(), name: "Maria Rossi", email: "maria@example.com", timezone: "Europe/Rome", ...over })

describe("GET /pay/b/<code>/times", () => {
  it("returns the free times, hardened, and changes nothing", async () => {
    const res = await timesGET(new NextRequest("https://app.example.com/pay/b/x/times"), ctx(CODE))
    expect(res.status).toBe(200)
    hardened(res)
    expect(await res.json()).toEqual({ ok: true, slots: ["2099-01-05T18:00:00.000Z"], minutes: 30 })
    expect(h.db.log.every((l) => l.op === "select")).toBe(true)
  })
  it("an unknown code is a 404 with the plain sentence; a link that cannot book says so; Calendly trouble is a 502 without Calendly's words", async () => {
    const none = await timesGET(new NextRequest("https://app.example.com/pay/b/x/times"), ctx("short"))
    expect(none.status).toBe(404)
    hardened(none)
    h.db = miniDb({ booking_links: [linkRow({ status: "claimed", claimed_event_uri: EVENT_URI })], app_settings: settings })
    expect(await (await timesGET(new NextRequest("https://app.example.com/pay/b/x/times"), ctx(CODE))).json()).toMatchObject({ ok: false, reason: "booked" })
    h.db = miniDb({ booking_links: [linkRow()], app_settings: settings })
    h.ctx = calendlyCtx({ slots: 429 })
    const busy = await timesGET(new NextRequest("https://app.example.com/pay/b/x/times"), ctx(CODE))
    expect(busy.status).toBe(502)
    expect(JSON.stringify(await busy.json())).not.toMatch(/429/)
  })
})

describe("POST /pay/b/<code>/book", () => {
  it("books the picked time and answers with its start; the link is marked booked", async () => {
    const res = await bookPOST(bookReq(good()), ctx(CODE))
    expect(res.status).toBe(200)
    hardened(res)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(h.db.tables.booking_links[0]).toMatchObject({ status: "claimed", claimed_event_uri: EVENT_URI })
    expect(h.posts).toHaveLength(1)
    expect(JSON.parse(h.posts[0]).tracking).toEqual({ utm_term: PUBLIC_ID })
  })
  it("a request from another site is refused (403) before anything is read or asked; the same site and no Origin at all are accepted", async () => {
    const foreign = await bookPOST(bookReq(good(), { origin: "https://evil.example" }), ctx(CODE))
    expect(foreign.status).toBe(403)
    hardened(foreign)
    expect(h.posts).toHaveLength(0)
    expect(h.db.log).toHaveLength(0)
    expect((await bookPOST(bookReq(good(), { origin: "not a url" }), ctx(CODE))).status).toBe(403)
    expect((await bookPOST(bookReq(good(), { origin: "https://app.example.com" }), ctx(CODE))).status).toBe(200)
  })
  it("a body that is not a small JSON object is refused (400) and asks Calendly nothing", async () => {
    for (const body of ["not json", "[]", "null", "5", JSON.stringify({ name: "x".repeat(5000) })]) {
      const res = await bookPOST(bookReq(body), ctx(CODE))
      expect(res.status, body.slice(0, 20)).toBe(400)
      hardened(res)
    }
    expect(h.posts).toHaveLength(0)
  })
  it("missing or wrong details are 400 with a plain sentence; a time somebody took is 409 and Calendly's words never reach the page", async () => {
    const noName = await bookPOST(bookReq(good({ name: "" })), ctx(CODE))
    expect(noName.status).toBe(400)
    expect(await noName.json()).toMatchObject({ ok: false, reason: "invalid", message: "Please write your name." })
    h.ctx = calendlyCtx({ book: 400 })
    const taken = await bookPOST(bookReq(good()), ctx(CODE))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ ok: false, reason: "taken" })
    expect(h.db.tables.booking_links[0]).toMatchObject({ status: "open", claimed_event_uri: null })
  })
  it("a second booking on the same link is refused (409): a paid link is one call", async () => {
    expect((await bookPOST(bookReq(good()), ctx(CODE))).status).toBe(200)
    const again = await bookPOST(bookReq(good()), ctx(CODE))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ reason: "booked" })
    expect(h.posts).toHaveLength(1)
  })
})

describe("the redirect for a paid link", () => {
  const NOW = new Date("2026-11-16T17:00:00.000Z")
  const decide = (db: MiniDb) => decideRedirect(db, PUBLIC_ID, { now: NOW, userAgent: "Mozilla/5.0" })

  it("a PAID link goes to OUR page /pay/b/<code>, never to Calendly, whatever share address it holds", async () => {
    for (const share of [null, "https://calendly.com/d/old-share/new-meeting"]) {
      const r = await decide(miniDb({ booking_links: [linkRow({ share_url: share })], app_settings: settings }))
      expect(r).toEqual({ kind: "redirect", location: payUrl(CODE), tagged: true })
    }
  })
  it("a paid link that is already booked still goes to the page (it shows the payment); a stopped or expired one does not reach it", async () => {
    expect(await decide(miniDb({ booking_links: [linkRow({ status: "claimed", claimed_event_uri: EVENT_URI })], app_settings: settings }))).toMatchObject({ kind: "redirect", location: payUrl(CODE) })
    for (const over of [{ revoked_at: "2026-11-15T10:00:00Z" }, { expires_at: "2026-11-15T10:00:00Z" }]) {
      const r = await decide(miniDb({ booking_links: [linkRow(over)], app_settings: settings }))
      expect(r).toMatchObject({ kind: "redirect", tagged: false })
      expect((r as { location: string }).location).not.toContain("/pay/b/")
    }
  })
  it("with the Booking switch off a paid link behaves as before: the plain public booking page, no tag", async () => {
    const r = await decide(miniDb({ booking_links: [linkRow()], app_settings: [{ key: "booking", value: { mode: "off" } }] }))
    expect(r).toMatchObject({ kind: "redirect", tagged: false })
    expect((r as { location: string }).location).not.toContain("/pay/b/")
  })
  it("a FREE link is unchanged: it still goes to Calendly with its tag", async () => {
    const free = linkRow({ pay_amount_cents: null, pay_currency: null, pay_code: null, pay_label: null, pay_mode: null, share_url: "https://calendly.com/d/abc-123/new-meeting", once: true })
    const r = await decide(miniDb({ booking_links: [free], app_settings: settings }))
    expect(r).toMatchObject({ kind: "redirect", tagged: true })
    expect((r as { location: string }).location).toContain("calendly.com/d/abc-123/new-meeting")
    expect((r as { location: string }).location).toContain(`utm_term=${PUBLIC_ID}`)
  })
})
