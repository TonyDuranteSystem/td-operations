import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { miniDb } from "./helpers/mini-db"
import { parseParams, toQueryString, withTab, TABS } from "@/lib/new-calendar/params"

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: new Proxy({}, { get: (_t, k) => (h.db as Record<string | symbol, unknown>)[k] }) }))
import { loadCallsTab } from "@/lib/booking/calls-tab"

const ROOT = path.resolve(__dirname, "../..")
const NOW = new Date("2026-11-14T12:00:00Z")
const card = (over: Record<string, unknown> = {}) => ({ id: "d0000000-0000-4000-8000-000000000001", kind: "unknown_id", dedupe_key: "k", status: "open", booking_link_id: null, lead_id: null, contact_id: null, calendly_event_uri: null, payload: { reason: "not_found", booker_email: "a@b.com" }, created_at: "2026-11-13T10:00:00Z", updated_at: "2026-11-13T10:00:00Z", ...over })

describe("the Calls to check tab: address", () => {
  it("is one of the Calendar's tabs, kept apart from the others", () => {
    expect(TABS).toContain("calls")
    const p = parseParams({ tab: "calls" })
    expect(p.tab).toBe("calls")
    expect(toQueryString(p)).toBe("?tab=calls")
    expect(withTab(parseParams({ tab: "jobs", q: "x" }), "calls")).toMatchObject({ tab: "calls", q: "" })
    expect(parseParams({ tab: "CALLS" }).tab).toBe("calls")
    expect(parseParams({ tab: "calls-extra" }).tab).toBe("jobs")
  })
})

describe("the Calendar page keeps the tab to the admin", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/(dashboard)/new-calendar/page.tsx"), "utf8")
  it("reads the cards only after isSecureAdmin, and sends anyone else who types the address back to the first tab", () => {
    expect(page.indexOf("isSecureAdmin(access.user)")).toBeGreaterThan(-1)
    expect(page.indexOf("isSecureAdmin(access.user)")).toBeLessThan(page.indexOf("loadCallsTab(now)"))
    expect(page).toContain("requested.tab === 'calls' && !seesCalls")
    expect(page).toContain("calls={seesCalls ? calls : null}")
  })
  it("the Calendar's own components stay free of requests and writes (the answering UI lives in components/calls-to-check)", () => {
    const view = fs.readFileSync(path.join(ROOT, "components/new-calendar/new-calendar-view.tsx"), "utf8")
    expect(view).not.toMatch(/fetch\(|\.insert\(|\.update\(/)
    expect(fs.readFileSync(path.join(ROOT, "components/calls-to-check/calls-tab.tsx"), "utf8")).toContain("/api/booking/checks/")
  })
})

describe("loadCallsTab: when the tab shows", () => {
  const load = async (seed: Record<string, Array<Record<string, unknown>>>, opts = {}) => { h.db = miniDb(seed, opts); return loadCallsTab(NOW) }
  it("hidden while the Booking page is off and nothing waits", async () => {
    expect(await load({ app_settings: [], call_checks: [] })).toEqual({ visible: false, cards: [], count: 0 })
  })
  it("still shown while the page is off if a card is waiting (switching it off never hides a card)", async () => {
    const r = await load({ app_settings: [], call_checks: [card()] })
    expect(r.visible).toBe(true)
    expect(r.count).toBe(1)
  })
  it("shown once the page is on, even with nothing waiting", async () => {
    for (const mode of ["page", "live"]) expect((await load({ app_settings: [{ key: "booking", value: { mode } }], call_checks: [] })).visible).toBe(true)
  })
  it("a failed read is null — never a count of zero", async () => {
    const r = await load({ app_settings: [{ key: "booking", value: { mode: "page" } }] }, { failing: { call_checks: "x" } })
    expect(r).toEqual({ visible: true, cards: null, count: null })
    expect((await load({ app_settings: [] }, { failing: { call_checks: "x" } })).visible).toBe(false)
  })
})
