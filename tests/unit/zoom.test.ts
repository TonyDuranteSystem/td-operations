import { describe, it, expect } from "vitest"
import { makeZoomApi, zoomConfigured } from "@/lib/zoom"

const ENV = { ZOOM_ACCOUNT_ID: "acct", ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "sec", ZOOM_HOST_USER: "host@example.test" }
type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string }

function fakeFetch(answers: Array<{ status: number; json?: unknown }>) {
  const calls: Call[] = []
  const fn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init })
    const a = answers.shift() ?? { status: 200, json: {} }
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? {}, text: async () => JSON.stringify(a.json ?? {}) }
  }
  return { fn, calls }
}
const tokenAnswer = { status: 200, json: { access_token: "tok", expires_in: 3600 } }

describe("zoomConfigured", () => {
  it("needs all three keys", () => {
    expect(zoomConfigured(ENV)).toBe(true)
    expect(zoomConfigured({ ...ENV, ZOOM_CLIENT_SECRET: "" })).toBe(false)
    expect(zoomConfigured({})).toBe(false)
  })
})

describe("makeZoomApi", () => {
  it("logs in with the account credentials and makes a meeting for the host", async () => {
    const f = fakeFetch([tokenAnswer, { status: 201, json: { id: 123456, join_url: "https://zoom.us/j/123456" } }])
    const api = makeZoomApi(ENV, f.fn)
    const m = await api.createMeeting({ topic: "Call", startIso: "2026-11-03T14:00:00.000Z", minutes: 30, timeZone: "Atlantic/Canary" })
    expect(m).toEqual({ id: "123456", joinUrl: "https://zoom.us/j/123456" })
    expect(f.calls[0].url).toContain("grant_type=account_credentials&account_id=acct")
    expect(f.calls[0].headers?.Authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`)
    expect(f.calls[1].url).toBe("https://api.zoom.us/v2/users/host%40example.test/meetings")
    const body = JSON.parse(f.calls[1].body as string)
    expect(body).toMatchObject({ topic: "Call", type: 2, start_time: "2026-11-03T14:00:00Z", duration: 30, timezone: "Atlantic/Canary", settings: { waiting_room: true, join_before_host: false } })
  })
  it("keeps the login for the next call", async () => {
    const f = fakeFetch([tokenAnswer, { status: 204 }, { status: 204 }])
    const api = makeZoomApi(ENV, f.fn, () => 1_000)
    await api.updateMeeting("1", { startIso: "2026-11-03T14:00:00Z", minutes: 30, timeZone: "UTC" })
    await api.updateMeeting("1", { startIso: "2026-11-03T15:00:00Z", minutes: 30, timeZone: "UTC" })
    expect(f.calls.filter(c => c.url.includes("oauth/token"))).toHaveLength(1)
  })
  it("treats a meeting that is already gone as deleted", async () => {
    const f = fakeFetch([tokenAnswer, { status: 404 }])
    await expect(makeZoomApi(ENV, f.fn).deleteMeeting("9")).resolves.toBeUndefined()
  })
  it("refuses plainly when Zoom is not set up, and when Zoom answers with an error", async () => {
    await expect(makeZoomApi({}, fakeFetch([]).fn).createMeeting({ topic: "x", startIso: "2026-11-03T14:00:00Z", minutes: 30, timeZone: "UTC" })).rejects.toThrow(/not set up/)
    const f = fakeFetch([tokenAnswer, { status: 400, json: { message: "bad" } }])
    await expect(makeZoomApi(ENV, f.fn).createMeeting({ topic: "x", startIso: "2026-11-03T14:00:00Z", minutes: 30, timeZone: "UTC" })).rejects.toThrow(/Zoom answered 400/)
  })
  it("falls back to 'me' when no host is named", async () => {
    const f = fakeFetch([tokenAnswer, { status: 201, json: { id: 1, join_url: "https://zoom.us/j/1" } }])
    await makeZoomApi({ ...ENV, ZOOM_HOST_USER: undefined }, f.fn).createMeeting({ topic: "x", startIso: "2026-11-03T14:00:00Z", minutes: 30, timeZone: "UTC" })
    expect(f.calls[1].url).toBe("https://api.zoom.us/v2/users/me/meetings")
  })
})
