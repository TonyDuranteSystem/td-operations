import { describe, it, expect } from "vitest"
import { pickWaitingApplications } from "@/lib/bofa-intake/waiting"

const row = (over: Record<string, unknown>) => ({
  id: "id", label: "Direct", partner_name: null, status: "completed", email_status: null, email_error: null,
  completed_at: "2026-11-02T10:00:00Z", reviewed_at: null, returned_at: null, client_name: "A", client_company: "B LLC", ...over,
}) as Parameters<typeof pickWaitingApplications>[0][number]

describe("Calendar → Applications to review", () => {
  it("lists what is still on staff's desk and drops what has left", () => {
    const out = pickWaitingApplications([
      row({ id: "new" }),
      row({ id: "reviewed", reviewed_at: "x" }),
      row({ id: "failed", reviewed_at: "x", email_status: "failed", email_error: "boom" }),
      row({ id: "sent", reviewed_at: "x", email_status: "sent" }),
      row({ id: "old-sent", email_status: "sent" }),
      row({ id: "back", returned_at: "x" }),
      row({ id: "open", status: "opened" }),
      row({ id: "gone", status: "revoked" }),
    ])
    expect(out.map((r) => r.id).sort()).toEqual(["failed", "new", "reviewed"])
    expect(out.find((r) => r.id === "failed")?.error).toBe("boom")
  })

  it("puts the one that has waited longest on top", () => {
    const out = pickWaitingApplications([
      row({ id: "later", completed_at: "2026-11-03T00:00:00Z" }),
      row({ id: "earlier", completed_at: "2026-11-01T00:00:00Z" }),
    ])
    expect(out.map((r) => r.id)).toEqual(["earlier", "later"])
  })

  it("an empty desk is an empty list (the page shows 'nothing waiting' only when the read worked)", () => {
    expect(pickWaitingApplications([])).toEqual([])
  })
})
