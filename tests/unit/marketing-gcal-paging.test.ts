import { describe, it, expect, vi, beforeEach } from "vitest"

// The bug hunt of 30 Oct 2026: Google hands out 250 events at a time; a busy calendar must not be cut off at the end and shown as free.
const calls: Array<{ endpoint: string; params?: Record<string, string>; timeoutMs?: number }> = []
let pages: Array<{ items: unknown[]; nextPageToken?: string }> = []
vi.mock("@/lib/google-calendar", () => ({
  MARKETING_GOOGLE_TIMEOUT_MS: 6000,
  calendarRequestAs: async (_actAs: string, endpoint: string, opts: { params?: Record<string, string> } = {}) => {
    calls.push({ endpoint, params: opts.params })
    const n = opts.params?.pageToken ? Number(opts.params.pageToken) : 0
    return pages[n]
  },
}))
import { googleApi } from "@/lib/marketing/gcal"

const ev = (i: number) => ({ id: `evt${String(i).padStart(5, "0")}`, summary: `E${i}`, start: { dateTime: `2026-11-03T${String(10 + (i % 8)).padStart(2, "0")}:00:00Z` }, end: { dateTime: `2026-11-03T${String(11 + (i % 8)).padStart(2, "0")}:00:00Z` } })

beforeEach(() => { calls.length = 0; pages = [] })

describe("listing a calendar's events follows Google's pages", () => {
  it("reads every page, in order, and passes the page token on", async () => {
    pages = [{ items: [ev(1), ev(2)], nextPageToken: "1" }, { items: [ev(3)], nextPageToken: "2" }, { items: [ev(4)] }]
    const out = await googleApi.listEvents("rocco@tonydurante.us", "primary", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")
    expect(out.map(e => e.title)).toEqual(["E1", "E2", "E3", "E4"])
    expect(calls.map(c => c.params?.pageToken)).toEqual([undefined, "1", "2"])
  })
  it("a single page is a single call", async () => {
    pages = [{ items: [ev(1)] }]
    expect(await googleApi.listEvents("rocco@tonydurante.us", "primary", "a", "b")).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
  it("a calendar that never ends is an error (the screen warns), never a shorter list that looks like free time", async () => {
    pages = Array.from({ length: 10 }, (_, i) => ({ items: [ev(i)], nextPageToken: String(i + 1) }))
    await expect(googleApi.listEvents("rocco@tonydurante.us", "primary", "a", "b")).rejects.toThrow(/too many events/)
    expect(calls).toHaveLength(6)
  })
})
