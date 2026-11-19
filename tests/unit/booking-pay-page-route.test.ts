/**
 * Paid booking links (dev job 74432428): the PUBLIC payment page /pay/b/<code>. GET changes nothing and leaks no person data; every answer is not cached, not framed and sends no
 * referrer; the only place a person is ever sent is a Stripe card page; a "wait" answer carries its own button (a double tap is never a dead end).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { miniDb, type MiniDb } from "./helpers/mini-db"

const h = vi.hoisted(() => ({ db: null as unknown as MiniDb, open: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({ get supabaseAdmin() { return h.db } }))
vi.mock("@/lib/calendly/api", async (orig) => ({ ...(await orig<typeof import("@/lib/calendly/api")>()), calendlyCtxFromEnv: () => ({ token: null, http: async () => ({ status: 500, json: async () => ({}) }) }) }))
vi.mock("@/lib/booking/pay-session", async (orig) => ({ ...(await orig<typeof import("@/lib/booking/pay-session")>()), openPayment: h.open }))

import { GET, POST } from "@/app/pay/b/[code]/route"
const STRIPE_PAGE_PREFIX = "https://checkout.stripe.com/"

const PAYCODE = "2hhvDHUcAPqPBTXdD8HMqw"
const ctx = (code: string) => ({ params: Promise.resolve({ code }) })
const req = (method: string) => new NextRequest("https://app.example.com/pay/b/x", { method })
const row = (over: Record<string, unknown> = {}) => ({
  id: "b0000000-0000-4000-8000-000000000001", public_id: "YajC1ZB9eYDY8WC8tnLnxA", contact_id: "c0000000-0000-4000-8000-000000000001", lead_id: null, person_name: "Secret Person Name",
  person_emails: ["secret@example.com"], claimed_event_uri: null, revoked_at: null, pay_amount_cents: 39700, pay_currency: "EUR", pay_label: "Strategic <b>call</b> & \"more\"", pay_mode: "credit",
  pay_code: PAYCODE, stripe_session_id: null, session_expires_at: null, session_claim_at: null, paid_session_id: null, not_charging_at: null, ...over,
})

beforeEach(() => {
  h.db = miniDb({ booking_links: [row()] })
  h.open.mockReset()
})

const hardened = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store")
  expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  expect(res.headers.get("x-frame-options")).toBe("DENY")
}

const BOOKED = { status: "claimed", claimed_event_uri: "https://api.calendly.com/scheduled_events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }

describe("GET /pay/b/<code>", () => {
  it("nobody has booked yet: the BOOK view (free times, details, one button); amount and label escaped; the person's name and email only as the typed-in defaults; changes nothing", async () => {
    const res = await GET(req("GET"), ctx(PAYCODE))
    const html = await res.text()
    expect(res.status).toBe(200)
    hardened(res)
    expect(html).toContain("€397.00")
    expect(html).toContain("Strategic &lt;b&gt;call&lt;/b&gt; &amp; &quot;more&quot;")
    expect(html).not.toContain("<b>call</b>")
    expect(html).toContain("Book and pay")
    expect(html).toContain('id="name"')
    expect(html).toContain('value="Secret Person Name"') // pre-filled in a field the person can change, escaped; never printed as page text
    expect(html).toContain('value="secret@example.com"')
    expect(html).toContain("30-minute video call")
    expect(html).toContain('id="pick"') // the chosen time is written out under the chips, so a pick is always visible
    expect(html).toContain("load(true)") // after a refused booking the times reload but the message stays on screen
    expect(html).not.toContain("Pay by card") // the card button only exists once a time is booked
    expect(html).toContain(`/pay/b/'+CODE+'/times`) // the script talks to this page's own two addresses only
    expect(h.open).not.toHaveBeenCalled() // a mail scanner or a chat app opening the link never books or makes a card page
    expect(h.db.log.every((l) => l.op === "select")).toBe(true)
  })
  it("a name with markup or quotes can never break out of the page", async () => {
    h.db = miniDb({ booking_links: [row({ person_name: `"><script>alert(1)</script>`, person_emails: [`a"onfocus="x@example.com`] })] })
    const html = await (await GET(req("GET"), ctx(PAYCODE))).text()
    expect(html).not.toContain("<script>alert(1)")
    expect(html).not.toContain(`value="a"onfocus`)
    expect((html.match(/<script>/g) ?? []).length).toBe(1) // only the page's own script
  })
  it("a time is booked and nothing is paid: the PAY view (amount, Pay by card), nothing about the person", async () => {
    h.db = miniDb({ booking_links: [row(BOOKED)] })
    const res = await GET(req("GET"), ctx(PAYCODE))
    const html = await res.text()
    expect(res.status).toBe(200)
    hardened(res)
    expect(html).toContain("€397.00")
    expect(html).toContain("Pay by card")
    expect(html).toContain('method="post"')
    expect(html).not.toContain("Secret Person Name")
    expect(html).not.toContain("secret@example.com")
    expect(html).not.toContain("Book and pay")
    expect(h.db.log.every((l) => l.op === "select")).toBe(true)
  })
  it("an expired link that nobody booked on cannot take a booking (410); a link revoked says nothing is due", async () => {
    h.db = miniDb({ booking_links: [row({ expires_at: "2020-01-01T00:00:00Z" })] })
    expect((await GET(req("GET"), ctx(PAYCODE))).status).toBe(410)
    h.db = miniDb({ booking_links: [row({ revoked_at: "2026-11-15T10:00:00Z" })] })
    expect((await GET(req("GET"), ctx(PAYCODE))).status).toBe(410)
  })
  it("a paid link says so; a stopped / 'Not charging' link says nothing is due (410); an unknown, malformed or free link is the same 404", async () => {
    h.db = miniDb({ booking_links: [row({ paid_session_id: "cs_1" })] })
    expect((await GET(req("GET"), ctx(PAYCODE))).status).toBe(200)
    h.db = miniDb({ booking_links: [row({ not_charging_at: "2026-11-15T10:00:00Z" })] })
    const stopped = await GET(req("GET"), ctx(PAYCODE))
    expect(stopped.status).toBe(410)
    hardened(stopped)
    h.db = miniDb({ booking_links: [row({ pay_amount_cents: null, pay_code: null })] })
    const bodies: string[] = []
    for (const code of [PAYCODE, "short", "ZZZZZZZZZZZZZZZZZZZZZZ", "../../etc"]) {
      const r = await GET(req("GET"), ctx(code))
      expect(r.status).toBe(404)
      hardened(r)
      bodies.push(await r.text())
    }
    expect(new Set(bodies).size).toBe(1)
  })
  it("a database that fails is 'try again' (503), never 'not found'", async () => {
    h.db = miniDb({}, { failing: { booking_links: "boom" } })
    expect((await GET(req("GET"), ctx(PAYCODE))).status).toBe(503)
  })
})

describe("POST /pay/b/<code>", () => {
  it("sends the person to Stripe's own card page and nowhere else", async () => {
    h.open.mockResolvedValue({ ok: true, url: `${STRIPE_PAGE_PREFIX}c/pay/cs_live_1` })
    const res = await POST(req("POST"), ctx(PAYCODE))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe(`${STRIPE_PAGE_PREFIX}c/pay/cs_live_1`)
    hardened(res)
  })
  it("a Stripe sub-domain (a Stripe-hosted custom page) is accepted, https only", async () => {
    h.open.mockResolvedValue({ ok: true, url: "https://pay.stripe.com/c/x" })
    const res = await POST(req("POST"), ctx(PAYCODE))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://pay.stripe.com/c/x")
  })
  it("refuses any other address, whatever the answer said", async () => {
    for (const url of ["https://evil.example/x", "http://checkout.stripe.com/x", "https://checkout.stripe.com.evil.example/x", "https://evilstripe.com/x", "https://user:pw@checkout.stripe.com/x", "https://checkout.stripe.com:8443/x", "javascript:alert(1)", "//evil.example"]) {
      h.open.mockResolvedValue({ ok: true, url })
      const res = await POST(req("POST"), ctx(PAYCODE))
      expect(res.status, url).toBe(502)
      expect(res.headers.get("location")).toBeNull()
      expect(await res.text()).toContain("Try again")
    }
  })
  it("'wait', 'try again' and Stripe problems carry their own Try again button; a final answer does not", async () => {
    for (const [reason, status, retry] of [["busy", 503, true], ["stripe", 502, true], ["error", 503, true], ["paid", 200, false], ["stopped", 410, false], ["cancelled", 410, false], ["none", 404, false]] as const) {
      h.open.mockResolvedValue({ ok: false, reason, message: `msg-${reason}` })
      const res = await POST(req("POST"), ctx(PAYCODE))
      const html = await res.text()
      expect(res.status, reason).toBe(status)
      hardened(res)
      expect(html).toContain(`msg-${reason}`)
      expect(html.includes('<button type="submit">Try again</button>'), reason).toBe(retry)
    }
  })
})
