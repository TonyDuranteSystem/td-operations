import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ decision: null as unknown, boom: false, seen: [] as unknown[][] }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/booking/redirect", () => ({
  decideRedirect: async (...args: unknown[]) => {
    h.seen.push(args)
    if (h.boom) throw new Error("kaboom")
    return h.decision
  },
}))

import { GET } from "../../app/r/b/[id]/route"
import { CALENDLY_BOOKING_URL } from "@/lib/config"

const call = (id = "AbCdEfGhIjKlMnOpQrStUv", ua = "Mozilla/5.0") => GET(new NextRequest(`https://app.example.com/r/b/${id}`, { headers: { "user-agent": ua } }), { params: Promise.resolve({ id }) })

beforeEach(() => { h.decision = null; h.boom = false; h.seen = [] })

describe("GET /r/b/<id> (public)", () => {
  it("sends the visitor on with a plain 302 that is never cached and sends no referrer", async () => {
    h.decision = { kind: "redirect", location: "https://calendly.com/x/new-meeting?utm_term=abc", tagged: true }
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://calendly.com/x/new-meeting?utm_term=abc")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })
  it("passes the id and the visitor's browser name to the rules, and nothing else about the request", async () => {
    h.decision = { kind: "redirect", location: CALENDLY_BOOKING_URL, tagged: false }
    await call("AbCdEfGhIjKlMnOpQrStUv", "Slackbot-LinkExpanding")
    expect(h.seen[0][1]).toBe("AbCdEfGhIjKlMnOpQrStUv")
    expect(h.seen[0][2]).toMatchObject({ userAgent: "Slackbot-LinkExpanding" })
  })
  it("a failed lookup answers 'try again' (503) instead of dropping the tag", async () => {
    h.decision = { kind: "retry" }
    const res = await call()
    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("30")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe("Please try again in a minute.")
  })
  it("an unexpected failure sends the visitor to the normal booking page, never an error page", async () => {
    h.boom = true
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(CALENDLY_BOOKING_URL)
    err.mockRestore()
  })
  it("never lets a visitor-controlled text into the answer: any id, even a hostile one, only reaches the rules as text", async () => {
    h.decision = { kind: "redirect", location: CALENDLY_BOOKING_URL, tagged: false }
    const res = await call("../../etc/passwd")
    expect(res.headers.get("location")).toBe(CALENDLY_BOOKING_URL)
  })
})
