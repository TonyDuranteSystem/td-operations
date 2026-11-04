import { describe, it, expect } from "vitest"
import { newestCall, planOneOff, type OneOffEvent } from "@/lib/marketing/handover-one-off"

const appt = (created: string, at: string | null, extra: Record<string, unknown> = {}): OneOffEvent => ({ kind: "appointment", created_at: created, data: { at, ...extra } })
const NOW = new Date("2026-11-03T12:00:00Z")

describe("the one-off hand-over step: which call stands", () => {
  it("the newest booking wins; a later cancel clears it; a move is a newer booking", () => {
    expect(newestCall([appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z"), appt("2026-11-02T10:00:00Z", "2026-11-06T09:00:00Z")])).toBe("2026-11-06T09:00:00Z")
    expect(newestCall([appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z"), appt("2026-11-02T10:00:00Z", null)])).toBeNull()
    expect(newestCall([])).toBeNull()
  })
  it("rows in any order, Antonio's view-as rows and rows that are not bookings are ignored", () => {
    const rows: OneOffEvent[] = [appt("2026-11-02T10:00:00Z", "2026-11-06T09:00:00Z"), appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z"), appt("2026-11-03T10:00:00Z", "2026-12-01T09:00:00Z", { via_view_as: true }), { kind: "note", created_at: "2026-11-04T10:00:00Z", data: { at: "2026-12-25T00:00:00Z" } }]
    expect(newestCall(rows)).toBe("2026-11-06T09:00:00Z")
    expect(newestCall([appt("2026-11-01T10:00:00Z", "not a date")])).toBeNull()
  })
})

describe("the one-off hand-over step: what happens to each lead", () => {
  it("an unpicked booked lead with a call ahead: the seller gets it, it shows under Calls prenotate", () => {
    expect(planOneOff({ id: "a", status: "booked", claimed_by: null }, [appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z")], NOW)).toEqual({ call: "2026-11-05T09:00:00Z", pick: true, toBooked: false, shows: "Calls prenotate" })
  })
  it("a booked lead whose call time has passed (more than 30 minutes ago) or has none shows under After the call", () => {
    expect(planOneOff({ id: "b", status: "booked", claimed_by: null }, [appt("2026-10-20T10:00:00Z", "2026-10-25T09:00:00Z")], NOW).shows).toBe("After the call")
    expect(planOneOff({ id: "b", status: "booked", claimed_by: null }, [appt("2026-11-03T10:00:00Z", "2026-11-03T11:45:00Z")], NOW).shows).toBe("Calls prenotate")
    expect(planOneOff({ id: "b", status: "booked", claimed_by: null }, [], NOW)).toMatchObject({ call: null, shows: "After the call" })
  })
  it("a lead somebody already picked keeps that person", () => {
    expect(planOneOff({ id: "c", status: "booked", claimed_by: "u-rocco" }, [appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z")], NOW)).toMatchObject({ pick: false, shows: "Calls prenotate" })
  })
  it("a lead at the old Contacted step goes back to booked and waits for the answer about its call", () => {
    expect(planOneOff({ id: "d", status: "seller_contacted", claimed_by: null }, [], NOW)).toEqual({ call: null, pick: true, toBooked: true, shows: "After the call" })
    expect(planOneOff({ id: "d", status: "seller_contacted", claimed_by: "u-rocco" }, [appt("2026-10-20T10:00:00Z", "2026-10-25T09:00:00Z")], NOW)).toMatchObject({ pick: false, toBooked: true, shows: "After the call" })
  })
  it("every other stage is left alone", () => {
    for (const status of ["new", "contacted", "qualified", "closed", "paid_call", "not_in_target", "archived"]) {
      expect(planOneOff({ id: "e", status, claimed_by: null }, [appt("2026-11-01T10:00:00Z", "2026-11-05T09:00:00Z")], NOW), status).toMatchObject({ pick: false, toBooked: false, shows: "skip" })
    }
  })
})
