/**
 * Zoom filing — the THIRD read of the bookings (contact_calls, Booking page Stage 1a): a client's call booked through a made link has no lead, so it lives in
 * contact_calls; the filing must see it (or a client call overlapping a marketing window is filed as marketing) — and must never be stopped by it.
 */
import { describe, it, expect, vi } from "vitest"
import { miniDb } from "./helpers/mini-db"

const h = vi.hoisted(() => ({ db: null as unknown as { from: (t: string) => unknown } }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }))

import { liveFilingDeps } from "@/lib/crm-store/zoom-call-filing"
import type { CandidateFolder } from "@/lib/crm-store/zoom-call-filing-rules"

const cand: CandidateFolder = { id: "f1", name: "2026-11-10 09.00.57 Maria Rossi and Antonio Durante", createdAt: new Date("2026-11-10T14:01:01Z"), lastActivity: new Date("2026-11-10T14:27:35Z"), uploadOpen: false }
const call = (over: Record<string, unknown> = {}) => ({ contact_id: "c1", state: "scheduled", scheduled_start: "2026-11-10T14:00:00Z", ...over })

async function read(seed: Record<string, Array<Record<string, unknown>>>, opts: Parameters<typeof miniDb>[1] = {}) {
  h.db = miniDb({ contacts: [{ id: "c1", full_name: "Maria Rossi" }], ...seed }, opts)
  return liveFilingDeps({ now: () => new Date("2026-11-10T15:00:00Z") }).bookings([cand])
}

describe("the Zoom filing reads calls logged under a contact", () => {
  it("a still-scheduled call inside the window is a 'calendly' booking with the contact's name", async () => {
    const out = await read({ contact_calls: [call()] })
    expect(out).toEqual([{ kind: "calendly", start: new Date("2026-11-10T14:00:00Z"), end: null, who: "Maria Rossi" }])
  })
  it("a moved or cancelled call, and a call outside the window, are not bookings", async () => {
    const out = await read({ contact_calls: [call({ state: "moved" }), call({ state: "cancelled" }), call({ scheduled_start: "2026-12-30T14:00:00Z" })] })
    expect(out).toEqual([])
  })
  it("all three sources are read together (lead calls, marketing links, contact calls)", async () => {
    const out = await read({
      lead_calls: [{ lead_id: "l1", state: "scheduled", scheduled_start: "2026-11-10T13:30:00Z" }],
      leads: [{ id: "l1", full_name: "Some Lead" }],
      marketing_joint_links: [{ client_name: "Mk Client", starts_at: "2026-11-10T16:00:00Z", ends_at: null, cancelled_at: null, revoked_at: null, booked_at: "2026-11-09T10:00:00Z" }],
      contact_calls: [call()],
    })
    expect(out.map((b) => b.kind).sort()).toEqual(["calendly", "calendly", "marketing"])
    expect(out.map((b) => b.who).sort()).toEqual(["Maria Rossi", "Mk Client", "Some Lead"])
  })
  it("a MISSING contact_calls table (code deployed before the migration) changes nothing: the other sources still answer", async () => {
    const out = await read({ lead_calls: [{ lead_id: "l1", state: "scheduled", scheduled_start: "2026-11-10T13:30:00Z" }], leads: [{ id: "l1", full_name: "Some Lead" }] }, { missing: ["contact_calls"] })
    expect(out).toHaveLength(1)
    expect(out[0].who).toBe("Some Lead")
  })
  it("a failing contact_calls read never stops the filing (unlike the two older reads, which throw by design)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await read({}, { failing: { contact_calls: "db down" } })
    expect(out).toEqual([])
  })
  it("the older read of lead calls still throws on an error, exactly as before", async () => {
    await expect(read({}, { failing: { lead_calls: "db down" } })).rejects.toThrow(/Could not read the Calendly bookings/)
  })
})
