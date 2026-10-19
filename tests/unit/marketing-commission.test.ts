import { describe, it, expect } from "vitest"
import { splitCents, shareBase, termInForce, type CommissionTerm } from "@/lib/marketing/commission"
import { canChangeTeamStatus, isTeamLive } from "@/lib/marketing/team-status"

const T = (over: Partial<CommissionTerm>): CommissionTerm => ({
  id: "t", team_id: "team1", person_ref: "team", kind: "strategic_call", seller_pct: 80, td_pct: 20,
  basis: "amount_paid", payee_account_id: null, effective_from: "2026-10-17T00:00:00Z", ...over,
})

describe("splitCents", () => {
  it("80/20 of 25,700 cents", () => expect(splitCents(25700, 80)).toEqual({ sellerCents: 20560, tdCents: 5140 }))
  it("the two parts always add up to the net, remainder to TD", () => {
    for (const net of [1, 3, 99, 12345, 999999]) {
      const s = splitCents(net, 80)!
      expect(s.sellerCents + s.tdCents).toBe(net)
    }
    expect(splitCents(1, 80)).toEqual({ sellerCents: 0, tdCents: 1 }) // floor(0.8) = 0
  })
  it("handles two-decimal percentages exactly", () => expect(splitCents(10000, 33.33)).toEqual({ sellerCents: 3333, tdCents: 6667 }))
  it("0% and 100%", () => {
    expect(splitCents(500, 0)).toEqual({ sellerCents: 0, tdCents: 500 })
    expect(splitCents(500, 100)).toEqual({ sellerCents: 500, tdCents: 0 })
  })
  it("refuses fractional cents, negatives and out-of-range percentages", () => {
    expect(splitCents(10.5, 80)).toBeNull()
    expect(splitCents(-1, 80)).toBeNull()
    expect(splitCents(100, 101)).toBeNull()
    expect(splitCents(100, -1)).toBeNull()
    expect(splitCents(100, NaN)).toBeNull()
  })
})

describe("shareBase", () => {
  it("amount_paid ignores fees; net_of_fees subtracts them and never goes below zero", () => {
    expect(shareBase({ basis: "amount_paid" }, 10000, 320)).toBe(10000)
    expect(shareBase({ basis: "net_of_fees" }, 10000, 320)).toBe(9680)
    expect(shareBase({ basis: "net_of_fees" }, 100, 500)).toBe(0)
  })
  it("refuses non-integer cents", () => expect(shareBase({ basis: "amount_paid" }, 10.5, 0)).toBeNull())
})

describe("termInForce", () => {
  const at = new Date("2026-11-01T00:00:00Z")
  it("no terms = null (terms not set, nothing computed)", () => {
    expect(termInForce([], { teamId: "team1", kind: "strategic_call", at })).toBeNull()
  })
  it("a term that has not started yet is not in force", () => {
    expect(termInForce([T({ effective_from: "2026-12-01T00:00:00Z" })], { teamId: "team1", kind: "strategic_call", at })).toBeNull()
  })
  it("the latest started term wins; an older sale date still sees the older term", () => {
    const old = T({ id: "old", seller_pct: 80, effective_from: "2026-10-17T00:00:00Z" })
    const next = T({ id: "new", seller_pct: 70, td_pct: 30, effective_from: "2026-11-15T00:00:00Z" })
    expect(termInForce([old, next], { teamId: "team1", kind: "strategic_call", at: new Date("2026-11-20T00:00:00Z") })?.id).toBe("new")
    expect(termInForce([old, next], { teamId: "team1", kind: "strategic_call", at })?.id).toBe("old")
  })
  it("a person-specific term beats the team-wide one; others get the team one", () => {
    const team = T({ id: "team" })
    const ale = T({ id: "ale", person_ref: "user-ale", seller_pct: 10, td_pct: 90 })
    expect(termInForce([team, ale], { teamId: "team1", kind: "strategic_call", personRef: "user-ale", at })?.id).toBe("ale")
    expect(termInForce([team, ale], { teamId: "team1", kind: "strategic_call", personRef: "user-x", at })?.id).toBe("team")
  })
  it("never leaks another team's or another kind's term", () => {
    expect(termInForce([T({ team_id: "other" })], { teamId: "team1", kind: "strategic_call", at })).toBeNull()
    expect(termInForce([T({ kind: "upsell" })], { teamId: "team1", kind: "strategic_call", at })).toBeNull()
  })
  it("an invalid date returns null instead of guessing", () => {
    expect(termInForce([T({})], { teamId: "team1", kind: "strategic_call", at: new Date("nope") })).toBeNull()
  })
})

describe("team status", () => {
  it("only active is live; unknown fails closed", () => {
    expect(isTeamLive("active")).toBe(true)
    for (const s of ["draft", "paused", "", null, undefined, "ACTIVE"]) expect(isTeamLive(s)).toBe(false)
  })
  it("transitions: draft→active, active↔paused; never back to draft or to itself", () => {
    expect(canChangeTeamStatus("draft", "active")).toBe(true)
    expect(canChangeTeamStatus("active", "paused")).toBe(true)
    expect(canChangeTeamStatus("paused", "active")).toBe(true)
    expect(canChangeTeamStatus("active", "draft")).toBe(false)
    expect(canChangeTeamStatus("active", "active")).toBe(false)
    expect(canChangeTeamStatus("draft", "bogus")).toBe(false)
  })
})
