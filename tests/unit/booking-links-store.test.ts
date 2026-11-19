import { describe, it, expect } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { findLinkByPublicId, findLinkByClaimedInvitee, claimLink, moveClaim, markEffectsDone, setLeadIfEmpty, setReferralOutcome } from "@/lib/booking-links/store"
import { raiseCallCheck, clip } from "@/lib/booking-links/call-checks"

const NOW = new Date("2026-11-13T12:00:00.000Z")
const link = (over: Record<string, unknown> = {}) => ({
  id: "L1", public_id: "A".repeat(22), kind_label: "Client", rule_snapshot: {}, status: "open", once: true, revoked_at: null, expires_at: null,
  claimed_invitee_uri: null, claimed_event_uri: null, claimed_email: null, effects_done_at: null, person_emails: ["m@x.com"], contact_id: null, account_id: null,
  lead_id: null, person_name: "Maria", person_language: null, referrer_contact_id: null, referrer_code: null, referral_outcome: null, ...over,
})
const OPTS = { unique: { booking_links: [["public_id"], ["claimed_invitee_uri"]], call_checks: [["kind", "dedupe_key"]] } }

describe("finding a link", () => {
  it("exact match on the public id", async () => {
    const db = miniDb({ booking_links: [link(), link({ id: "L2", public_id: "B".repeat(22) })] })
    const r = await findLinkByPublicId(db, "A".repeat(22))
    expect(r.state === "found" && r.row.id).toBe("L1")
  })
  it("no such id = none; a missing table = none (a deploy before the migration)", async () => {
    expect((await findLinkByPublicId(miniDb({ booking_links: [link()] }), "C".repeat(22))).state).toBe("none")
    expect((await findLinkByPublicId(miniDb({}, { missing: ["booking_links"] }), "A".repeat(22))).state).toBe("none")
  })
  it("a database error is an ERROR, never 'no such link'", async () => {
    const r = await findLinkByPublicId(miniDb({}, { failing: { booking_links: "connection lost" } }), "A".repeat(22))
    expect(r).toEqual({ state: "error", message: "connection lost" })
    const thrown = await findLinkByPublicId({ from: () => { throw new Error("kaboom") } }, "A".repeat(22))
    expect(thrown).toEqual({ state: "error", message: "kaboom" })
  })
  it("a row with no emails column value reads as an empty list", async () => {
    const r = await findLinkByPublicId(miniDb({ booking_links: [link({ person_emails: null })] }), "A".repeat(22))
    expect(r.state === "found" && r.row.person_emails).toEqual([])
  })
  it("can be found through the booking it claimed (a reschedule whose tag did not arrive)", async () => {
    const db = miniDb({ booking_links: [link({ status: "claimed", claimed_invitee_uri: "inv-0" })] })
    const r = await findLinkByClaimedInvitee(db, "inv-0")
    expect(r.state === "found" && r.row.id).toBe("L1")
    expect((await findLinkByClaimedInvitee(db, "inv-zzz")).state).toBe("none")
  })
})

describe("the atomic claim", () => {
  const c = (db: ReturnType<typeof miniDb>, inv = "inv-1", id = "L1") => claimLink(db, id, { inviteeUri: inv, eventUri: "ev-1", email: "m@x.com", now: NOW })
  it("closes the link and records who took it", async () => {
    const db = miniDb({ booking_links: [link()] }, OPTS)
    expect(await c(db)).toEqual({ state: "claimed" })
    expect(db.tables.booking_links[0]).toMatchObject({ status: "claimed", claimed_invitee_uri: "inv-1", claimed_event_uri: "ev-1", claimed_email: "m@x.com", claimed_at: NOW.toISOString() })
  })
  it("the second claimer LOSES (no row changes) and the first keeps it", async () => {
    const db = miniDb({ booking_links: [link()] }, OPTS)
    expect(await c(db, "inv-1")).toEqual({ state: "claimed" })
    expect(await c(db, "inv-2")).toEqual({ state: "lost" })
    expect(db.tables.booking_links[0].claimed_invitee_uri).toBe("inv-1")
  })
  it("two deliveries racing: exactly one wins", async () => {
    const db = miniDb({ booking_links: [link()] }, OPTS)
    const results = await Promise.all([c(db, "inv-1"), c(db, "inv-2")])
    expect(results.filter((r) => r.state === "claimed")).toHaveLength(1)
    expect(results.filter((r) => r.state === "lost")).toHaveLength(1)
  })
  it("a revoked link cannot be claimed", async () => {
    const db = miniDb({ booking_links: [link({ revoked_at: "2026-11-01T00:00:00Z" })] }, OPTS)
    expect(await c(db)).toEqual({ state: "lost" })
  })
  it("the same booking already holding ANOTHER link is its own branch (duplicate), not a failure", async () => {
    const db = miniDb({ booking_links: [link({ status: "claimed", claimed_invitee_uri: "inv-1" }), link({ id: "L2", public_id: "B".repeat(22) })] }, OPTS)
    expect(await c(db, "inv-1", "L2")).toEqual({ state: "duplicate" })
  })
  it("a database error is reported as an error", async () => {
    expect(await c(miniDb({ booking_links: [link()] }, { failOps: { "booking_links:update": "disk full" } }))).toEqual({ state: "error", message: "disk full" })
  })
})

