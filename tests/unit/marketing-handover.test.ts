import { describe, it, expect } from "vitest"
import { contactChips, contactState, type ContactEvent } from "@/lib/marketing/contact-state"
import { leadActionSchema, permissionFor, planLeadAction, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { eventText } from "@/lib/marketing/lead-view"
import { redactTimeline } from "@/lib/marketing/lead-privacy"
import { messageSigner } from "@/lib/marketing/templates"
import { personName } from "@/lib/marketing/setter-note"
import { cardsInColumn, columnOfCard, hiddenCount, needsCallAnswer, type BoardCard } from "@/lib/marketing/board"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"

const ev = (kind: string, at: string, data: Record<string, unknown> = {}): ContactEvent => ({ kind, created_at: at, data })
const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "booked", label: "Booked" }, { key: "not_in_target", label: "Not in target" }],
  reasons: [{ key: "other", label: "Other" }], checklist: [],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const NOW = new Date("2026-10-20T10:00:00Z")
const setter: Actor = { id: "u", email: "cristina@x.com", role: "member" }

describe("booking the free call IS the hand-over (3 Nov 2026)", () => {
  const rocco = { id: "u-rocco", label: "rocco@x.com" }
  const book = { action: "appointment" as const, at: "2026-10-22T09:00:00Z", note: "wants Wyoming" }
  it("the old pass-without-a-date action is gone", () => {
    expect(leadActionSchema.safeParse({ action: "handover" }).success).toBe(false)
  })
  it("the setter's booking makes the lead the seller's: the pick is set, the stage moves to booked, the history says who it went to", () => {
    const p = planLeadAction(book, { claimed_by: null, status: "qualified", seller: rocco }, setter, settings, NOW)
    expect(p).toMatchObject({ ok: true, change: { patch: { status: "booked", claimed_by: "u-rocco", claimed_by_label: "rocco@x.com", claimed_at: NOW.toISOString() }, event: { kind: "appointment", data: { at: "2026-10-22T09:00:00.000Z", note: "wants Wyoming", from_status: "qualified", handed_to: "u-rocco" } } } })
  })
  it("a lead somebody already picked stays with that person; with nobody to hand it to, nothing is picked", () => {
    const picked = planLeadAction(book, { claimed_by: "u-other", status: "qualified", seller: rocco }, setter, settings, NOW)
    expect(picked).toMatchObject({ ok: true })
    expect(picked.ok && picked.change.patch).not.toHaveProperty("claimed_by")
    const nobody = planLeadAction(book, { claimed_by: null, status: "qualified", seller: null }, setter, settings, NOW)
    expect(nobody.ok && nobody.change.patch).not.toHaveProperty("claimed_by")
  })
  it("moving a call that is already booked (an unpicked lead from before) also hands it over", () => {
    const p = planLeadAction(book, { claimed_by: null, status: "booked", seller: rocco }, setter, settings, NOW)
    expect(p.ok && p.change.patch).toMatchObject({ claimed_by: "u-rocco" })
  })
  it("cancelling the call sends the lead back to the setter AND undoes the automatic pick; a pick made by hand stays", () => {
    const facts = { claimed_by: "u-rocco", status: "booked", booked_from: "qualified", booked_handed_to: "u-rocco" }
    expect(planLeadAction({ action: "appointment", at: null }, facts, setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "qualified", claimed_by: null, claimed_by_label: null, claimed_at: null } } })
    const byHand = planLeadAction({ action: "appointment", at: null }, { ...facts, booked_handed_to: null }, setter, settings, NOW)
    expect(byHand.ok && byHand.change.patch).toEqual({ status: "qualified" })
  })
  it("the seller says whether the call happened: a seller action, only while the lead waits for that answer", () => {
    expect(permissionFor("call_outcome")).toBe("leads.pick")
    expect(leadActionSchema.safeParse({ action: "call_outcome", happened: true }).success).toBe(true)
    expect(leadActionSchema.safeParse({ action: "call_outcome" }).success).toBe(false)
    const seller: Actor = { id: "u-rocco", email: "rocco@x.com", role: "member" }
    expect(planLeadAction({ action: "call_outcome", happened: false }, { claimed_by: "u-rocco", status: "booked" }, seller, settings, NOW)).toMatchObject({ ok: true, change: { patch: {}, event: { kind: "call_outcome", data: { happened: false } } } })
    expect(planLeadAction({ action: "call_outcome", happened: true }, { claimed_by: "u-rocco", status: "qualified" }, seller, settings, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("the contact state keeps the seller's answer; a new booking asks the question again; old pass rows still read", () => {
    const answered = contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z" }), ev("call_outcome", "2026-10-22T10:00:00Z", { happened: false })])
    expect(answered.callAnswer).toBe("missed")
    expect(contactChips(answered, () => "22 Oct").map(c => c.text)).toEqual(["Call 22 Oct", "Call did not happen"])
    const again = contactState([...[ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z" }), ev("call_outcome", "2026-10-22T10:00:00Z", { happened: false })], ev("appointment", "2026-10-22T11:00:00Z", { at: "2026-10-25T09:00:00.000Z" })])
    expect(again.callAnswer).toBeNull()
    expect(contactState([ev("call_outcome", "2026-10-22T10:00:00Z", { happened: true, via_view_as: true })]).callAnswer).toBeNull()
    expect(contactState([ev("handover", "2026-10-21T10:00:00Z", { note: "  old pass  " })])).toMatchObject({ handedOverAt: "2026-10-21T10:00:00Z", handoverNote: "old pass" })
  })
  it("the setter's note on the booking is kept for the seller; a cancel or a booking without a note clears it; the newest booking's note wins", () => {
    const booked = contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z", note: "  wants the costs  " })])
    expect(booked.appointmentNote).toBe("wants the costs")
    expect(contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z", note: "x" }), ev("appointment", "2026-10-21T11:00:00Z", { at: null })]).appointmentNote).toBeNull()
    expect(contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z", note: "old" }), ev("appointment", "2026-10-21T11:00:00Z", { at: "2026-10-23T09:00:00.000Z" })]).appointmentNote).toBeNull()
    expect(contactState([ev("appointment", "2026-10-21T10:00:00Z", { at: "2026-10-22T09:00:00.000Z", note: "a" }), ev("appointment", "2026-10-21T11:00:00Z", { at: "2026-10-23T09:00:00.000Z", note: "b" })]).appointmentNote).toBe("b")
  })
  it("the history lines, and the old pass line still reads for old rows", () => {
    expect(eventText("call_outcome", { happened: true }, [], [])).toBe("The call happened")
    expect(eventText("call_outcome", { happened: false }, [], [])).toBe("The call did not happen")
    expect(eventText("handover", { note: "wants Wyoming" }, [], [])).toBe("Passed to Rocco, no call booked yet — wants Wyoming")
    const rows = [{ id: 1, kind: "handover", actor: "c@x", created_at: "2026-10-21T10:00:00Z", data: { note: "private words" } }]
    expect(redactTimeline(rows, false)[0].data).toEqual({})
    expect(redactTimeline(rows, true)[0].data).toEqual({ note: "private words" })
  })
})

describe("the boards after the hand-over", () => {
  const card = (id: string, stage: string, over: Partial<BoardCard> = {}): BoardCard => ({ id, name: id, stage, stageLabel: stage, phone: null, filledIn: "", apptAt: null, arrivedMs: 1, chips: [], pickedText: "", note: null, ad: null, existingClient: false, callCheck: false, callAnswer: null, unread: 0, ...over })
  it("an in-target lead with no call is the setter's only; it is not on Rocco's board", () => {
    const cards = [card("mine", "qualified")]
    expect(columnOfCard("seller", cards[0])).toBeNull()
    expect(columnOfCard("setter", cards[0])).toBe("in_target")
    expect(hiddenCount("seller", cards)).toBe(1)
  })
  it("the setter's footnote does not count her booked leads: booking handed them to Rocco, they are not missing", () => {
    const cards = [card("b", "booked", { apptAt: "2026-10-22T09:00:00Z" }), card("s", "showed"), card("p", "paid_call")]
    expect(hiddenCount("setter", cards)).toBe(1) // only the paid one; the booked and showed ones are Rocco's
  })
  it("a booked call is under Calls prenotate for Rocco and on no column of the setter's board", () => {
    const b = card("b", "booked", { apptAt: "2026-10-22T09:00:00Z" })
    expect(columnOfCard("seller", b)).toBe("booked")
    expect(columnOfCard("setter", b)).toBeNull()
  })
  it("once the call time has passed it moves to After the call, oldest first; the upcoming ones stay under Calls prenotate", () => {
    const cards = [card("up", "booked", { apptAt: "2026-10-30T09:00:00Z" }), card("old", "booked", { apptAt: "2026-10-01T09:00:00Z", callCheck: true }), card("older", "booked", { apptAt: "2026-09-20T09:00:00Z", callCheck: true }), card("none", "booked", { callCheck: true })]
    expect(cardsInColumn("seller", "booked", cards).map(c => c.id)).toEqual(["up"])
    expect(cardsInColumn("seller", "after_call", cards).map(c => c.id)).toEqual(["none", "older", "old"])
  })
  it("the call is over 30 minutes after it starts; a lead with no call time, or a bad one, needs the answer; other stages never do", () => {
    const now = new Date("2026-11-03T12:00:00Z")
    expect(needsCallAnswer("booked", "2026-11-03T11:29:00Z", now)).toBe(true)
    expect(needsCallAnswer("booked", "2026-11-03T11:31:00Z", now)).toBe(false)
    expect(needsCallAnswer("booked", "2026-11-04T09:00:00Z", now)).toBe(false)
    expect(needsCallAnswer("booked", null, now)).toBe(true)
    expect(needsCallAnswer("showed", "not a date", now)).toBe(true)
    for (const stage of ["new", "qualified", "closed", "paid_call", "not_in_target"]) expect(needsCallAnswer(stage, null, now), stage).toBe(false)
  })
})

describe("whose name signs the message", () => {
  const nameOf = personName
  const base = { events: [], viewerName: "Rocco", viewingAs: false, nameOf, claimedLabel: null as string | null }
  it("the person who picked the lead, whoever is looking", () => {
    expect(messageSigner({ ...base, claimedLabel: "cristina.rossi@x.com" })).toBe("Cristina Rossi")
  })
  it("else the person who last worked it as a setter, never the viewer", () => {
    const events = [{ kind: "whatsapp", actor: "cristina@x.com", created_at: "2026-10-20T10:00:00Z" }, { kind: "note", actor: "rocco@x.com", created_at: "2026-10-22T10:00:00Z" }, { kind: "attempt", actor: "ale@x.com", created_at: "2026-10-21T10:00:00Z" }]
    expect(messageSigner({ ...base, events })).toBe("Ale")
  })
  it("Antonio's View as rows and system rows are not a setter", () => {
    const events = [{ kind: "whatsapp", actor: "antonio@x.com", created_at: "2026-10-20T10:00:00Z", data: { via_view_as: true } }, { kind: "claimed", actor: "system", created_at: "2026-10-21T10:00:00Z" }]
    expect(messageSigner({ ...base, events })).toBe("Rocco")
  })
  it("nobody has worked it: the viewer's own name, but never Antonio's when he is only looking in", () => {
    expect(messageSigner(base)).toBe("Rocco")
    expect(messageSigner({ ...base, viewerName: "Antonio", viewingAs: true })).toBe("")
  })
})

describe("'Fake / no target' is one of the reasons", () => {
  it("is in the built-in list, so it needs no database step", () => {
    expect(MARKETING_SETTING_DEFS.not_in_target_reasons.fallback.map(r => r.key)).toContain("fake")
  })
})
