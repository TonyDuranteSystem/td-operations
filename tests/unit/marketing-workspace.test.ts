import { describe, it, expect } from "vitest"
import { callQueue, homeFor, modulesFor, nextInQueue, todayModel, type TodayLead } from "@/lib/marketing/workspace"

const OWNER = ["leads.worklist", "team.activity", "team.notes", "leads.read", "leads.pick", "leads.call", "leads.mark", "leads.import", "leads.export", "payment_links.create", "money.read", "offers.create", "calls.host", "calls.recordings", "whatsapp", "inbox", "chat", "content.manage", "reports.read", "team.manage"]
const SETTER = ["leads.read", "leads.call", "leads.mark", "leads.worklist", "team.notes", "whatsapp", "chat", "inbox"]
const NOW = new Date("2026-10-20T12:00:00Z") // 14:00 in Rome
const h = (n: number) => new Date(NOW.getTime() + n * 3600_000).toISOString()
let n = 0
const lead = (o: Partial<TodayLead> = {}): TodayLead => ({
  id: `l${++n}`, status: "new", team_id: "T", full_name: `Lead ${n}`, email: null, phone: null, claimed_by: null, callback_at: null, received_at: h(-1), meta_created_time: null, existing_client: null, ...o,
})

describe("modulesFor", () => {
  it("the owner gets every screen of the mockup in its order, with Today, Team activity and Team", () => {
    expect(modulesFor(OWNER).map(m => m.key)).toEqual(["today", "call-list", "leads", "calendar", "inbox", "whatsapp", "chat", "calls", "money", "offers", "content", "my-numbers", "activity", "reports", "team"])
  })
  it("a setter gets the Call list, Leads, Calendar, Chat, Inbox, WhatsApp and My numbers, and no money, no team, no Today", () => {
    const k = modulesFor(SETTER).map(m => m.key)
    expect(k).toEqual(["call-list", "leads", "calendar", "inbox", "whatsapp", "chat", "my-numbers"])
    for (const no of ["today", "money", "team", "offers"]) expect(k).not.toContain(no)
  })
  it("a person with no permission gets nothing and no home", () => {
    expect(modulesFor([])).toEqual([])
    expect(homeFor([])).toBeNull()
  })
  it("only screens that exist are a home", () => {
    expect(homeFor(OWNER)).toBe("/marketing/today")
    expect(homeFor(SETTER)).toBe("/marketing/call-list")
    expect(homeFor(["leads.read"])).toBe("/marketing/leads")
    expect(homeFor(["chat"])).toBeNull()   // chat is not built yet: a screen that does not exist is never a home
  })
  it("unbuilt screens are marked, built ones are links", () => {
    const m = Object.fromEntries(modulesFor(OWNER).map(x => [x.key, x.built]))
    expect(m).toMatchObject({ today: true, leads: true, team: true, inbox: false, money: true })
  })
})

describe("callQueue", () => {
  it("call backs due today come first (earliest first), then new leads oldest first", () => {
    const q = callQueue([
      lead({ id: "new-newer", received_at: h(-2) }), lead({ id: "new-older", received_at: h(-30) }),
      lead({ id: "cb-late", status: "contacted", callback_at: h(-3) }), lead({ id: "cb-later", status: "contacted", callback_at: h(4) }),
    ], "new", "me", NOW)
    expect(q.map(l => l.id)).toEqual(["cb-late", "cb-later", "new-older", "new-newer"])
  })
  it("a call back for tomorrow is not on today's list", () => {
    expect(callQueue([lead({ id: "tomorrow", status: "contacted", callback_at: h(20) })], "new", "me", NOW)).toEqual([])
  })
  it("a lead someone else picked is not on my list, one I picked is", () => {
    const q = callQueue([lead({ id: "theirs", claimed_by: "other" }), lead({ id: "mine", claimed_by: "me" })], "new", "me", NOW)
    expect(q.map(l => l.id)).toEqual(["mine"])
  })
  it("worked leads (not in the first stage) do not appear unless a call back is due", () => {
    expect(callQueue([lead({ status: "qualified" }), lead({ status: "not_in_target" })], "new", "me", NOW)).toEqual([])
  })
  it("Meta's time decides how long a lead has waited, not our arrival time", () => {
    const q = callQueue([lead({ id: "a", received_at: h(-1), meta_created_time: h(-50) }), lead({ id: "b", received_at: h(-10) })], "new", "me", NOW)
    expect(q.map(l => l.id)).toEqual(["a", "b"])
  })
})

describe("nextInQueue", () => {
  const q = [{ id: "a" }, { id: "b" }, { id: "c" }]
  it("goes to the next, falls back to the previous at the end, and handles a lead that left the queue", () => {
    expect(nextInQueue(q, "a")?.id).toBe("b")
    expect(nextInQueue(q, "c")?.id).toBe("b")
    expect(nextInQueue(q, "gone")?.id).toBe("a")
    expect(nextInQueue([], "x")).toBeNull()
    expect(nextInQueue([{ id: "only" }], "only")).toBeNull()
  })
})

describe("todayModel", () => {
  const stages = [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }]
  const out = { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" }
  const base = { events: [], members: [], stages, outcomeStages: out, me: "me", now: NOW }
  it("Good leads nobody picked, longest waiting first; picked ones are not offered", () => {
    const m = todayModel({ ...base, leads: [lead({ id: "g2", status: "qualified", received_at: h(-5) }), lead({ id: "g1", status: "qualified", received_at: h(-9) }), lead({ id: "gp", status: "qualified", claimed_by: "other" })] })
    expect(m.goodWaiting.map(l => l.id)).toEqual(["g1", "g2"])
  })
  it("call backs: late ones flagged, tomorrow's left out, another person's picked lead left out", () => {
    const m = todayModel({ ...base, leads: [lead({ id: "late", callback_at: h(-2) }), lead({ id: "soon", callback_at: h(3) }), lead({ id: "tmr", callback_at: h(22) }), lead({ id: "other", callback_at: h(-1), claimed_by: "x" })] })
    expect(m.callBacks.map(c => `${c.lead.id}:${c.late}`)).toEqual(["late:true", "soon:false"])
  })
  it("my leads: the ones I picked that are still open, newest pick first; finished ones are not listed", () => {
    const m = todayModel({ ...base, leads: [
      lead({ id: "old", claimed_by: "me", status: "contacted", claimed_at: h(-30) }), lead({ id: "new", claimed_by: "me", status: "contacted", claimed_at: h(-1) }),
      lead({ id: "done", claimed_by: "me", status: "not_in_target" }), lead({ id: "paid", claimed_by: "me", status: "paid_call" }), lead({ id: "notmine", claimed_by: "x" }),
    ] })
    expect(m.mine.map(l => l.id)).toEqual(["new", "old"])
  })
  it("what each person did today comes with it", () => {
    const m = todayModel({ ...base, leads: [lead()], members: [{ email: "c@x.com", role: "member", bundle: "setter", status: "active", lastSignInAt: null }],
      events: [{ lead_id: "l1", kind: "status_changed", actor: "c@x.com", data: { outcome: "good" }, created_at: h(-1) }] })
    expect(m.people[0]).toMatchObject({ email: "c@x.com", good: 1 })
  })
})
