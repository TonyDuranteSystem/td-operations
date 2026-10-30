import { describe, it, expect, vi } from "vitest"
import { viewerOf } from "@/lib/marketing/calendar-visibility"
import { withDeadline } from "@/lib/marketing/gcal"
import { reschedulePush } from "@/lib/marketing/calendar-notify"
import { setterOnlyIds, type MemberRow } from "@/lib/marketing/time-prefs-server"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import { FakeGcal } from "./helpers/fake-gcal"

vi.mock("@/lib/marketing/calendar-read", () => ({
  loadCalendarData: async () => ({ leads: [], events: [], truncated: false, appointments: [{ lead: { id: "L-moving" }, at: "2026-11-03T16:00:00Z", actor: "x" }] }),
}))
import { loadSlotOffer } from "@/lib/marketing/slots-server"
import { clockText } from "@/lib/marketing/zones"

// The bug hunt of 30 Oct 2026 on the time-zone build.

describe("the setter never gets the seller's or the owner's calendar, whatever the Team page says about her", () => {
  it("a setter-only member is a 'setter' viewer even if she is marked as taking calls", () => {
    expect(viewerOf({ ownerLogin: false, hideOwner: true, isTaker: true })).toBe("setter")
  })
  it("the owner on his own login is the owner; a seller who takes calls is the seller; anyone else sees no Google", () => {
    expect(viewerOf({ ownerLogin: true, hideOwner: false, isTaker: false })).toBe("owner")
    expect(viewerOf({ ownerLogin: false, hideOwner: false, isTaker: true })).toBe("seller")
    expect(viewerOf({ ownerLogin: false, hideOwner: false, isTaker: false })).toBe("setter")
  })
  const bundles = { setter: ["leads.read", "leads.worklist", "leads.mark"], seller: ["leads.read", "leads.pick", "calls.host", "leads.mark"] }
  const row = (user_id: string, bundle: string | null, member_role = "member", permissions: string[] | null = null): MemberRow => ({ user_id, status: "active", bundle, member_role, permissions })
  it("setterOnlyIds finds the setters and leaves the seller and the team owner out", () => {
    const ids = setterOnlyIds([row("cristina", "setter"), row("rocco", "seller"), row("antonio", null, "owner")], bundles)
    expect(Array.from(ids)).toEqual(["cristina"])
  })
  it("a setter with a seller permission added by hand is no longer 'a setter and nothing more'", () => {
    expect(setterOnlyIds([row("c", "setter", "member", ["leads.pick"])], bundles).size).toBe(0)
  })
})

describe("withDeadline: a screen that asks Google opens anyway", () => {
  it("returns the answer when it comes in time", async () => { expect(await withDeadline(Promise.resolve("ok"), 50, "late")).toBe("ok") })
  it("returns the fallback when it is late", async () => { expect(await withDeadline(new Promise<string>(r => setTimeout(() => r("slow"), 200)), 20, "late")).toBe("late") })
  it("returns the fallback when it fails", async () => { expect(await withDeadline(Promise.reject(new Error("x")), 50, "late")).toBe("late") })
})

describe("the move notification reads the hour on the receiver's own clock", () => {
  const i = { moverName: "Cristina", leadName: "Marco", from: "2026-11-03T14:00:00Z", to: "2026-11-03T15:00:00Z", reason: "client asked" }
  it("Rocco (Canary Islands) is told 14:00 -> 15:00, not the Rome hours", () => {
    const p = reschedulePush(i, "en-GB", "Atlantic/Canary")
    expect(p.body).toContain("14:00"); expect(p.body).toContain("15:00"); expect(p.body).not.toContain("16:00")
  })
  it("the Rome hours stay the default", () => { expect(reschedulePush(i).body).toContain("15:00") ; expect(reschedulePush(i).body).toContain("16:00") })
})

describe("the lead's own calendar entry does not block its own move", () => {
  const ROC = "rocco@tonydurante.us", ID = "22222222-2222-4222-8222-222222222222"
  const prefs = timePrefsFrom({ member_time_zones: { [ID]: "Atlantic/Canary" }, member_call_hours: { [ID]: { ahead: 7 } }, calendar_busy_enabled: true })
  const seller = { userId: ID, label: "Rocco", email: ROC }
  const NOW = Date.parse("2026-11-02T12:05:00Z")
  const world = () => {
    const g = new FakeGcal()
    g.lists[ROC] = [{ id: ROC, accessRole: "owner", primary: true }]
    // with the write-through on, the call Marketing booked (16:00Z, 30 minutes) is also an event on Rocco's calendar, so Google calls the hour busy
    g.busy[ROC] = { primary: { busy: [{ start: Date.parse("2026-11-03T16:00:00Z"), end: Date.parse("2026-11-03T16:30:00Z") }], error: null } }
    return g
  }
  const day3 = (o: Awaited<ReturnType<typeof loadSlotOffer>>) => (o && o.state === "ok" ? o.days.find(d => d.key === "2026-11-03")?.slots.map(s => clockText(s, "Europe/Rome")) : undefined) ?? []
  it("moving that lead: its own hour (17:00 in Rome) is offered again", async () => {
    const o = await loadSlotOffer({ api: world(), db: {} as never, teamId: "t", prefs, seller, excludeLeadId: "L-moving", nowMs: NOW })
    expect(day3(o)).toContain("17:00")
  })
  it("another lead booking: that hour stays taken (Google's busy time and the Marketing call both hold it)", async () => {
    const o = await loadSlotOffer({ api: world(), db: {} as never, teamId: "t", prefs, seller, excludeLeadId: "someone-else", nowMs: NOW })
    expect(day3(o)).not.toContain("17:00")
  })
})
