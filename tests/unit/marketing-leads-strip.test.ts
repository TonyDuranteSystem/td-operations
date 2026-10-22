import { describe, it, expect } from "vitest"
import { markWords, rowFacts } from "@/lib/marketing/lead-view"
import { pickLatestMarks } from "@/lib/marketing/setter-note"

const NOW = new Date("2026-10-22T12:00:00Z").getTime()
const H = (h: number) => new Date(NOW - h * 3600_000).toISOString()
const lead = (o: Partial<Parameters<typeof rowFacts>[0]> = {}) => ({ status: "new", claimed_by: null, callback_at: null, ad_name: "Ad Alpha", meta_created_time: null, received_at: H(3), ...o })

describe("rowFacts: how long a lead has been waiting", () => {
  it("a new lead nobody touched shows its wait; red after a day", () => {
    expect(rowFacts(lead({ received_at: H(3) }), "new", NOW).waiting).toEqual({ text: "3 h", late: false })
    expect(rowFacts(lead({ received_at: H(30) }), "new", NOW).waiting).toEqual({ text: "30 h", late: true })
    expect(rowFacts(lead({ received_at: H(80) }), "new", NOW).waiting).toEqual({ text: "3 d", late: true })
    expect(rowFacts(lead({ received_at: new Date(NOW - 20 * 60_000).toISOString() }), "new", NOW).waiting?.text).toBe("20 min")
  })
  it("a picked lead, one with a call back, one past the first stage, or no first stage is not 'waiting'", () => {
    expect(rowFacts(lead({ claimed_by: "u" }), "new", NOW).waiting).toBeNull()
    expect(rowFacts(lead({ callback_at: H(-2) }), "new", NOW).waiting).toBeNull()
    expect(rowFacts(lead({ status: "qualified" }), "new", NOW).waiting).toBeNull()
    expect(rowFacts(lead(), undefined, NOW).waiting).toBeNull()
  })
  it("the real arrival time (from Meta) wins over the time we received it", () => {
    expect(rowFacts(lead({ received_at: H(2), meta_created_time: H(50) }), "new", NOW).waiting).toEqual({ text: "2 d", late: true })
  })
  it("the ad is passed through (null = no ad name)", () => {
    expect(rowFacts(lead(), "new", NOW).ad).toBe("Ad Alpha")
    expect(rowFacts(lead({ ad_name: null }), "new", NOW).ad).toBeNull()
  })
})

describe("pickLatestMarks: who marked it, last", () => {
  const ev = (lead_id: string, actor: string, outcome: string, at: string, extra: Record<string, unknown> = {}) => ({ lead_id, kind: "status_changed", actor, data: { outcome, ...extra }, created_at: at })
  it("the newest outcome wins, by name; View-as rows and non-outcome rows are ignored", () => {
    const m = pickLatestMarks([
      ev("l1", "chiara.neri@x.com", "call_back", "2026-10-22T08:00:00Z"), ev("l1", "marco.bianchi@x.com", "good", "2026-10-22T09:00:00Z"),
      ev("l1", "antonio@x.com", "not_in_target", "2026-10-22T10:00:00Z", { via_view_as: true }),
      { lead_id: "l2", kind: "note", actor: "x@x.com", data: { text: "hi" }, created_at: "2026-10-22T09:00:00Z" },
    ])
    expect(m.get("l1")).toEqual({ outcome: "good", by: "Marco Bianchi", at: "2026-10-22T09:00:00Z" })
    expect(m.has("l2")).toBe(false)
  })
  it("words for the buttons", () => {
    expect([markWords("good"), markWords("not_in_target"), markWords("call_back")]).toEqual(["Good", "Not in target", "Call back"])
  })
})
