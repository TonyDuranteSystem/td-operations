import { describe, it, expect } from "vitest"
import { contactChips, contactState, type ContactEvent } from "@/lib/marketing/contact-state"
import { leadActionSchema, permissionFor, planLeadAction, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { eventText } from "@/lib/marketing/lead-view"
import { redactTimeline } from "@/lib/marketing/lead-privacy"
import { messageSigner } from "@/lib/marketing/templates"
import { personName } from "@/lib/marketing/setter-note"
import { cardsInColumn, columnOfCard, hiddenCount, type BoardCard } from "@/lib/marketing/board"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"

const ev = (kind: string, at: string, data: Record<string, unknown> = {}): ContactEvent => ({ kind, created_at: at, data })
const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "booked", label: "Booked" }, { key: "not_in_target", label: "Not in target" }],
  reasons: [{ key: "other", label: "Other" }], checklist: [],
  outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const NOW = new Date("2026-10-20T10:00:00Z")
const setter: Actor = { id: "u", email: "cristina@x.com", role: "member" }
const free = (status: string) => ({ claimed_by: null, status })

describe("passing a lead to the seller", () => {
  it("is a setter action (needs 'mark') and takes an optional note", () => {
    expect(permissionFor("handover")).toBe("leads.mark")
    expect(leadActionSchema.safeParse({ action: "handover" }).success).toBe(true)
    expect(leadActionSchema.safeParse({ action: "handover", note: "x".repeat(2001) }).success).toBe(false)
  })
  it("moves a lead that is not yet in target to the Good stage; a lead further along stays; one out of target is refused", () => {
    expect(planLeadAction({ action: "handover", note: "wants Wyoming" }, free("contacted"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: { status: "qualified" }, event: { kind: "handover", data: { note: "wants Wyoming", from: "contacted", to: "qualified" } } } })
    expect(planLeadAction({ action: "handover" }, free("qualified"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {}, event: { kind: "handover" } } })
    expect(planLeadAction({ action: "handover" }, free("booked"), setter, settings, NOW)).toMatchObject({ ok: true, change: { patch: {} } })
    expect(planLeadAction({ action: "handover" }, free("not_in_target"), setter, settings, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("a lead somebody else picked is theirs to pass", () => {
    expect(planLeadAction({ action: "handover" }, { claimed_by: "other", status: "qualified" }, setter, settings, NOW)).toMatchObject({ ok: false, status: 409 })
  })
  it("the contact state remembers the newest pass and its note; a booked call keeps both; Antonio looking in is not the team's work", () => {
    const s = contactState([ev("handover", "2026-10-20T10:00:00Z", { note: "old" }), ev("handover", "2026-10-21T10:00:00Z", { note: "  wants Wyoming  " })])
    expect(s).toMatchObject({ handedOverAt: "2026-10-21T10:00:00Z", handoverNote: "wants Wyoming", contacted: true })
    expect(contactState([ev("handover", "2026-10-21T10:00:00Z", { note: null })]).handoverNote).toBeNull()
    expect(contactState([ev("handover", "2026-10-21T10:00:00Z", { via_view_as: true })]).handedOverAt).toBeNull()
  })
  it("the chip says passed until a call is booked, then the call replaces it", () => {
    const passed = contactState([ev("handover", "2026-10-21T10:00:00Z")])
    expect(contactChips(passed, () => "x").map(c => c.text)).toEqual(["Passed to Rocco"])
    const booked = contactState([ev("handover", "2026-10-21T10:00:00Z"), ev("appointment", "2026-10-21T11:00:00Z", { at: "2026-10-26T09:00:00.000Z" })])
    expect(contactChips(booked, () => "26 Oct").map(c => c.text)).toEqual(["Call 26 Oct"])
  })
  it("the history line, and the note is removed for a person who may not read the team's notes (the fact stays)", () => {
    expect(eventText("handover", { note: "wants Wyoming" }, [], [])).toBe("Passed to Rocco, no call booked yet — wants Wyoming")
    const rows = [{ id: 1, kind: "handover", actor: "c@x", created_at: "2026-10-21T10:00:00Z", data: { note: "private words" } }]
    expect(redactTimeline(rows, false)[0].data).toEqual({})
    expect(redactTimeline(rows, true)[0].data).toEqual({ note: "private words" })
  })
})

describe("the seller's board shows only what was passed to him", () => {
  const card = (id: string, stage: string, handedOver: boolean): BoardCard => ({ id, name: id, stage, stageLabel: stage, phone: null, filledIn: "", apptAt: null, arrivedMs: 1, chips: [], pickedText: "", note: null, ad: null, existingClient: false, handedOver })
  it("an in-target lead is the setter's until she passes it; then it is in 'Passed to you'", () => {
    const cards = [card("mine", "qualified", false), card("passed", "qualified", true)]
    expect(columnOfCard("seller", cards[0])).toBeNull()
    expect(columnOfCard("seller", cards[1])).toBe("passed")
    expect(cardsInColumn("seller", "passed", cards).map(c => c.id)).toEqual(["passed"])
    expect(hiddenCount("seller", cards)).toBe(1)
  })
  it("the setter still sees every in-target lead in her own column", () => {
    expect(columnOfCard("setter", card("a", "qualified", false))).toBe("in_target")
    expect(columnOfCard("setter", card("a", "qualified", true))).toBe("in_target")
  })
  it("a booked call is on the seller's board whether or not it was passed", () => {
    expect(columnOfCard("seller", card("b", "booked", false))).toBe("booked")
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
