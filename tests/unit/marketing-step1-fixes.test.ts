import { describe, it, expect } from "vitest"
import { buildMasterView, countsAsWork, type MasterEvent, type MasterLead } from "@/lib/marketing/master-view"
import { outcomesIn, personNumbers } from "@/lib/marketing/numbers"
import { paidStagesFrom, todayModel } from "@/lib/marketing/workspace"

const NOW = new Date("2026-10-21T10:00:00Z")
const lead = (o: Partial<MasterLead> & { id: string }): MasterLead => ({
  team_id: "t", full_name: o.id, email: null, claimed_by: null, callback_at: null, received_at: "2026-10-20T10:00:00Z", meta_created_time: null, existing_client: null, status: "new", ...o,
})
const ev = (lead_id: string, actor: string, data: Record<string, unknown>, at = "2026-10-21T08:00:00Z"): MasterEvent => ({ lead_id, kind: "status_changed", actor, data, created_at: at })
const stages = [{ key: "new", label: "New" }, { key: "qualified", label: "Qualified" }, { key: "sold", label: "Sold" }]
const members = [{ email: "s@x", role: "member" as const, bundle: "setter", status: "active", lastSignInAt: null }]

describe("stage names come from the settings", () => {
  it("paidStagesFrom: the values of the setting, no repeats, nothing empty", () => {
    expect(paidStagesFrom({ strategic_call: "paid_call", upsell: "upsell_won" })).toEqual(["paid_call", "upsell_won"])
    expect(paidStagesFrom({ a: "sold", b: "sold", c: "" })).toEqual(["sold"])
    expect(paidStagesFrom(null)).toEqual([])
  })
  it("renaming the paid stage still counts this month's paid calls (and the old built-in name no longer does)", () => {
    const events = [ev("l1", "stripe", { to: "sold" }), ev("l2", "stripe", { to: "paid_call" })]
    const v = buildMasterView({ leads: [lead({ id: "l1", status: "sold" })], events, members, stages, now: NOW, paidStages: ["sold"] })
    expect(v.paidCallsThisMonth).toBe(1)
    expect(buildMasterView({ leads: [], events, members, stages, now: NOW }).paidCallsThisMonth).toBe(1) // default built-in name
  })
  it("an EMPTY setting never zeroes the paid count or un-hides paid leads: the built-in names apply", () => {
    const v = buildMasterView({ leads: [], events: [ev("l1", "stripe", { to: "paid_call" })], members, stages, now: NOW, paidStages: paidStagesFrom({}) })
    expect(v.paidCallsThisMonth).toBe(1)
    const m = todayModel({
      leads: [lead({ id: "done", claimed_by: "me", status: "upsell_won" })], events: [], members, stages,
      outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" }, me: "me", now: NOW, paidStages: paidStagesFrom({}),
    })
    expect(m.mine).toEqual([])
  })
  it("Today's 'your leads' leaves out leads at the configured paid stage", () => {
    const m = todayModel({
      leads: [lead({ id: "open", claimed_by: "me", status: "qualified" }), lead({ id: "done", claimed_by: "me", status: "sold" })], events: [], members, stages,
      outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" }, me: "me", now: NOW, paidStages: ["sold"],
    })
    expect(m.mine.map(l => l.id)).toEqual(["open"])
  })
})

describe("Antonio looking in with View as never counts as real work", () => {
  const viewAs = ev("l1", "antonio@x", { outcome: "good", via_view_as: true })
  const real = ev("l2", "s@x", { outcome: "good" })
  it("countsAsWork", () => {
    expect(countsAsWork(viewAs)).toBe(false)
    expect(countsAsWork(real)).toBe(true)
  })
  it("the numbers and the people table leave the tagged rows out", () => {
    expect(outcomesIn([viewAs, real], null).map(r => r.leadId)).toEqual(["l2"])
    expect(personNumbers(outcomesIn([viewAs, real], null), [], "antonio@x").good).toBe(0)
    const v = buildMasterView({ leads: [], events: [{ ...real, actor: "s@x" }, { ...viewAs, actor: "s@x" }], members, stages, now: NOW })
    expect(v.people[0].good).toBe(1)
  })
})
