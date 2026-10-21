import { describe, it, expect } from "vitest"
import type { MasterEvent } from "@/lib/marketing/master-view"
import { adTable, outcomesIn, parsePeriod, periodStart, personNumbers, reasonCounts, romeStartOfWeek, setterTable } from "@/lib/marketing/numbers"

const ev = (lead: string, actor: string, outcome: string, at: string, extra: Record<string, unknown> = {}): MasterEvent => ({ lead_id: lead, kind: "status_changed", actor, data: { outcome, ...extra }, created_at: at })
const NOW = new Date("2026-10-21T10:00:00Z") // Wednesday
const events: MasterEvent[] = [
  ev("l1", "a@x", "good", "2026-10-21T08:00:00Z"),
  ev("l2", "a@x", "not_in_target", "2026-10-21T08:30:00Z", { reason: "wrong_profile" }),
  ev("l3", "a@x", "call_back", "2026-10-20T09:00:00Z"),
  ev("l4", "b@x", "not_in_target", "2026-10-19T09:00:00Z", { reason: "wrong_profile" }),
  ev("l5", "b@x", "not_in_target", "2026-10-10T09:00:00Z", { reason: "gone_key" }),
  { lead_id: "l1", kind: "note", actor: "a@x", data: { text: "hi" }, created_at: "2026-10-21T08:01:00Z" },
  { lead_id: "l6", kind: "status_changed", actor: "a@x", data: { from: "new", to: "qualified" }, created_at: "2026-10-21T08:02:00Z" },
]
const sales = [{ lead_id: "l1", status: "paid" as const }, { lead_id: "l4", status: "refunded" as const }, { lead_id: "l3", status: "link_created" as const }]

describe("periods (Rome clock)", () => {
  it("week starts on Monday, today at the Rome midnight, month on the 1st; all has no limit", () => {
    expect(romeStartOfWeek(NOW).toISOString()).toBe("2026-10-18T22:00:00.000Z") // Mon 19 Oct 00:00 Rome (CEST, UTC+2)
    expect(periodStart("today", NOW)?.toISOString()).toBe("2026-10-20T22:00:00.000Z")
    expect(periodStart("month", NOW)?.toISOString()).toBe("2026-09-30T22:00:00.000Z")
    expect(periodStart("all", NOW)).toBeNull()
  })
  it("a Sunday still belongs to the week that began the Monday before", () => {
    expect(romeStartOfWeek(new Date("2026-10-25T12:00:00Z")).toISOString()).toBe("2026-10-18T22:00:00.000Z")
  })
  it("an unknown period falls back to the week", () => { expect(parsePeriod("x")).toBe("week"); expect(parsePeriod(undefined)).toBe("week"); expect(parsePeriod("month")).toBe("month") })
})

describe("outcomes and person numbers", () => {
  it("only Good / Not in target / Call back rows count, only inside the period", () => {
    expect(outcomesIn(events, periodStart("today", NOW)).map(o => o.leadId)).toEqual(["l1", "l2"])
    expect(outcomesIn(events, periodStart("week", NOW)).length).toBe(4)
    expect(outcomesIn(events, null).length).toBe(5)
  })
  it("worked, Good rate (Good out of Good + Not in target) and paid leads for one person", () => {
    const rows = outcomesIn(events, periodStart("week", NOW))
    expect(personNumbers(rows, sales, "a@x")).toEqual({ worked: 3, good: 1, notInTarget: 1, callBacks: 1, goodRatePct: 50, paidLeads: 1 })
    expect(personNumbers(rows, sales, "nobody@x")).toEqual({ worked: 0, good: 0, notInTarget: 0, callBacks: 0, goodRatePct: null, paidLeads: 0 })
  })
  it("a refunded or unpaid sale is not a paid lead", () => {
    const rows = [{ leadId: "l4", actor: "b@x", outcome: "good" as const, reason: null, at: "x" }]
    expect(personNumbers(rows, sales, "b@x").paidLeads).toBe(0)
  })
})

describe("reasons, ads, setters", () => {
  const reasons = [{ key: "wrong_profile", label: "Wrong profile" }]
  it("reasons: biggest first, label from the setting, unknown key shown as itself", () => {
    expect(reasonCounts(outcomesIn(events, null), reasons)).toEqual([{ label: "Wrong profile", n: 2 }, { label: "gone_key", n: 1 }])
    expect(reasonCounts([{ leadId: "l", actor: "a", outcome: "not_in_target", reason: null, at: "x" }], reasons)).toEqual([{ label: "No reason given", n: 1 }])
  })
  it("ads: leads that arrived in the period, with what became of them and how many paid", () => {
    const leads = [
      { id: "l1", ad_name: "Ad A", campaign_name: null, received_at: "2026-10-21T07:00:00Z", meta_created_time: null },
      { id: "l2", ad_name: "Ad A", campaign_name: null, received_at: "2026-10-21T07:00:00Z", meta_created_time: null },
      { id: "l5", ad_name: null, campaign_name: null, received_at: "2026-10-01T07:00:00Z", meta_created_time: "2026-10-10T07:00:00Z" },
    ]
    const all = outcomesIn(events, null)
    expect(adTable(leads, all, sales, periodStart("week", NOW))).toEqual([{ ad: "Ad A", leads: 2, good: 1, notInTarget: 1, paid: 1 }])
    expect(adTable(leads, all, sales, null).map(r => r.ad)).toEqual(["Ad A", "No ad name"])
  })
  it("setters: most worked first", () => {
    const t = setterTable(outcomesIn(events, periodStart("week", NOW)), sales)
    expect(t.map(r => [r.actor, r.worked])).toEqual([["a@x", 3], ["b@x", 1]])
  })
})
