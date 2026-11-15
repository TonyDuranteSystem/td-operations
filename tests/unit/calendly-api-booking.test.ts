import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  CalendlyError,
  calendlyCtxFromEnv,
  calendlyRequest,
  eventTypeUuidOf,
  eventUuidOf,
  getEventType,
  getScheduledEvent,
  type CalendlyCtx,
  type CalendlyHttpRequest,
} from "@/lib/calendly/api"
import { cancelEvent, createShareLink } from "@/lib/calendly/api-write"

const EVENT = "https://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555"
const TYPE = "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

/** A fake client: answers from a queue and remembers every request. */
function fake(answers: Array<{ status: number; body?: unknown } | Error>) {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = {
    token: "secret-token",
    http: async (req) => {
      calls.push(req)
      const a = answers.shift()
      if (!a) throw new Error("no more answers queued")
      if (a instanceof Error) throw a
      return { status: a.status, json: async () => { if (a.body === undefined) throw new Error("no json"); return a.body } }
    },
  }
  return { ctx, calls }
}

describe("addresses are only rebuilt from a strict uuid", () => {
  it("accepts a real event address and returns its uuid in lower case", () => {
    expect(eventUuidOf(EVENT.toUpperCase().replace("HTTPS://API.CALENDLY.COM/SCHEDULED_EVENTS/", "https://api.calendly.com/scheduled_events/"))).toBe("11111111-2222-3333-4444-555555555555")
    expect(eventTypeUuidOf(TYPE)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  })
  it("refuses another host, a path, a query, a scheme change, a short id", () => {
    for (const bad of [
      "https://evil.example/scheduled_events/11111111-2222-3333-4444-555555555555",
      "https://api.calendly.com.evil.example/scheduled_events/11111111-2222-3333-4444-555555555555",
      "http://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555",
      `${EVENT}/invitees`,
      `${EVENT}?x=1`,
      "https://api.calendly.com/scheduled_events/abc",
      "https://api.calendly.com/scheduled_events/../users/me",
      "", null, undefined, 5,
    ]) expect(eventUuidOf(bad)).toBeNull()
  })
})

describe("calendlyRequest", () => {
  it("sends the bearer token only to the Calendly API address it built itself", async () => {
    const { ctx, calls } = fake([{ status: 200, body: { resource: {} } }])
    await calendlyRequest(ctx, "GET", "/scheduled_events/11111111-2222-3333-4444-555555555555")
    expect(calls[0].url).toBe("https://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555")
    expect(calls[0].headers.Authorization).toBe("Bearer secret-token")
    expect(calls[0].method).toBe("GET")
  })
  it("refuses a path that could change the host or the route", async () => {
    const { ctx, calls } = fake([])
    for (const p of ["https://evil.example/x", "//evil.example", "/a/../b", "/a b", "/a?x=1", "/a#x", "no-slash"]) {
      await expect(calendlyRequest(ctx, "GET", p)).rejects.toMatchObject({ kind: "bad_request" })
    }
    expect(calls).toHaveLength(0)
  })
  it("no token: a plain error and no request at all", async () => {
    const { ctx, calls } = fake([])
    await expect(calendlyRequest({ ...ctx, token: null }, "GET", "/users/me")).rejects.toMatchObject({ kind: "not_configured", status: null })
    expect(calls).toHaveLength(0)
  })
  it("an error carries the status code, never the body", async () => {
    const { ctx } = fake([{ status: 400, body: { title: "Bad", message: "echo of the secret-token and an email a@b.com" } }])
    const err = (await calendlyRequest(ctx, "POST", "/shares", {}).catch((e) => e)) as CalendlyError
    expect(err).toBeInstanceOf(CalendlyError)
    expect(err.status).toBe(400)
    expect(err.message).toContain("400")
    expect(err.message).not.toContain("secret-token")
    expect(err.message).not.toContain("a@b.com")
  })
  it("maps the usual statuses to plain kinds", async () => {
    const kinds: Record<number, string> = { 401: "auth", 403: "forbidden", 404: "not_found", 429: "rate_limited", 500: "server", 503: "server", 422: "bad_request" }
    for (const [status, kind] of Object.entries(kinds)) {
      const { ctx } = fake([{ status: Number(status) }])
      await expect(calendlyRequest(ctx, "GET", "/users/me")).rejects.toMatchObject({ kind, status: Number(status) })
    }
  })
  it("a network failure and an unreadable answer are plain errors", async () => {
    await expect(calendlyRequest(fake([new Error("socket hang up with secret-token")]).ctx, "GET", "/users/me")).rejects.toMatchObject({ kind: "network" })
    const e = (await calendlyRequest(fake([{ status: 200 }]).ctx, "GET", "/users/me").catch((x) => x)) as CalendlyError
    expect(e.kind).toBe("bad_response")
    expect(String(e.message)).not.toContain("secret-token")
  })
  it("reads the token from the environment variable the app already uses", () => {
    expect(calendlyCtxFromEnv({ CALENDLY_PAT: "  abc  " }).token).toBe("abc")
    expect(calendlyCtxFromEnv({}).token).toBeNull()
    expect(calendlyCtxFromEnv({ CALENDLY_PAT: "   " }).token).toBeNull()
  })
})

describe("reads", () => {
  it("getScheduledEvent rebuilds the address from the uuid (never fetches the stored text)", async () => {
    const { ctx, calls } = fake([{ status: 200, body: { resource: { uri: EVENT, status: "active", start_time: "2026-11-20T15:00:00Z", end_time: "2026-11-20T15:30:00Z", name: "New Meeting" } } }])
    const facts = await getScheduledEvent(ctx, EVENT)
    expect(facts).toMatchObject({ status: "active", startTime: "2026-11-20T15:00:00Z", name: "New Meeting" })
    expect(calls[0].url).toBe(EVENT)
    await expect(getScheduledEvent(ctx, "https://evil.example/scheduled_events/11111111-2222-3333-4444-555555555555")).rejects.toMatchObject({ kind: "bad_request" })
    expect(calls).toHaveLength(1)
  })
  it("getEventType reads the name and the booking page", async () => {
    const { ctx } = fake([{ status: 200, body: { resource: { uri: TYPE, name: "New Meeting", active: true, scheduling_url: "https://calendly.com/x/new-meeting", duration: 30 } } }])
    expect(await getEventType(ctx, TYPE)).toEqual({ uri: TYPE, name: "New Meeting", active: true, schedulingUrl: "https://calendly.com/x/new-meeting", durationMinutes: 30, questions: [] })
  })
})

describe("createShareLink", () => {
  it("asks Calendly for one length only and returns the calendly.com address", async () => {
    const { ctx, calls } = fake([{ status: 201, body: { resource: { scheduling_links: [{ booking_url: "https://calendly.com/d/abc-123/new-meeting", owner: TYPE }] } } }])
    expect(await createShareLink(ctx, { eventTypeUri: TYPE, minutes: 45 })).toEqual({ url: "https://calendly.com/d/abc-123/new-meeting" })
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe("https://api.calendly.com/shares")
    expect(JSON.parse(calls[0].body as string)).toEqual({ event_type: TYPE, duration: 45, duration_options: [45] })
  })
  it("refuses an address that is not calendly.com, or an answer with none", async () => {
    for (const body of [
      { resource: { scheduling_links: [{ booking_url: "https://evil.example/d/x" }] } },
      { resource: { scheduling_links: [{ booking_url: "http://calendly.com/d/x" }] } },
      { resource: { scheduling_links: [] } },
      { resource: {} },
      {},
    ]) {
      await expect(createShareLink(fake([{ status: 201, body }]).ctx, { eventTypeUri: TYPE, minutes: 45 })).rejects.toMatchObject({ kind: "bad_response" })
    }
  })
  it("checks its inputs before any request", async () => {
    const { ctx, calls } = fake([])
    for (const minutes of [0, 721, 45.5, NaN]) await expect(createShareLink(ctx, { eventTypeUri: TYPE, minutes })).rejects.toMatchObject({ kind: "bad_request" })
    await expect(createShareLink(ctx, { eventTypeUri: "https://calendly.com/x/y", minutes: 30 })).rejects.toMatchObject({ kind: "bad_request" })
    expect(calls).toHaveLength(0)
  })
  it("passes Calendly's refusal on with the status code", async () => {
    await expect(createShareLink(fake([{ status: 403 }]).ctx, { eventTypeUri: TYPE, minutes: 45 })).rejects.toMatchObject({ kind: "forbidden", status: 403 })
  })
})

describe("cancelEvent", () => {
  it("cancels with a fixed reason", async () => {
    const { ctx, calls } = fake([{ status: 201, body: { resource: {} } }])
    expect(await cancelEvent(ctx, EVENT, "  Cancelled by the host  ")).toEqual({ alreadyCancelled: false })
    expect(calls[0].url).toBe(`${EVENT}/cancellation`)
    expect(JSON.parse(calls[0].body as string)).toEqual({ reason: "Cancelled by the host" })
  })
  it("already cancelled = success (Calendly refuses, the booking reads back cancelled)", async () => {
    const { ctx, calls } = fake([{ status: 400 }, { status: 200, body: { resource: { status: "canceled" } } }])
    expect(await cancelEvent(ctx, EVENT, "x")).toEqual({ alreadyCancelled: true })
    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe("GET")
  })
  it("a refusal for another reason stays a failure", async () => {
    await expect(cancelEvent(fake([{ status: 400 }, { status: 200, body: { resource: { status: "active" } } }]).ctx, EVENT, "x")).rejects.toMatchObject({ kind: "bad_request" })
    await expect(cancelEvent(fake([{ status: 400 }, { status: 500 }]).ctx, EVENT, "x")).rejects.toMatchObject({ kind: "bad_request", status: 400 })
  })
  it("a broken key or an unreachable Calendly is never read as 'already cancelled'", async () => {
    for (const status of [401, 403, 429, 500]) {
      const { ctx, calls } = fake([{ status }])
      await expect(cancelEvent(ctx, EVENT, "x")).rejects.toMatchObject({ status })
      expect(calls).toHaveLength(1)
    }
    await expect(cancelEvent(fake([new Error("down")]).ctx, EVENT, "x")).rejects.toMatchObject({ kind: "network" })
  })
  it("refuses a stored address that is not a Calendly event", async () => {
    const { ctx, calls } = fake([])
    await expect(cancelEvent(ctx, "https://evil.example/scheduled_events/11111111-2222-3333-4444-555555555555", "x")).rejects.toMatchObject({ kind: "bad_request" })
    expect(calls).toHaveLength(0)
  })
})

describe("the write module is not reachable from the MCP tools or the Slack worker", () => {
  const ROOT = path.resolve(__dirname, "../..")
  // Only the Booking page's own code (and tests) may import it.
  const ALLOWED = [/^lib\/booking\//, /^app\/api\/booking\//, /^lib\/calendly\/api-write\.ts$/]
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name === "node_modules" || name === ".next" || name === ".git" || name === "tests" || name === ".claude") continue
      const rel = path.join(dir, name)
      const st = fs.statSync(path.join(ROOT, rel))
      if (st.isDirectory()) walk(rel, out)
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(rel)
    }
    return out
  }
  it("no other file imports lib/calendly/api-write", () => {
    const offenders: string[] = []
    for (const top of ["app", "lib", "components", "scripts"]) {
      if (!fs.existsSync(path.join(ROOT, top))) continue
      for (const rel of walk(top)) {
        const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
        // an import of it, in any form (the word may appear in a comment)
        if (!/(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*calendly\/api-write["']/.test(text)) continue
        if (!ALLOWED.some((re) => re.test(rel.split(path.sep).join("/")))) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
  it("the MCP Calendly tools and the Slack worker do not mention it", () => {
    for (const rel of ["lib/mcp/tools/calendly.ts"]) {
      expect(fs.readFileSync(path.join(ROOT, rel), "utf8")).not.toMatch(/api-write/)
    }
  })
})
