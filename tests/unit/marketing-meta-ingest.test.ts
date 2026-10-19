import { describe, it, expect, vi } from "vitest"
import { FakeDb } from "./helpers/fake-lead-db"
import { findExistingClient, ingestLeadgenEvent, MAX_ATTEMPTS, retryOpenEvents, type IngestDeps } from "@/lib/marketing/meta-leads/ingest"
import type { GraphLead } from "@/lib/marketing/meta-leads/map-lead"

const ev = { leadgenId: "9001", pageId: "111", formId: "222", adId: "333", adgroupId: "444", createdTime: "2026-10-19T10:00:00.000Z" }
const graph: GraphLead = {
  id: "9001", created_time: "2026-10-19T10:00:00+0000", form_id: "222", campaign_name: "LLC ITA",
  field_data: [{ name: "full_name", values: ["Mario Rossi"] }, { name: "email", values: ["mario@example.com"] }, { name: "phone_number", values: ["+39 333 1112233"] }],
}
const deps = (db: FakeDb, over: Partial<IngestDeps> = {}): IngestDeps => ({ db, fetchLead: async () => graph, resolveTeam: async () => "team-1", now: () => new Date("2026-10-19T12:00:00Z"), ...over })
const leads = (db: FakeDb) => db.rows("marketing_leads")
const events = (db: FakeDb) => db.rows("marketing_leadgen_events")

describe("ingestLeadgenEvent", () => {
  it("stores the lead once, assigns the team, writes the timeline and marks the event done", async () => {
    const db = new FakeDb()
    const out = await ingestLeadgenEvent(deps(db), ev, "webhook")
    expect(out).toMatchObject({ status: "stored", duplicate: false })
    expect(leads(db)).toHaveLength(1)
    expect(leads(db)[0]).toMatchObject({ team_id: "team-1", leadgen_id: "9001", full_name: "Mario Rossi", email: "mario@example.com", phone: "+393331112233", status: "new", campaign_name: "LLC ITA" })
    expect(events(db)[0]).toMatchObject({ status: "done", lead_id: leads(db)[0].id })
    expect(db.rows("marketing_lead_events").map(e => e.kind)).toEqual(["received"])
  })
  it("a duplicate delivery or retry never creates a second lead", async () => {
    const db = new FakeDb()
    const fetchLead = vi.fn(async () => graph)
    await ingestLeadgenEvent(deps(db, { fetchLead }), ev, "webhook")
    const again = await ingestLeadgenEvent(deps(db, { fetchLead }), ev, "webhook")
    expect(again).toMatchObject({ status: "already_done", duplicate: true })
    expect(leads(db)).toHaveLength(1)
    expect(fetchLead).toHaveBeenCalledTimes(1)
  })
  it("a failed fetch keeps the event for retry, then a later retry stores the lead", async () => {
    const db = new FakeDb()
    const out = await ingestLeadgenEvent(deps(db, { fetchLead: async () => { throw new Error("Graph 190: token expired") } }), ev, "webhook")
    expect(out).toMatchObject({ status: "failed" })
    expect(events(db)[0]).toMatchObject({ status: "failed", attempts: 1 })
    expect(String(events(db)[0].last_error)).toContain("token expired")
    expect(leads(db)).toHaveLength(0)
    events(db)[0].updated_at = "2026-10-19T11:00:00.000Z" // old enough to retry
    const r = await retryOpenEvents(deps(db))
    expect(r).toEqual({ tried: 1, stored: 1, failed: 0 })
    expect(leads(db)).toHaveLength(1)
    expect(events(db)[0].status).toBe("done")
  })
  it("gives up loudly after the maximum number of attempts", async () => {
    const db = new FakeDb()
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = deps(db, { fetchLead: async () => { throw new Error("boom") } })
    let last: unknown
    for (let i = 0; i < MAX_ATTEMPTS; i++) last = await ingestLeadgenEvent(d, ev, "webhook")
    expect(last).toMatchObject({ status: "gave_up" })
    expect(events(db)[0]).toMatchObject({ status: "gave_up", attempts: MAX_ATTEMPTS })
    expect(err).toHaveBeenCalled()
    expect(await ingestLeadgenEvent(d, ev, "webhook")).toMatchObject({ status: "gave_up" })
    err.mockRestore()
  })
  it("a lead nobody owns yet is stored with no team (Antonio assigns)", async () => {
    const db = new FakeDb()
    await ingestLeadgenEvent(deps(db, { resolveTeam: async () => null }), ev, "webhook")
    expect(leads(db)[0].team_id).toBeNull()
  })
  it("uses the lead the reconcile already fetched (no second Graph call)", async () => {
    const db = new FakeDb()
    const fetchLead = vi.fn(async () => graph)
    const out = await ingestLeadgenEvent(deps(db, { fetchLead }), ev, "reconcile", graph)
    expect(out.status).toBe("stored")
    expect(fetchLead).not.toHaveBeenCalled()
    expect(events(db)[0].source).toBe("reconcile")
  })
  it("a write failure is retried, not lost", async () => {
    const db = new FakeDb()
    db.failTables.add("marketing_leads")
    const out = await ingestLeadgenEvent(deps(db), ev, "webhook")
    expect(out.status).toBe("failed")
    expect(events(db)[0].status).toBe("failed")
  })
})

describe("possible existing client (a hint, never a merge)", () => {
  const contacts = (db: FakeDb) => {
    db.rows("contacts").push({ id: "c1", email: "Mario@Example.com", email_2: null, phone: "+39 333 111 22 33", phone_2: null })
    db.rows("contacts").push({ id: "c2", email: "other@x.com", email_2: "alt@x.com", phone: "+1 727 555 0100", phone_2: "0039 340 9998877" })
  }
  it("matches by email regardless of case, and flags the lead + a timeline event", async () => {
    const db = new FakeDb(); contacts(db)
    await ingestLeadgenEvent(deps(db), ev, "webhook")
    expect(leads(db)[0].existing_client).toMatchObject({ contact_ids: ["c1"], matched_on: expect.arrayContaining(["email", "phone"]) })
    expect(db.rows("marketing_lead_events").map(e => e.kind)).toEqual(["received", "possible_existing_client"])
  })
  it("matches by the last 8 digits of a phone in any format, on the second phone too", async () => {
    const db = new FakeDb(); contacts(db)
    const m = await findExistingClient(db, { email: null, phone: "+39 340 999 8877" })
    expect(m).toEqual({ contact_ids: ["c2"], matched_on: ["phone"] })
  })
  it("no match = null", async () => {
    const db = new FakeDb(); contacts(db)
    expect(await findExistingClient(db, { email: "new@person.com", phone: "+39 111 000 9999" })).toBeNull()
  })
  it("a failed check still stores the lead and says plainly that the check failed", async () => {
    const db = new FakeDb(); db.failTables.add("contacts")
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await ingestLeadgenEvent(deps(db), ev, "webhook")
    expect(out.status).toBe("stored")
    expect(leads(db)[0].existing_client).toMatchObject({ check_failed: true })
    expect(db.rows("marketing_lead_events").map(e => e.kind)).toContain("client_check_failed")
    err.mockRestore()
  })
})
