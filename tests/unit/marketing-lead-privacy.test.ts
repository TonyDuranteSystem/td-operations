import { describe, it, expect } from "vitest"
import { canSeeNotes, redactLead, redactTimeline } from "@/lib/marketing/lead-privacy"
import type { LeadEventRow } from "@/lib/marketing/leads-read"

const ev = (id: number, kind: string, data: Record<string, unknown>): LeadEventRow => ({ id, kind, actor: "a@x", data, created_at: `2026-10-2${id}T10:00:00Z` })
const events = [
  ev(1, "received", {}),
  ev(2, "claimed", {}),
  ev(3, "note", { text: "secret plan" }),
  ev(4, "status_changed", { outcome: "good", to: "qualified", note: "wants an LLC", qualification: [{ item: "x", ticked: true }] }),
  ev(5, "status_changed", { outcome: "not_in_target", reason: "wrong_profile", note: "lives in Italy" }),
]

describe("who may read the team's notes", () => {
  it("the owner, a seller and a setter may; the ad person (reads leads only) may not; nobody may by default", () => {
    expect(canSeeNotes(["leads.pick"])).toBe(true)
    expect(canSeeNotes(["leads.read", "leads.mark"])).toBe(true)
    expect(canSeeNotes(["chat", "inbox", "content.manage", "reports.read", "leads.read"])).toBe(false)
    expect(canSeeNotes([])).toBe(false)
  })
})

describe("redactTimeline", () => {
  it("a person who may read notes gets the history untouched", () => {
    expect(redactTimeline(events, true)).toEqual(events)
  })
  it("the ad person gets the facts but no note rows, no notes inside outcomes and no ticks", () => {
    const r = redactTimeline(events, false)
    expect(r.map(e => e.kind)).toEqual(["received", "claimed", "status_changed", "status_changed"])
    expect(JSON.stringify(r)).not.toMatch(/secret plan|wants an LLC|lives in Italy|qualification/)
    expect(r[2].data).toMatchObject({ outcome: "good", to: "qualified" })
    expect(r[3].data).toMatchObject({ outcome: "not_in_target", reason: "wrong_profile" })
  })
  it("money lines and any kind the list does not know are never shown to the ad person", () => {
    const more = [ev(6, "payment_received", { amount_cents: 100 }), ev(7, "sale_paid_out", {}), ev(8, "something_new", {}), ev(9, "possible_existing_client", {})]
    expect(redactTimeline(more, false).map(e => e.kind)).toEqual(["possible_existing_client"])
    expect(redactTimeline(more, true).length).toBe(4)
  })
  it("never changes the input", () => {
    const copy = JSON.parse(JSON.stringify(events))
    redactTimeline(events, false)
    expect(events).toEqual(copy)
  })
})

describe("redactLead", () => {
  it("drops the ticks for a person who may not read notes", () => {
    const lead = { qualification: [{ item: "a", ticked: true }], x: 1 }
    expect(redactLead(lead, false).qualification).toBeNull()
    expect(redactLead(lead, true).qualification).toEqual(lead.qualification)
  })
})
