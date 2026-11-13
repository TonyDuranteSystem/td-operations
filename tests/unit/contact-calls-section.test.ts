/** The contact page's Calls box now also lists "Booked calls" (calls logged under the contact by a made booking link). */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { miniDb } from "./helpers/mini-db"

const h = vi.hoisted(() => ({ db: null as unknown as { from: (t: string) => unknown } }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }))

import { ContactCallsSection } from "@/components/contacts/contact-calls-section"

async function html(seed: Record<string, Array<Record<string, unknown>>>, opts: Parameters<typeof miniDb>[1] = {}, now = "2026-11-13T12:00:00Z") {
  h.db = miniDb(seed, opts)
  vi.setSystemTime(new Date(now))
  const el = await ContactCallsSection({ contactId: "c1" })
  return el ? renderToStaticMarkup(el) : null
}
const booked = (over: Record<string, unknown> = {}) => ({ id: "b1", contact_id: "c1", state: "scheduled", scheduled_start: "2026-11-20T15:00:00Z", scheduled_date: "2026-11-20", event_type_name: "New Meeting", ...over })
const summary = (over: Record<string, unknown> = {}) => ({ id: "s1", contact_id: "c1", meeting_name: "Call with Maria", duration_seconds: 1800, recording_url: null, created_at: "2026-11-20T16:00:00Z", notes: null, action_items: null, ...over })

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }) })

describe("ContactCallsSection — Booked calls", () => {
  it("shows an upcoming booked call with its New York time and a Scheduled chip", async () => {
    const out = await html({ contact_calls: [booked()] })
    expect(out).toMatch(/Booked calls \(1\)/)
    expect(out).toMatch(/New Meeting/)
    expect(out).toMatch(/Nov 20, 2026, 10:00 AM ET/)
    expect(out).toMatch(/Scheduled/)
    expect(out).not.toMatch(/>Calls \(/)
  })
  it("a past booked call that nothing confirmed says 'Not confirmed', never 'Scheduled'", async () => {
    const out = await html({ contact_calls: [booked({ scheduled_start: "2026-11-01T15:00:00Z", scheduled_date: "2026-11-01" })] })
    expect(out).toMatch(/Not confirmed/)
    expect(out).not.toMatch(/>Scheduled</)
  })
  it("a call summary on the same New York day replaces the booked row (no double listing)", async () => {
    const out = await html({ contact_calls: [booked()], call_summaries: [summary()] })
    expect(out).toMatch(/Calls \(1\)/)
    expect(out).not.toMatch(/Booked calls/)
  })
  it("a summary on another day leaves the booked call visible, both boxes show", async () => {
    const out = await html({ contact_calls: [booked()], call_summaries: [summary({ created_at: "2026-11-05T16:00:00Z" })] })
    expect(out).toMatch(/Booked calls \(1\)/)
    expect(out).toMatch(/Calls \(1\)/)
  })
  it("a moved call shows 'Moved'", async () => {
    const out = await html({ contact_calls: [booked({ state: "moved" })] })
    expect(out).toMatch(/Moved/)
  })
  it("nothing at all renders nothing, exactly as before", async () => {
    expect(await html({})).toBeNull()
  })
  it("a missing contact_calls table (code deployed before the migration) changes nothing: summaries still show, nothing breaks", async () => {
    const out = await html({ call_summaries: [summary()] }, { missing: ["contact_calls"] })
    expect(out).toMatch(/Calls \(1\)/)
    expect(await html({}, { missing: ["contact_calls"] })).toBeNull()
  })
  it("a failing contact_calls read does not break the page either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await html({ call_summaries: [summary()] }, { failing: { contact_calls: "db down" } })
    expect(out).toMatch(/Calls \(1\)/)
  })
})
