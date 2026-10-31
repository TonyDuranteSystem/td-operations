import { describe, it, expect } from "vitest"
import { viewAsMember, viewerZone, timePrefsFrom } from "@/lib/marketing/time-prefs"
import { takerIdsOf, type MemberRow } from "@/lib/marketing/time-prefs-server"
import { viewerOf } from "@/lib/marketing/calendar-visibility"

// "View as" must show the page of a real person (31 Oct 2026, Antonio: "the screenshot is from Rocco's page and I don't see them").
// No member holds a role on the production team, so the preview used to fall back to Antonio himself: Rome time and no Google.

const ANTONIO = "u-antonio", ROCCO = "u-rocco", CRISTINA = "u-cristina"
const rows = [
  { user_id: ANTONIO, status: "active", bundle: null },
  { user_id: ROCCO, status: "active", bundle: null },
  { user_id: CRISTINA, status: "active", bundle: null },
]

describe("viewAsMember: whose page the preview is", () => {
  it("is nobody when Antonio is not previewing (his own login and everyone else's own page are untouched)", () => {
    expect(viewAsMember({ previewing: false, bundle: null, hostsCalls: true }, rows, [ROCCO])).toBeNull()
    expect(viewAsMember({ previewing: false, bundle: "seller", hostsCalls: true }, [{ user_id: ROCCO, status: "active", bundle: "seller" }], [ROCCO])).toBeNull()
  })
  it("the team owner preview (no role key) and a seller preview are Rocco's page when nobody holds the role", () => {
    expect(viewAsMember({ previewing: true, bundle: null, hostsCalls: true }, rows, [ROCCO])).toBe(ROCCO)
    expect(viewAsMember({ previewing: true, bundle: "seller", hostsCalls: true }, rows, [ROCCO])).toBe(ROCCO)
  })
  it("a member who really holds the previewed role still comes first", () => {
    const held = [{ user_id: ROCCO, status: "active", bundle: null }, { user_id: "u-other", status: "active", bundle: "seller" }]
    expect(viewAsMember({ previewing: true, bundle: "seller", hostsCalls: true }, held, [ROCCO])).toBe("u-other")
  })
  it("a paused holder does not count: the preview falls back to the seller", () => {
    const held = [{ user_id: "u-other", status: "paused", bundle: "seller" }]
    expect(viewAsMember({ previewing: true, bundle: "seller", hostsCalls: true }, held, [ROCCO])).toBe(ROCCO)
  })
  it("the setter and the analyst previews stay nobody (no calls to host): they show no Google and no seller's time", () => {
    expect(viewAsMember({ previewing: true, bundle: "setter", hostsCalls: false }, rows, [ROCCO])).toBeNull()
    expect(viewAsMember({ previewing: true, bundle: "analyst", hostsCalls: false }, rows, [ROCCO])).toBeNull()
  })
  it("a role that hosts calls with nobody taking calls is still nobody (no invented person)", () => {
    expect(viewAsMember({ previewing: true, bundle: null, hostsCalls: true }, rows, [])).toBeNull()
  })
})

describe("the preview reads Rocco's zone and is the seller for Google", () => {
  const prefs = timePrefsFrom({
    owner_clock: { zone: "America/New_York", label: "Antonio" },
    member_time_zones: { [ROCCO]: "Atlantic/Canary", [CRISTINA]: "Europe/Rome" },
    member_call_hours: { [ROCCO]: {} },
  } as Parameters<typeof timePrefsFrom>[0])
  it("zone: Canary Islands, not Rome and not Antonio's New York", () => {
    const asId = viewAsMember({ previewing: true, bundle: null, hostsCalls: true }, rows, [ROCCO])
    expect(viewerZone(prefs, { userId: ANTONIO, ownerLogin: false, viewAsMemberId: asId })).toBe("Atlantic/Canary")
  })
  it("viewer: a taker who is not a setter is the seller; the setter preview is a setter", () => {
    expect(viewerOf({ ownerLogin: false, hideOwner: false, isTaker: true })).toBe("seller")
    expect(viewerOf({ ownerLogin: false, hideOwner: true, isTaker: false })).toBe("setter")
  })
})

describe("takerIdsOf: the members who take calls", () => {
  const bundles = { setter: ["leads.read", "leads.worklist", "leads.mark"], seller: ["leads.read", "leads.pick", "calls.host"] }
  const row = (user_id: string, o: Partial<MemberRow> = {}): MemberRow => ({ user_id, status: "active", bundle: null, member_role: "member", permissions: null, ...o })
  const prefs = { callHours: { [ROCCO]: {}, [CRISTINA]: {}, "u-paused": {} } }
  it("needs working hours, an active membership, and not being a setter and nothing more", () => {
    const list = [row(ROCCO, { member_role: "owner" }), row(CRISTINA, { bundle: "setter" }), row("u-paused", { status: "paused" }), row(ANTONIO, { member_role: "owner" })]
    expect(takerIdsOf(prefs, list, bundles)).toEqual([ROCCO])
  })
})
