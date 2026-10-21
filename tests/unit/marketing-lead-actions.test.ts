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
    expect(eventText("claimed", {}, settings.stages, settings.reasons)).toBe("Picked")
    expect(eventText("status_changed", { outcome: "not_in_target", reason: "wrong_profile", note: "n" }, settings.stages, settings.reasons)).toBe("Not in target (Wrong profile) — n")
    expect(eventText("status_changed", { outcome: "good", to: "qualified" }, settings.stages, settings.reasons)).toBe("Good — moved to Qualified")
    expect(eventText("something_new", {}, settings.stages, settings.reasons)).toBe("something_new")
  })
})
