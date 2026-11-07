/**
 * TD Marketing: a TEST team never receives real leads (dev job 9aec66fa). Lead intake skips it and does not count it, "give this lead a team" refuses it, the screen does not list it,
 * and it cannot be saved as the intake team. Origin: on 5 Nov 2026 two real leads got no team because the leftover test team was active next to Rocco's team.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"

const settingValue = vi.fn()
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: (k: string) => settingValue(k) }))

import { resolveIntakeTeam } from "@/lib/marketing/meta-leads/service"
import { assignLeadToTeam } from "@/lib/marketing/admin-leads"

type Team = { id: string; status: string; is_test: boolean; name?: string }
const REAL = "11111111-1111-1111-1111-111111111111"
const TEST = "22222222-2222-2222-2222-222222222222"
const LEAD = "44444444-4444-4444-4444-444444444444"

/** A tiny in-memory marketing_teams / marketing_leads that honours .eq() filters, so the tests exercise the real query shape. */
function fakeDb(teams: Team[], lead: Record<string, unknown> | null = { id: LEAD, team_id: null }) {
  const updates: unknown[] = []
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = []
    let limit = Infinity
    let mode: "select" | "update" | "insert" = "select"
    const rows = () => (table === "marketing_teams" ? teams : lead ? [lead] : []).filter(r => filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v)).slice(0, limit)
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q },
      is: (c: string, v: unknown) => { filters.push([c, v]); return q },
      limit: (n: number) => { limit = n; return q },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      update: (v: unknown) => { mode = "update"; updates.push(v); return q },
      insert: async () => ({ error: null }),
      then: (res: (v: unknown) => unknown) => res(mode === "update" ? { data: rows().length ? [{ id: LEAD }] : [], error: null } : { data: rows(), error: null }),
    }
    return q
  }
  return { db: { from } as never, updates }
}

beforeEach(() => settingValue.mockReset())

describe("resolveIntakeTeam", () => {
  it("uses the configured real team", async () => {
    settingValue.mockResolvedValue(REAL)
    const { db } = fakeDb([{ id: REAL, status: "active", is_test: false }, { id: TEST, status: "active", is_test: true }])
    expect(await resolveIntakeTeam(db)).toBe(REAL)
  })
  it("never uses a configured TEST team: falls through to the only active real team", async () => {
    settingValue.mockResolvedValue(TEST)
    const { db } = fakeDb([{ id: REAL, status: "active", is_test: false }, { id: TEST, status: "active", is_test: true }])
    expect(await resolveIntakeTeam(db)).toBe(REAL)
  })
  it("an active test team next to the real one does not make it ambiguous (the 5 Nov 2026 case)", async () => {
    settingValue.mockResolvedValue("")
    const { db } = fakeDb([{ id: REAL, status: "active", is_test: false }, { id: TEST, status: "active", is_test: true }])
    expect(await resolveIntakeTeam(db)).toBe(REAL)
  })
  it("only a test team active: nobody (the lead waits for Antonio)", async () => {
    settingValue.mockResolvedValue("")
    expect(await resolveIntakeTeam(fakeDb([{ id: TEST, status: "active", is_test: true }]).db)).toBeNull()
  })
  it("two real active teams and nothing configured: still nobody", async () => {
    settingValue.mockResolvedValue("")
    const { db } = fakeDb([{ id: REAL, status: "active", is_test: false }, { id: "33333333-3333-3333-3333-333333333333", status: "active", is_test: false }])
    expect(await resolveIntakeTeam(db)).toBeNull()
  })
})

describe("assignLeadToTeam", () => {
  it("refuses a test team and writes nothing", async () => {
    const { db, updates } = fakeDb([{ id: TEST, status: "draft", is_test: true, name: "T" }])
    const r = await assignLeadToTeam(db, LEAD, TEST, "antonio")
    expect(r).toEqual({ ok: false, status: 400, error: "That is a test team. It cannot be given real leads." })
    expect(updates).toEqual([])
  })
  it("still gives a lead to a real team", async () => {
    const { db, updates } = fakeDb([{ id: REAL, status: "active", is_test: false, name: "Rocco" }])
    expect(await assignLeadToTeam(db, LEAD, REAL, "antonio")).toEqual({ ok: true })
    expect(updates.length).toBe(1)
  })
})

describe("wiring guards", () => {
  it("the All leads screen does not offer test teams in the assign list", () => {
    expect(readFileSync("app/(dashboard)/marketing-leads/leads/page.tsx", "utf8")).toContain("teams.filter(t => !t.is_test).map")
  })
  it("a test team cannot be saved as the intake team", () => {
    expect(readFileSync("lib/marketing/settings.ts", "utf8")).toContain('"That is a test team. Real leads cannot be sent to it."')
  })
})
