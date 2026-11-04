import { describe, it, expect } from "vitest"
import { planLeadAction, leadActionSchema, permissionFor, type ActionSettings, type Actor, type LeadActionInput } from "@/lib/marketing/lead-actions"
import { applyLeadAction, parseLeadAction } from "@/lib/marketing/lead-actions-server"
import { eventText, filterLeads, parseLeadShow } from "@/lib/marketing/lead-view"
import { FakeDb } from "./helpers/fake-lead-db"

const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }],
  reasons: [{ key: "wrong_profile", label: "Wrong profile" }, { key: "other", label: "Other" }],
  checklist: ["Has a business", "Wants to open an LLC", "Can talk this week"],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const NOW = new Date("2026-10-20T10:00:00Z")
const setter: Actor = { id: "u-setter", email: "setter@x.com", role: "member" }
const owner: Actor = { id: "u-owner", email: "rocco@x.com", role: "owner" }
const free = { claimed_by: null, status: "new" }

describe("planLeadAction: picking", () => {
  it("picks a free lead and records who", () => {
    const p = planLeadAction({ action: "claim" }, free, owner, settings, NOW)
    expect(p).toMatchObject({ ok: true, change: { patch: { claimed_by: "u-owner", claimed_by_label: "rocco@x.com" }, event: { kind: "claimed" } } })
  })
  it("refuses a lead someone else picked, and one you already picked", () => {
    expect(planLeadAction({ action: "claim" }, { claimed_by: "u-setter", status: "new" }, owner, settings, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "claim" }, { claimed_by: "u-owner", status: "new" }, owner, settings, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("give back: the picker or the owner only, and only when picked", () => {
    expect(planLeadAction({ action: "release" }, free, owner, settings, NOW)).toMatchObject({ ok: false })
    expect(planLeadAction({ action: "release" }, { claimed_by: "u-owner", status: "new" }, setter, settings, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "release" }, { claimed_by: "u-setter", status: "new" }, setter, settings, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction({ action: "release" }, { claimed_by: "u-setter", status: "new" }, owner, settings, NOW)).toMatchObject({ ok: true })
  })
})

describe("planLeadAction: outcomes", () => {
  it("Good records every checklist item as ticked or not, and moves to the configured stage", () => {
    const p = planLeadAction({ action: "good", ticked: ["Has a business"], note: "calm, clear" }, free, setter, settings, NOW)
    expect(p.ok && p.change.patch).toMatchObject({ status: "qualified", qualification: [{ item: "Has a business", ticked: true }, { item: "Wants to open an LLC", ticked: false }, { item: "Can talk this week", ticked: false }] })
    expect(p.ok && p.change.event.data).toMatchObject({ from: "new", to: "qualified", outcome: "good", note: "calm, clear" })
  })
  it("Good with an item that is not on the checklist is refused (stale page)", () => {
    expect(planLeadAction({ action: "good", ticked: ["Invented"] }, free, setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
  })
  it("Good with an empty checklist still works", () => {
    const p = planLeadAction({ action: "good", ticked: [] }, free, setter, { ...settings, checklist: [] }, NOW)
    expect(p.ok && p.change.patch.qualification).toEqual([])
  })
  it("Not in target needs a reason from the list", () => {
    expect(planLeadAction({ action: "not_in_target", reason: "made_up" }, free, setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    const p = planLeadAction({ action: "not_in_target", reason: "wrong_profile" }, free, setter, settings, NOW)
    expect(p.ok && p.change.patch).toMatchObject({ status: "not_in_target", not_in_target_reason: "wrong_profile", callback_at: null })
  })
  it("Call back needs a real, future-ish, not-too-far day and time", () => {
    const ok = planLeadAction({ action: "call_back", callbackAt: "2026-10-21T09:00:00Z" }, free, setter, settings, NOW)
    expect(ok.ok && ok.change.patch).toMatchObject({ status: "contacted", callback_at: "2026-10-21T09:00:00.000Z" })
    expect(planLeadAction({ action: "call_back", callbackAt: "not a date at all" }, free, setter, settings, NOW)).toMatchObject({ ok: false })
    expect(planLeadAction({ action: "call_back", callbackAt: "2026-10-19T09:00:00Z" }, free, setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "call_back", callbackAt: "2027-12-01T09:00:00Z" }, free, setter, settings, NOW)).toMatchObject({ ok: false, status: 400 })
    // a minute ago is fine (the person just picked the time on the screen)
    expect(planLeadAction({ action: "call_back", callbackAt: "2026-10-20T09:59:00Z" }, free, setter, settings, NOW)).toMatchObject({ ok: true })
  })
  it("a stage that was removed from the pipeline setting is refused in plain words, not written", () => {
    const s2 = { ...settings, stages: settings.stages.filter(s => s.key !== "qualified") }
    const p = planLeadAction({ action: "good", ticked: [] }, free, setter, s2, NOW)
    expect(p).toMatchObject({ ok: false, status: 400 })
    expect(!p.ok && p.error).toMatch(/Ask Antonio/)
  })
  it("a lead someone else picked: others are refused, the owner can still act", () => {
    const theirs = { claimed_by: "u-setter", status: "new" }
    expect(planLeadAction({ action: "note", note: "hi" }, theirs, { ...setter, id: "u-other" }, settings, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "good", ticked: [] }, theirs, owner, settings, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction({ action: "good", ticked: [] }, theirs, setter, settings, NOW)).toMatchObject({ ok: true })
  })
  it("a note changes nothing on the lead but is logged", () => {
    const p = planLeadAction({ action: "note", note: "left a voicemail" }, free, setter, settings, NOW)
    expect(p.ok && p.change.patch).toEqual({})
    expect(p.ok && p.change.event).toEqual({ kind: "note", data: { text: "left a voicemail" } })
  })
})

describe("input rules", () => {
  it("rejects unknown actions, empty notes, oversized notes", () => {
    expect(leadActionSchema.safeParse({ action: "delete" }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "note", note: "   " }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "note", note: "x".repeat(2001) }).success).toBe(false)
    expect(parseLeadAction(null).ok).toBe(false)
    expect(parseLeadAction({ action: "claim", team_id: "other-team" }).ok).toBe(true) // extra fields are ignored; the team never comes from the request
  })
  it("picking needs leads.pick, everything else leads.mark", () => {
    expect(permissionFor("claim")).toBe("leads.pick")
    expect(permissionFor("release")).toBe("leads.pick")
    for (const a of ["good", "not_in_target", "call_back", "note"] as const) expect(permissionFor(a)).toBe("leads.mark")
  })
})

describe("applyLeadAction (writes)", () => {
  function setup() {
    const db = new FakeDb()
    db.rows("marketing_leads").push({ id: "11111111-1111-1111-1111-111111111111", team_id: "T1", status: "new", claimed_by: null })
    db.rows("marketing_leads").push({ id: "22222222-2222-2222-2222-222222222222", team_id: "T2", status: "new", claimed_by: null })
    return db
  }
  const L1 = "11111111-1111-1111-1111-111111111111"
  const L2 = "22222222-2222-2222-2222-222222222222"
  const run = (db: FakeDb, team: string, id: string, input: LeadActionInput, actor: Actor = setter) => applyLeadAction(db, team, id, input, actor, settings, NOW)

  it("saves the change and writes the history row", async () => {
    const db = setup()
    expect(await run(db, "T1", L1, { action: "claim" })).toEqual({ ok: true })
    expect(db.rows("marketing_leads")[0]).toMatchObject({ claimed_by: "u-setter", claimed_by_label: "setter@x.com" })
    expect(db.rows("marketing_lead_events")).toHaveLength(1)
    expect(db.rows("marketing_lead_events")[0]).toMatchObject({ lead_id: L1, kind: "claimed", actor: "setter@x.com" })
  })
  it("another team's lead id finds nothing and changes nothing", async () => {
    const db = setup()
    expect(await run(db, "T1", L2, { action: "claim" })).toMatchObject({ ok: false, status: 404 })
    expect(db.rows("marketing_leads")[1].claimed_by).toBeNull()
    expect(db.rows("marketing_lead_events")).toHaveLength(0)
    expect(await run(db, "T1", "not-a-uuid", { action: "claim" })).toMatchObject({ ok: false, status: 404 })
  })
  it("two people picking: the second one is told, and the first keeps it", async () => {
    const db = setup()
    await run(db, "T1", L1, { action: "claim" }, setter)
    expect(await run(db, "T1", L1, { action: "claim" }, owner)).toMatchObject({ ok: false, status: 409 })
    expect(db.rows("marketing_leads")[0].claimed_by).toBe("u-setter")
    expect(db.rows("marketing_lead_events")).toHaveLength(1)
  })
  it("an outcome moves the status and logs from/to; a refusal writes nothing", async () => {
    const db = setup()
    expect(await run(db, "T1", L1, { action: "not_in_target", reason: "other", note: "no" })).toEqual({ ok: true })
    expect(db.rows("marketing_leads")[0]).toMatchObject({ status: "not_in_target", not_in_target_reason: "other" })
    expect(db.rows("marketing_lead_events")[0].data).toMatchObject({ from: "new", to: "not_in_target", reason: "other", note: "no" })
    const before = db.rows("marketing_lead_events").length
    expect(await run(db, "T1", L1, { action: "not_in_target", reason: "bogus" })).toMatchObject({ ok: false, status: 400 })
    expect(db.rows("marketing_lead_events")).toHaveLength(before)
  })
  it("the lead changing between read and write is caught (nothing is overwritten)", async () => {
    const db = setup()
    const orig = db.from.bind(db)
    let first = true
    db.from = (t: string) => {
      const q = orig(t)
      if (t === "marketing_leads" && first) {
        const ms = q.maybeSingle.bind(q)
        q.maybeSingle = async () => { const r = await ms(); first = false; db.rows("marketing_leads")[0].claimed_by = "u-sneaky"; return r }
      }
      return q
    }
    expect(await run(db, "T1", L1, { action: "claim" })).toMatchObject({ ok: false, status: 409 })
    expect(db.rows("marketing_leads")[0].claimed_by).toBe("u-sneaky")
  })
  it("an action taken while Antonio is viewing as someone is tagged, so it never counts as real work", async () => {
    const db = setup()
    await applyLeadAction(db, "T1", L1, { action: "note", note: "hi" }, setter, settings, NOW, true)
    expect(db.rows("marketing_lead_events").at(-1)).toMatchObject({ kind: "note", data: { text: "hi", via_view_as: true } })
    await run(db, "T1", L1, { action: "note", note: "real" })
    expect(db.rows("marketing_lead_events").at(-1)?.data).toEqual({ text: "real" })
  })
  it("a failed history write is reported, never silent", async () => {
    const db = setup()
    db.failTables.add("marketing_lead_events")
    expect(await run(db, "T1", L1, { action: "note", note: "x" })).toMatchObject({ ok: false, status: 500 })
  })
})

describe("filterLeads / eventText", () => {
  const leads = [
    { id: "a", status: "new", claimed_by: null, callback_at: null },
    { id: "b", status: "qualified", claimed_by: "me", callback_at: null },
    { id: "c", status: "contacted", claimed_by: "me", callback_at: "2026-10-22T10:00:00Z" },
    { id: "d", status: "contacted", claimed_by: "x", callback_at: "2026-10-21T10:00:00Z" },
  ]
  it("narrows by who picked, and by stage", () => {
    expect(filterLeads(leads, { show: "all" }, "me").map(l => l.id)).toEqual(["a", "b", "c", "d"])
    expect(filterLeads(leads, { show: "free" }, "me").map(l => l.id)).toEqual(["a"])
    expect(filterLeads(leads, { show: "mine" }, "me").map(l => l.id)).toEqual(["b", "c"])
    expect(filterLeads(leads, { show: "all", stage: "contacted" }, "me").map(l => l.id)).toEqual(["c", "d"])
  })
  it("call backs: only those with a time, soonest first", () => {
    expect(filterLeads(leads, { show: "callbacks" }, "me").map(l => l.id)).toEqual(["d", "c"])
  })
  it("an unknown filter value falls back to All", () => {
    expect(parseLeadShow("nonsense")).toBe("all")
    expect(parseLeadShow(undefined)).toBe("all")
    expect(parseLeadShow("mine")).toBe("mine")
  })
  it("history lines are plain English", () => {
    expect(eventText("claimed", {}, settings.stages, settings.reasons)).toBe("Handed to the seller")
    expect(eventText("status_changed", { outcome: "not_in_target", reason: "wrong_profile", note: "n" }, settings.stages, settings.reasons)).toBe("Not in target (Wrong profile) — n")
    expect(eventText("status_changed", { outcome: "good", to: "qualified" }, settings.stages, settings.reasons)).toBe("Good — moved to Qualified")
    expect(eventText("something_new", {}, settings.stages, settings.reasons)).toBe("something_new")
  })
})

describe("the client booking link and a lead somebody picked", () => {
  // Regression (production QA, 2 Nov 2026): the link recorded the call as a plain "member", so every picked lead was refused and no real booking could finish.
  const picked = { claimed_by: "u-seller", status: "qualified" }
  const asMember: Actor = { id: "client-booking-link", email: "client (booking link)", role: "member" }
  const asTeam: Actor = { id: "client-booking-link", email: "client (booking link)", role: "owner" }
  it("booking or cancelling a call is open to a member who did not pick the lead (3 Nov 2026: the setter's booking hands the lead over, she must still be able to fix it); the team actor too", () => {
    const set: LeadActionInput = { action: "appointment", at: "2026-10-27T14:00:00Z" }
    const cancel: LeadActionInput = { action: "appointment", at: null }
    expect(planLeadAction(set, picked, asMember, settings, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction(set, picked, asTeam, settings, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction(cancel, picked, asTeam, settings, NOW)).toMatchObject({ ok: true })
  })
  it("the live booking env uses the team actor", async () => {
    const { readFileSync } = await import("node:fs")
    expect(readFileSync("lib/marketing/joint-live.ts", "utf8")).toMatch(/JOINT_ACTOR = \{[^}]*role: "owner"/)
  })
})

describe("the server holds a stale call page back (QA 4 Nov 2026)", () => {
  const L = "55555555-5555-5555-5555-555555555555"
  const mk = () => {
    const db = new FakeDb()
    db.rows("marketing_leads").push({ id: L, team_id: "T1", status: "booked", claimed_by: "u-owner" })
    db.rows("marketing_lead_events").push({ lead_id: L, kind: "appointment", actor: "x", data: { at: "2026-10-27T14:00:00Z", from_status: "qualified" } })
    return db
  }
  const withBooked: ActionSettings = { ...settings, stages: [...settings.stages, { key: "booked", label: "Booked" }] } as ActionSettings
  it("a second booking from a page that saw no call is refused and writes nothing", async () => {
    const db = mk()
    const before = db.rows("marketing_lead_events").length
    const r = await applyLeadAction(db as never, "T1", L, { action: "appointment", at: "2026-10-28T14:00:00Z", replaces: null }, owner, withBooked, NOW)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(db.rows("marketing_lead_events").length).toBe(before)
  })
  it("the page that saw the standing call may move it, and a repeated cancel is refused", async () => {
    const db = mk()
    expect(await applyLeadAction(db as never, "T1", L, { action: "appointment", at: "2026-10-28T14:00:00Z", replaces: "2026-10-27T14:00:00Z" }, owner, withBooked, NOW)).toEqual({ ok: true })
  })
})

describe("cancelling a booked call puts the lead back where it was", () => {
  const withBooked: ActionSettings = { ...settings, stages: [...settings.stages, { key: "booked", label: "Booked" }, { key: "not_ready", label: "Not ready" }], sellerStages: { not_ready: "not_ready" } } as ActionSettings
  const call = { action: "appointment", at: "2026-10-27T14:00:00Z" } as const
  it("booking records the stage the lead came from; cancelling goes back to it", () => {
    const set = planLeadAction(call, { claimed_by: "u-owner", status: "qualified" }, owner, withBooked, NOW)
    expect(set.ok && set.change.patch).toMatchObject({ status: "booked" })
    expect(set.ok && set.change.event.data).toMatchObject({ from_status: "qualified" })
    const cancel = planLeadAction({ action: "appointment", at: null }, { claimed_by: "u-owner", status: "booked", booked_from: "qualified" }, owner, withBooked, NOW)
    expect(cancel.ok && cancel.change.patch).toEqual({ status: "qualified" })
    expect(cancel.ok && cancel.change.event.data).toMatchObject({ at: null, back_to: "qualified" })
  })
  it("leaves the stage alone when the earlier stage is unknown, and refuses a cancel when nothing is booked and the lead is not booked", () => {
    const stay = (lead: Parameters<typeof planLeadAction>[1]) => { const p = planLeadAction({ action: "appointment", at: null }, lead, owner, withBooked, NOW); return p.ok && p.change.patch }
    expect(stay({ claimed_by: "u-owner", status: "booked" })).toEqual({})
    expect(stay({ claimed_by: "u-owner", status: "booked", booked_from: "gone_stage" })).toEqual({})
    // a second cancel (the lead is no longer booked, no call stands) is refused, so no second history line is written
    expect(planLeadAction({ action: "appointment", at: null, replaces: null }, { claimed_by: "u-owner", status: "qualified", booked_from: "contacted" }, owner, withBooked, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("a lead the seller had put aside ('not ready now') comes back to it, with its come-back day, when the call is cancelled (QA 4 Nov 2026: it used to stay booked with no call)", () => {
    const book = planLeadAction(call, { claimed_by: "u-owner", status: "not_ready", callback_at: "2026-10-25T09:00:00.000Z" }, owner, withBooked, NOW)
    expect(book.ok && book.change.event.data).toMatchObject({ from_status: "not_ready", from_callback_at: "2026-10-25T09:00:00.000Z" })
    const cancel = planLeadAction({ action: "appointment", at: null }, { claimed_by: "u-owner", status: "booked", appointment_at: "2026-10-27T14:00:00Z", booked_from: "not_ready", booked_from_callback: "2026-10-25T09:00:00.000Z" }, owner, withBooked, NOW)
    expect(cancel.ok && cancel.change.patch).toEqual({ status: "not_ready", callback_at: "2026-10-25T09:00:00.000Z" })
    // an older booking line has no saved day: the lead comes back due now, never lost
    const legacy = planLeadAction({ action: "appointment", at: null }, { claimed_by: "u-owner", status: "booked", appointment_at: "2026-10-27T14:00:00Z", booked_from: "not_ready" }, owner, withBooked, NOW)
    expect(legacy.ok && legacy.change.patch).toEqual({ status: "not_ready", callback_at: NOW.toISOString() })
  })
  it("a page that went stale is refused: a second booking, a cancel after a re-book, a repeated cancel", () => {
    const standing = { claimed_by: "u-owner", status: "booked", appointment_at: "2026-10-27T14:00:00Z" }
    expect(planLeadAction({ action: "appointment", at: "2026-10-28T14:00:00Z", replaces: null }, standing, owner, withBooked, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "appointment", at: null, replaces: "2026-10-26T14:00:00Z" }, standing, owner, withBooked, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction({ action: "appointment", at: null, replaces: "2026-10-27T14:00:00Z" }, { ...standing, appointment_at: null }, owner, withBooked, NOW)).toMatchObject({ ok: false, status: 409 })
    // the page that saw the standing call may move or cancel it; a page that saw none may book
    expect(planLeadAction({ action: "appointment", at: "2026-10-28T14:00:00Z", replaces: "2026-10-27T14:00:00Z" }, standing, owner, withBooked, NOW)).toMatchObject({ ok: true })
    expect(planLeadAction({ action: "appointment", at: "2026-10-28T14:00:00Z", replaces: null }, { claimed_by: null, status: "qualified", appointment_at: null }, owner, withBooked, NOW)).toMatchObject({ ok: true })
  })
  it("a call cannot be booked from a page on a lead that is out of target; an archived lead is reopened by the booking", () => {
    const at = "2026-10-28T14:00:00Z"
    expect(planLeadAction({ action: "appointment", at, replaces: null }, { claimed_by: null, status: "not_in_target" }, owner, withBooked, NOW)).toMatchObject({ ok: false, status: 409 })
    // the client's booking link (no page, so no `replaces`) is not held to this
    expect(planLeadAction({ action: "appointment", at }, { claimed_by: null, status: "not_in_target" }, owner, withBooked, NOW)).toMatchObject({ ok: true })
    const arch = planLeadAction({ action: "appointment", at, replaces: null }, { claimed_by: "u-owner", status: "archived" }, owner, withBooked, NOW)
    expect(arch.ok && arch.change.patch).toMatchObject({ status: "booked" })
  })
  it("'not in target' is refused once a payment link is out or the lead has paid", () => {
    const sell = { ...withBooked, sellerStages: { not_ready: "not_ready", closed: "closed" }, paidStages: ["paid_call"] } as unknown as ActionSettings
    const nit: LeadActionInput = { action: "not_in_target", reason: "other" }
    expect(planLeadAction(nit, { claimed_by: "u-owner", status: "closed" }, owner, sell, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction(nit, { claimed_by: "u-owner", status: "paid_call" }, owner, sell, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(planLeadAction(nit, { claimed_by: "u-owner", status: "booked" }, owner, sell, NOW)).toMatchObject({ ok: true })
  })
  it("the server reads the earlier stage from the newest booking line, through a move, and stops at an earlier cancel", async () => {
    const L = "33333333-3333-3333-3333-333333333333"
    const db = new FakeDb()
    db.rows("marketing_leads").push({ id: L, team_id: "T1", status: "booked", claimed_by: "u-owner" })
    // the fake database does not sort: the lines are listed newest first, as the real query returns them
    db.rows("marketing_lead_events").push({ lead_id: L, kind: "appointment", actor: "x", data: { at: "2026-10-28T14:00:00Z", from: "2026-10-27T14:00:00Z" } })
    db.rows("marketing_lead_events").push({ lead_id: L, kind: "appointment", actor: "x", data: { at: "2026-10-27T14:00:00Z", from_status: "qualified" } })
    const r = await applyLeadAction(db as never, "T1", L, { action: "appointment", at: null }, owner, withBooked, NOW)
    expect(r).toEqual({ ok: true })
    expect(db.rows("marketing_leads").find(x => x.id === L)?.status).toBe("qualified")
    // a cancel line stops the look-back: a later booking that recorded nothing must not borrow an older stage
    const M = "44444444-4444-4444-4444-444444444444"
    db.rows("marketing_leads").push({ id: M, team_id: "T1", status: "booked", claimed_by: "u-owner" })
    db.rows("marketing_lead_events").push({ lead_id: M, kind: "appointment", actor: "x", data: { at: "2026-10-29T14:00:00Z" } })
    db.rows("marketing_lead_events").push({ lead_id: M, kind: "appointment", actor: "x", data: { at: null } })
    db.rows("marketing_lead_events").push({ lead_id: M, kind: "appointment", actor: "x", data: { at: "2026-10-27T14:00:00Z", from_status: "qualified" } })
    await applyLeadAction(db as never, "T1", M, { action: "appointment", at: null }, owner, withBooked, NOW)
    expect(db.rows("marketing_leads").find(x => x.id === M)?.status).toBe("booked")
  })
})