describe("reschedule, effects done, lead, referral outcome", () => {
  it("moveClaim moves the claim only while it still names the OLD booking", async () => {
    const db = miniDb({ booking_links: [link({ status: "claimed", claimed_invitee_uri: "inv-0", effects_done_at: "2026-11-13T10:00:00Z" })] }, OPTS)
    expect(await moveClaim(db, "L1", { oldInvitee: "inv-0", inviteeUri: "inv-1", eventUri: "ev-1", now: NOW })).toBe(true)
    expect(db.tables.booking_links[0]).toMatchObject({ claimed_invitee_uri: "inv-1", claimed_event_uri: "ev-1", effects_done_at: null })
    expect(await moveClaim(db, "L1", { oldInvitee: "inv-0", inviteeUri: "inv-2", eventUri: null, now: NOW })).toBe(false)
  })
  it("markEffectsDone, setLeadIfEmpty (never overwrites), setReferralOutcome", async () => {
    const db = miniDb({ booking_links: [link()] }, OPTS)
    expect(await markEffectsDone(db, "L1", NOW)).toBe(true)
    await setLeadIfEmpty(db, "L1", "lead-1", NOW)
    await setLeadIfEmpty(db, "L1", "lead-2", NOW)
    await setReferralOutcome(db, "L1", "attributed", NOW)
    expect(db.tables.booking_links[0]).toMatchObject({ effects_done_at: NOW.toISOString(), lead_id: "lead-1", referral_outcome: "attributed" })
  })
  it("none of them ever throws", async () => {
    const boom = { from: () => { throw new Error("boom") } }
    expect(await markEffectsDone(boom, "L1", NOW)).toBe(false)
    expect(await moveClaim(boom, "L1", { oldInvitee: "a", inviteeUri: "b", eventUri: null, now: NOW })).toBe(false)
    await expect(setLeadIfEmpty(boom, "L1", "x", NOW)).resolves.toBeUndefined()
    await expect(setReferralOutcome(boom, "L1", "x", NOW)).resolves.toBeUndefined()
    expect((await claimLink(boom, "L1", { inviteeUri: "a", eventUri: null, email: "e", now: NOW })).state).toBe("error")
  })
})

describe("raiseCallCheck", () => {
  const card = { kind: "mismatch" as const, dedupeKey: "inv-1", bookingLinkId: "L1", payload: { a: 1 } }
  it("saves one card per (kind, dedupe key): the same booking delivered twice makes ONE card", async () => {
    const db = miniDb({}, OPTS)
    expect(await raiseCallCheck(db, card)).toEqual({ ok: true, created: true })
    expect(await raiseCallCheck(db, card)).toEqual({ ok: true, created: false })
    expect(db.tables.call_checks).toHaveLength(1)
    expect(db.tables.call_checks[0]).toMatchObject({ kind: "mismatch", dedupe_key: "inv-1", status: "open", booking_link_id: "L1", payload: { a: 1 } })
  })
  it("a different kind for the same booking is a separate card", async () => {
    const db = miniDb({}, OPTS)
    await raiseCallCheck(db, card)
    await raiseCallCheck(db, { ...card, kind: "effect_failed" })
    expect(db.tables.call_checks).toHaveLength(2)
  })
  it("if the card cannot be saved: reports a system error AND marks the stored event, never throws", async () => {
    const db = miniDb({ webhook_events: [{ id: "WE1", review_status: "auto_created" }] }, { failing: { call_checks: "db down" } })
    const reported: string[] = []
    const r = await raiseCallCheck(db, card, { webhookEventId: "WE1", reportError: async (m) => { reported.push(m) } })
    expect(r).toEqual({ ok: false, created: false })
    expect(reported[0]).toMatch(/could not be saved \(mismatch\): db down/)
    expect(db.tables.webhook_events[0].review_status).toBe("link_check")
  })
  it("a missing table is the same: loud, not silent", async () => {
    const db = miniDb({ webhook_events: [{ id: "WE1", review_status: "auto_created" }] }, { missing: ["call_checks"] })
    const reported: string[] = []
    await raiseCallCheck(db, card, { webhookEventId: "WE1", reportError: async (m) => { reported.push(m) } })
    expect(reported[0]).toMatch(/call_checks table does not exist/)
    expect(db.tables.webhook_events[0].review_status).toBe("link_check")
  })
  it("even a failing reporter and a failing event update do not make it throw", async () => {
    const db = { from: () => { throw new Error("all broken") } }
    await expect(raiseCallCheck(db, card, { webhookEventId: "WE1", reportError: async () => { throw new Error("no reporter") } })).resolves.toEqual({ ok: false, created: false })
  })
  it("clip cuts text that came from a visitor", () => {
    expect(clip("x".repeat(100))).toHaveLength(40)
    expect(clip("")).toBeNull()
    expect(clip(5)).toBeNull()
  })
})
