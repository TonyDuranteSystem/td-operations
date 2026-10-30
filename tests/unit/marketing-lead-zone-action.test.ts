import { describe, it, expect } from "vitest"
import { planLeadAction, leadActionSchema, permissionFor, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { eventText } from "@/lib/marketing/lead-view"
import { parseLeadAction } from "@/lib/marketing/lead-actions-server"

const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "qualified", label: "Qualified" }],
  reasons: [], checklist: [], outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const NOW = new Date("2026-10-30T10:00:00Z")
const setter: Actor = { id: "u-setter", email: "ale@x.com", role: "member" }

describe("setting a lead's time zone by hand (Addendum K)", () => {
  it("is a history entry and changes nothing on the lead", () => {
    const p = planLeadAction({ action: "zone", zone: "America/Chicago" }, { claimed_by: null, status: "new" }, setter, settings, NOW)
    expect(p).toMatchObject({ ok: true, change: { patch: {}, event: { kind: "zone_set", data: { zone: "America/Chicago" } } } })
  })
  it("a lead picked by somebody else can still have its zone corrected (the zone is the same for everybody who works it)", () => {
    expect(planLeadAction({ action: "zone", zone: "Europe/London" }, { claimed_by: "u-other", status: "new" }, setter, settings, NOW)).toMatchObject({ ok: true })
  })
  it("a made-up zone is refused before it reaches the plan", () => {
    expect(leadActionSchema.safeParse({ action: "zone", zone: "Mars/Base" }).success).toBe(false)
    expect(parseLeadAction({ action: "zone", zone: "" }).ok).toBe(false)
    expect(parseLeadAction({ action: "zone", zone: "Europe/Rome" }).ok).toBe(true)
  })
  it("needs the right to mark leads, like the other things a setter does", () => expect(permissionFor("zone")).toBe("leads.mark"))
  it("shows in the history in plain words", () => {
    expect(eventText("zone_set", { zone: "Atlantic/Canary" }, [], [])).toBe("Time zone set to Canary Islands")
    expect(eventText("zone_set", {}, [], [])).toBe("Time zone set to —")
  })
})
