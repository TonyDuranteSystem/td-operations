/**
 * Calendly API, the two calls "book and pay" needs (dev job 20af2e28): the free times of an event type (read) and booking one time (write, the Scheduling API).
 * Pinned: the query is built from fixed keys and encoded, only "available" times are kept, the booking body is exactly what Calendly's reference asks for, and the answer is trusted
 * only if it holds Calendly's own addresses. A refused request is a short plain kind, never Calendly's text.
 */
import { describe, it, expect } from "vitest"
import { calendlyRequest, listAvailableTimes, type CalendlyCtx, type CalendlyHttpRequest } from "@/lib/calendly/api"
import { bookInvitee } from "@/lib/calendly/api-write"

const TYPE = "https://api.calendly.com/event_types/0b859751-f477-47c1-a40a-56d04235d84e"
const EVENT = "https://api.calendly.com/scheduled_events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INVITEE = `${EVENT}/invitees/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`

function fake(status: number, body: unknown) {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = { token: "tok", http: async (req) => { calls.push(req); return { status, json: async () => body } } }
  return { ctx, calls }
}
const range = { start: new Date("2026-11-17T00:00:00.000Z"), end: new Date("2026-12-01T00:00:00.000Z") }

describe("the query of a read", () => {
  it("is added after the path, encoded, and a path that already carries one is still refused", async () => {
    const { ctx, calls } = fake(200, {})
    await calendlyRequest(ctx, "GET", "/event_type_available_times", undefined, { a: "x y&z", b: "2" })
    expect(calls[0].url).toBe("https://api.calendly.com/event_type_available_times?a=x+y%26z&b=2")
    await expect(calendlyRequest(ctx, "GET", "/x?evil=1", undefined, { a: "1" })).rejects.toMatchObject({ kind: "bad_request" })
    await calendlyRequest(ctx, "GET", "/users/me")
    expect(calls[1].url).toBe("https://api.calendly.com/users/me")
  })
})

describe("listAvailableTimes", () => {
  it("asks for the event type and the range, keeps only available times, as UTC, earliest first, without repeats", async () => {
    const { ctx, calls } = fake(200, { collection: [{ status: "available", start_time: "2026-11-17T19:00:00.000000Z" }, { status: "available", start_time: "2026-11-17T18:00:00.000000Z" }, { status: "booked", start_time: "2026-11-17T20:00:00Z" }, { status: "available", start_time: "2026-11-17T18:00:00Z" }, { status: "available", start_time: "nonsense" }, "x", null] })
    expect(await listAvailableTimes(ctx, TYPE, range)).toEqual(["2026-11-17T18:00:00.000Z", "2026-11-17T19:00:00.000Z"])
    const u = new URL(calls[0].url)
    expect(u.pathname).toBe("/event_type_available_times")
    expect(u.searchParams.get("event_type")).toBe(TYPE)
    expect(u.searchParams.get("start_time")).toBe("2026-11-17T00:00:00.000Z")
    expect(u.searchParams.get("end_time")).toBe("2026-12-01T00:00:00.000Z")
    expect(calls[0].method).toBe("GET")
  })
  it("an event type address that is not Calendly's, or an answer that is not a list, is refused", async () => {
    await expect(listAvailableTimes(fake(200, {}).ctx, "https://evil.example/event_types/0b859751-f477-47c1-a40a-56d04235d84e", range)).rejects.toMatchObject({ kind: "bad_request" })
    await expect(listAvailableTimes(fake(200, { collection: "x" }).ctx, TYPE, range)).rejects.toMatchObject({ kind: "bad_response" })
    await expect(listAvailableTimes(fake(403, { message: "secret" }).ctx, TYPE, range)).rejects.toMatchObject({ kind: "forbidden" })
  })
})

describe("bookInvitee", () => {
  const input = { eventTypeUri: TYPE, startTime: "2026-11-17T18:00:00.000Z", name: "Maria Rossi", email: "maria@example.com", timezone: "Europe/Rome", tag: "YajC1ZB9eYDY8WC8tnLnxA", locationKind: "zoom_conference" as string | null }

  it("sends exactly the event type, the time, the invitee, the place and the tag, and returns the booking's addresses", async () => {
    const { ctx, calls } = fake(201, { resource: { uri: INVITEE, event: EVENT, cancel_url: "https://calendly.com/cancellations/abc" } })
    expect(await bookInvitee(ctx, input)).toEqual({ inviteeUri: INVITEE, eventUri: EVENT, cancelUrl: "https://calendly.com/cancellations/abc" })
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://api.calendly.com/invitees")
    expect(JSON.parse(calls[0].body as string)).toEqual({ event_type: TYPE, start_time: input.startTime, invitee: { name: "Maria Rossi", email: "maria@example.com", timezone: "Europe/Rome" }, location: { kind: "zoom_conference" }, tracking: { utm_term: input.tag } })
  })
  it("no place named: none is sent; a cancel address that is not Calendly's is dropped", async () => {
    const { ctx, calls } = fake(201, { resource: { uri: INVITEE, event: EVENT, cancel_url: "https://evil.example/x" } })
    expect(await bookInvitee(ctx, { ...input, locationKind: null })).toMatchObject({ cancelUrl: null })
    expect(JSON.parse(calls[0].body as string).location).toBeUndefined()
  })
  it("an answer without Calendly's own addresses is not trusted (the booking exists, so the caller cancels it)", async () => {
    for (const resource of [{}, { uri: "https://evil.example/i", event: EVENT }, { uri: INVITEE, event: "https://evil.example/e" }, { uri: INVITEE }, null]) {
      await expect(bookInvitee(fake(201, { resource }).ctx, input), JSON.stringify(resource)).rejects.toMatchObject({ kind: "bad_response" })
    }
  })
  it("a refused request carries a short kind and never Calendly's words", async () => {
    for (const [status, kind] of [[400, "bad_request"], [401, "auth"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [500, "server"]] as const) {
      const err = await bookInvitee(fake(status, { message: "SECRET TEXT" }).ctx, input).catch((e) => e)
      expect(err.kind).toBe(kind)
      expect(String(err.message)).not.toContain("SECRET")
    }
  })
  it("an event type address that is not Calendly's is refused before any request", async () => {
    const { ctx, calls } = fake(201, {})
    await expect(bookInvitee(ctx, { ...input, eventTypeUri: "https://evil.example/event_types/0b859751-f477-47c1-a40a-56d04235d84e" })).rejects.toMatchObject({ kind: "bad_request" })
    expect(calls).toHaveLength(0)
  })
})
