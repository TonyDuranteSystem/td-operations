import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { describeStatusChange } from "@/lib/accounts/status-change"

const yes = { hasStorage: true }
const no = { hasStorage: false }

describe("describeStatusChange", () => {
  it("says nothing when nothing changed or there is no new status", () => {
    expect(describeStatusChange("Active", "Active", yes)).toMatchObject({ notify: false })
    expect(describeStatusChange("Active", null, yes)).toMatchObject({ notify: false })
  })
  it("Suspended: the client still sees the company, with a banner and limited access", () => {
    const r = describeStatusChange("Active", "Suspended", yes)
    expect(r).toMatchObject({ notify: true, headline: "moved to Suspended" })
    if (r.notify) { expect(r.lines.join(" ")).toMatch(/banner and limited access/); expect(r.lines.join(" ")).toMatch(/storage is kept/) }
  })
  it.each(["Offboarding", "Closed", "Cancelled", "Delinquent"])("%s: the client no longer sees the company", (s) => {
    const r = describeStatusChange("Active", s, yes)
    expect(r).toMatchObject({ notify: true, headline: `moved to ${s}` })
    if (r.notify) expect(r.lines[0]).toMatch(/no longer sees this company/)
  })
  it("a company with no storage says so instead of claiming it was kept", () => {
    const r = describeStatusChange("Active", "Closed", no)
    if (r.notify) { expect(r.lines.join(" ")).toMatch(/no storage/); expect(r.lines.join(" ")).not.toMatch(/kept/) }
  })
  it("Suspended back to Active: banner gone", () => {
    const r = describeStatusChange("Suspended", "Active", yes)
    expect(r).toMatchObject({ notify: true, headline: "is Active again" })
  })
  it("reactivation from a hidden status says whether storage exists", () => {
    const a = describeStatusChange("Closed", "Active", no)
    expect(a).toMatchObject({ notify: true, headline: "was reactivated" })
    if (a.notify) expect(a.lines.join(" ")).toMatch(/NO storage yet/)
    const b = describeStatusChange("Cancelled", "Active", yes)
    if (b.notify) expect(b.lines.join(" ")).toMatch(/storage is still there/)
  })
  it("a new company becoming Active (Pending Formation) is not a status story", () => {
    expect(describeStatusChange("Pending Formation", "Active", no)).toMatchObject({ notify: false })
    expect(describeStatusChange(null, "Active", no)).toMatchObject({ notify: false })
  })
})
