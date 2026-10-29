import { describe, expect, it } from "vitest"
import { homeModel, LINK_UNPAID_HOURS, MESSAGES_SHOWN, type HomeLead } from "@/lib/marketing/home"
import { modulesFor, homeFor } from "@/lib/marketing/workspace"

// 27 Oct 2026, 15:00 Rome (CET = UTC+1)
const NOW = new Date("2026-10-27T14:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const lead = (id: string, status: string, o: Partial<HomeLead> = {}): HomeLead => ({ id, status, full_name: `Lead ${id}`, email: null, received_at: hoursAgo(100), meta_created_time: null, claimed_by: null, callback_at: null, ...o })
const ev = (lead_id: string, kind: string, at: string, data: Record<string, unknown> = {}) => ({ lead_id, kind, actor: "rocco@x.test", data, created_at: at })
const base = { events: [], conversations: [], threads: [], calls: [], now: NOW, firstStage: "new", unnamed: "Unnamed lead" }

describe("owner Home — the four numbers", () => {
  it("counts leads that arrived today (Rome day), the ones with Rocco, the links and payments of today", () => {
    const m = homeModel({
      ...base,
      leads: [lead("a", "new", { received_at: hoursAgo(2) }), lead("b", "new", { received_at: hoursAgo(30) }), lead("c", "booked"), lead("d", "seller_contacted"), lead("e", "closed"), lead("f", "paid_call"), lead("g", "qualified")],
      events: [ev("e", "payment_link_created", hoursAgo(1), { sale_id: "s1" }), ev("e", "payment_link_created", hoursAgo(1), { sale_id: "s1" }), ev("f", "payment_received", hoursAgo(2), { sale_id: "s2" }), ev("f", "payment_received", hoursAgo(40), { sale_id: "s0" })],
    })
    expect(m.numbers).toEqual({ newToday: 1, withSeller: 3, linksToday: 1, paidToday: 1 })
  })
  it("never counts a lead the setter has not passed on (qualified) as with Rocco", () => {
    expect(homeModel({ ...base, leads: [lead("g", "qualified")] }).numbers.withSeller).toBe(0)
  })
  it("ignores history written while Antonio was looking in with View as", () => {
    const m = homeModel({ ...base, leads: [lead("e", "closed")], events: [ev("e", "payment_link_created", hoursAgo(1), { sale_id: "s9", via_view_as: true })] })
    expect(m.numbers.linksToday).toBe(0)
  })
})

describe("owner Home — messages", () => {
  const conv = (leadId: string, unread: number, lastAt: string, lastBy = "Rocco", mentioned = true) => ({ leadId, name: `Lead ${leadId}`, last: "hi", lastAt, lastBy, unread, mentioned })
  const thread = (id: string, unread: number, lastAt: string | null, mentioned = false) => ({ id, kind: "dm" as const, title: "Rocco", lastAt, last: "invoice", lastBy: "Rocco", unread, mentioned, memberIds: [] })
  it("lists only what is unread, newest first, lead chats and direct messages together", () => {
    const m = homeModel({ ...base, leads: [], conversations: [conv("a", 1, hoursAgo(5)), conv("b", 0, hoursAgo(1))], threads: [thread("t1", 2, hoursAgo(2))] })
    expect(m.messages.map(x => x.key)).toEqual(["thread:t1", "lead:a"])
    expect(m.messagesTotal).toBe(2)
  })
  it("shows at most the cap and still counts the rest", () => {
    const many = Array.from({ length: MESSAGES_SHOWN + 3 }, (_, i) => conv(`l${i}`, 1, hoursAgo(i + 1)))
    const m = homeModel({ ...base, leads: [], conversations: many })
    expect(m.messages).toHaveLength(MESSAGES_SHOWN)
    expect(m.messagesTotal).toBe(MESSAGES_SHOWN + 3)
  })
  it("a chat about a lead is his only when somebody named him in it (Antonio: my list showed what Rocco writes to leads)", () => {
    const m = homeModel({ ...base, leads: [], conversations: [conv("named", 2, hoursAgo(3)), conv("not-named", 5, hoursAgo(1), "Rocco", false), { leadId: "unknown", name: "Lead unknown", last: "hi", lastAt: hoursAgo(1), lastBy: "Ale", unread: 1 }] })
    expect(m.messages.map(x => x.key)).toEqual(["lead:named"])
    expect(m.messages[0].mentioned).toBe(true)
    expect(m.messagesTotal).toBe(1)
  })
  it("keeps a mention flag on a thread", () => {
    expect(homeModel({ ...base, leads: [], threads: [thread("t", 1, hoursAgo(1), true)] }).messages[0].mentioned).toBe(true)
  })
})

describe("owner Home — waiting on Rocco", () => {
  it("a Link sent lead is waiting only when its newest link is older than the limit", () => {
    const m = homeModel({
      ...base,
      leads: [lead("old", "closed"), lead("fresh", "closed"), lead("nolink", "closed")],
      events: [ev("old", "payment_link_created", hoursAgo(LINK_UNPAID_HOURS + 5)), ev("fresh", "payment_link_created", hoursAgo(3)), ev("old", "payment_link_created", hoursAgo(LINK_UNPAID_HOURS + 50))],
    })
    expect(m.waiting.find(g => g.key === "link_unpaid")).toMatchObject({ count: 1, leads: [{ id: "old" }] })
  })
  it("a Paid lead is waiting for the booking link; a new lead untouched for over a day is waiting too", () => {
    const m = homeModel({ ...base, leads: [lead("p", "paid_call"), lead("u", "new", { received_at: hoursAgo(30) }), lead("v", "new", { received_at: hoursAgo(3) }), lead("w", "new", { received_at: hoursAgo(30), claimed_by: "x" })] })
    expect(m.waiting.find(g => g.key === "paid_no_booking")?.count).toBe(1)
    expect(m.waiting.find(g => g.key === "untouched")?.leads.map(l => l.id)).toEqual(["u"])
    expect(m.waitingTotal).toBe(2)
  })
  it("names an unnamed lead with the fallback and shows at most five names but counts all", () => {
    const m = homeModel({ ...base, leads: Array.from({ length: 7 }, (_, i) => lead(`p${i}`, "paid_call", { full_name: null })) })
    const g = m.waiting.find(x => x.key === "paid_no_booking")!
    expect(g.count).toBe(7)
    expect(g.leads).toHaveLength(5)
    expect(g.leads[0].name).toBe("Unnamed lead")
  })
})

describe("owner Home — calls today", () => {
  it("lists the calls of the Rome day in time order and leaves yesterday's and tomorrow's out", () => {
    const call = (id: string, at: string) => ({ lead: { id, full_name: `Lead ${id}`, email: null }, at, actor: "ale@x.test" })
    const m = homeModel({ ...base, leads: [], calls: [call("late", "2026-10-27T15:30:00Z"), call("early", "2026-10-27T10:00:00Z"), call("yday", "2026-10-26T10:00:00Z"), call("tmrw", "2026-10-28T10:00:00Z")] })
    expect(m.callsToday.map(c => c.leadId)).toEqual(["early", "late"])
  })
})

describe("the team workspace has no owner Home", () => {
  it("is not in anybody's menu, and the first screen of a seller is Today", () => {
    expect(modulesFor(["leads.pick"]).map(x => x.key)).not.toContain("home")
    expect(modulesFor(["leads.pick", "leads.read"]).map(x => x.key)[0]).not.toBe("home")
    expect(homeFor(["leads.pick", "leads.read"])).toBe("/marketing/today")
  })
})
