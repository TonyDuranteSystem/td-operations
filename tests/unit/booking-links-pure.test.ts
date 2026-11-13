import { describe, it, expect } from "vitest"
import { newLinkId, isStrictLinkId } from "@/lib/booking-links/id"
import { extractLinkTag } from "@/lib/booking-links/tag"
import { decideLinkMatch, bookerMatchesRow, normalizeEmail, type LinkRowFacts } from "@/lib/booking-links/match"
import { buildDestination } from "@/lib/booking-links/destination"
import { decideReferralCredit } from "@/lib/booking-links/referral"
import { normalizeLeadLanguage } from "@/lib/booking-links/language"
import { parseBookingMode, readBookingMode, webhookBranchEnabled } from "@/lib/booking-links/switch"
import { isMissingTable, isUniqueViolation } from "@/lib/booking-links/missing-table"
import { miniDb } from "./helpers/mini-db"

describe("link id", () => {
  it("is 22 URL-safe characters (128 bits) and different every time", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newLinkId()))
    expect(ids.size).toBe(200)
    for (const id of ids) {
      expect(id).toHaveLength(22)
      expect(isStrictLinkId(id)).toBe(true)
    }
  })
  it("strict shape: nothing else counts as an id", () => {
    for (const bad of ["", "short", "a".repeat(21), "a".repeat(23), "a".repeat(21) + "!", "a".repeat(21) + " ", "a".repeat(21) + "/", null, undefined, 5, "ad keyword here pls!!"]) expect(isStrictLinkId(bad)).toBe(false)
    expect(isStrictLinkId("A".repeat(22))).toBe(true)
    expect(isStrictLinkId("a-b_c".padEnd(22, "x"))).toBe(true)
  })
})

describe("extractLinkTag", () => {
  const wrap = (p: Record<string, unknown>) => ({ event: "invitee.created", payload: p })
  const id = "A".repeat(22)
  it("reads the strict id from utm_term, with the invitee, event and old invitee", () => {
    const t = extractLinkTag(wrap({ uri: "inv-1", event: "ev-1", old_invitee: "inv-0", tracking: { utm_term: id } }))
    expect(t).toEqual({ utmTerm: id, linkId: id, inviteeUri: "inv-1", eventUri: "ev-1", oldInvitee: "inv-0" })
  })
  it("an ad keyword in utm_term is kept as text but is NOT an id", () => {
    const t = extractLinkTag(wrap({ uri: "inv-1", tracking: { utm_term: "llc formation near me" } }))
    expect(t.utmTerm).toBe("llc formation near me")
    expect(t.linkId).toBeNull()
  })
  it("no tracking, odd shapes and non-text values never throw", () => {
    for (const p of [null, undefined, 5, "x", [], {}, { payload: null }, { payload: { tracking: null } }, { payload: { tracking: { utm_term: 5 } } }, { payload: { tracking: [] } }]) {
      const t = extractLinkTag(p)
      expect(t.linkId).toBeNull()
    }
  })
  it("never trusts anything but utm_term (utm_campaign / utm_content / a1 are not the id)", () => {
    expect(extractLinkTag(wrap({ tracking: { utm_campaign: id, utm_content: id } })).linkId).toBeNull()
  })
})

describe("decideLinkMatch", () => {
  const NOW = new Date("2026-11-13T12:00:00Z")
  const row = (over: Partial<LinkRowFacts> = {}): LinkRowFacts => ({ status: "open", once: true, revoked_at: null, expires_at: null, claimed_invitee_uri: null, claimed_email: null, effects_done_at: null, person_emails: ["maria@x.com"], ...over })
  const d = (r: LinkRowFacts | null, o: Partial<{ inviteeUri: string | null; oldInvitee: string | null; bookerEmail: string }> = {}) =>
    decideLinkMatch({ row: r, inviteeUri: "inv-1", oldInvitee: null, bookerEmail: "maria@x.com", now: NOW, ...o })

  it("no row = unknown id", () => expect(d(null)).toEqual({ action: "unknown" }))
  it("an open one-time link with the right email = claim", () => expect(d(row())).toEqual({ action: "claim" }))
  it("the email match ignores capitals and spaces", () => expect(d(row(), { bookerEmail: "  MARIA@X.COM " })).toEqual({ action: "claim" }))
  it("a different email = mismatch (nothing is claimed)", () => expect(d(row(), { bookerEmail: "other@y.com" })).toEqual({ action: "mismatch" }))
  it("a row with NO emails skips the test: the first booker claims", () => expect(d(row({ person_emails: [] }), { bookerEmail: "anyone@z.com" })).toEqual({ action: "claim" }))
  it("an alias on the row (snapshotted email_2 / alternate email) matches", () => expect(d(row({ person_emails: ["maria@x.com", "maria.work@y.com"] }), { bookerEmail: "maria.work@y.com" })).toEqual({ action: "claim" }))

  it("a reusable (30 minute) link never claims", () => {
    expect(d(row({ once: false }))).toEqual({ action: "reusable" })
    expect(d(row({ once: false }), { bookerEmail: "other@y.com" })).toEqual({ action: "mismatch" })
  })
  it("a reusable link ignores claim columns completely", () => {
    expect(d(row({ once: false, status: "claimed", claimed_invitee_uri: "inv-1" }))).toEqual({ action: "reusable" })
  })

  it("the SAME booking again = replay; effects_done_at tells whether anything is left to do", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-1" }))).toEqual({ action: "replay", effectsDone: false })
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-1", effects_done_at: "2026-11-13T11:00:00Z" }))).toEqual({ action: "replay", effectsDone: true })
  })
  it("a replay is recognised even after the link was revoked or expired (the booking was already legitimately claimed)", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-1", revoked_at: "2026-11-13T11:30:00Z" })).action).toBe("replay")
  })
  it("a DIFFERENT booking on a claimed one-time link = used", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-OTHER" }))).toEqual({ action: "used" })
  })
  it("a reschedule (old invitee = the claimed one, same person) = reschedule", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-0", claimed_email: "maria@x.com" }), { oldInvitee: "inv-0" })).toEqual({ action: "reschedule" })
  })
  it("a reschedule by someone with another email is NOT accepted", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: "inv-0", claimed_email: "maria@x.com" }), { oldInvitee: "inv-0", bookerEmail: "stranger@y.com" })).toEqual({ action: "used" })
  })
  it("a reschedule on an email-less link is judged against the email that claimed it", () => {
    const r = row({ status: "claimed", claimed_invitee_uri: "inv-0", claimed_email: "first@z.com", person_emails: [] })
    expect(d(r, { oldInvitee: "inv-0", bookerEmail: "first@z.com" })).toEqual({ action: "reschedule" })
    expect(d(r, { oldInvitee: "inv-0", bookerEmail: "second@z.com" })).toEqual({ action: "used" })
  })
  it("revoked and expired links are inactive", () => {
    expect(d(row({ revoked_at: "2026-11-01T00:00:00Z" }))).toEqual({ action: "inactive", reason: "revoked" })
    expect(d(row({ expires_at: "2026-11-13T11:59:59Z" }))).toEqual({ action: "inactive", reason: "expired" })
    expect(d(row({ expires_at: "2026-11-13T12:00:01Z" }))).toEqual({ action: "claim" })
  })
  it("a booking with no invitee address cannot be a replay", () => {
    expect(d(row({ status: "claimed", claimed_invitee_uri: null }), { inviteeUri: null })).toEqual({ action: "used" })
  })
})

describe("email helpers", () => {
  it("normalizeEmail", () => {
    expect(normalizeEmail("  A@B.com ")).toBe("a@b.com")
    expect(normalizeEmail(null)).toBe("")
  })
  it("bookerMatchesRow: null when there is nothing to compare", () => {
    expect(bookerMatchesRow([], "a@b.com")).toBeNull()
    expect(bookerMatchesRow(["", "  "], "a@b.com")).toBeNull()
    expect(bookerMatchesRow(["a@b.com"], "A@B.com")).toBe(true)
    expect(bookerMatchesRow(["a@b.com"], "")).toBe(false)
  })
})

describe("buildDestination", () => {
  const id = "B".repeat(22)
  it("adds the link id as utm_term and pre-fills name and email", () => {
    const u = new URL(buildDestination("https://calendly.com/d/abc-123/new-meeting", { linkId: id, name: "Maria Rossi", email: "m@x.com" })!)
    expect(u.hostname).toBe("calendly.com")
    expect(u.searchParams.get("utm_term")).toBe(id)
    expect(u.searchParams.get("name")).toBe("Maria Rossi")
    expect(u.searchParams.get("email")).toBe("m@x.com")
  })
  it("keeps the query of the stored address and encodes values safely", () => {
    const out = buildDestination("https://calendly.com/tonydurante/new-meeting?month=2026-11", { linkId: id, name: "A&B=C", email: "a+b@x.com" })!
    const u = new URL(out)
    expect(u.searchParams.get("month")).toBe("2026-11")
    expect(u.searchParams.get("name")).toBe("A&B=C")
    expect(u.searchParams.get("email")).toBe("a+b@x.com")
  })
  it("refuses any host that is not exactly calendly.com, any scheme but https, userinfo and ports", () => {
    for (const bad of [
      "https://calendly.com.evil.com/x", "https://evil.com/calendly.com", "http://calendly.com/x", "https://user:pw@calendly.com/x",
      "https://calendly.com:8443/x", "https://www.calendly.com/x", "javascript:alert(1)", "//calendly.com/x", "https://evil.com@calendly.com.evil.com/", "not a url", "", null, undefined,
    ]) expect(buildDestination(bad as string, { linkId: id })).toBeNull()
  })
  it("does not add blank name / email", () => {
    const u = new URL(buildDestination("https://calendly.com/d/x", { linkId: id, name: "  ", email: null })!)
    expect(u.searchParams.has("name")).toBe(false)
    expect(u.searchParams.has("email")).toBe(false)
  })
})

describe("decideReferralCredit", () => {
  const f = (o = {}) => ({ hasReferrer: true, mismatch: false, createdNewLead: true, bookerEstablished: false as boolean | null, ...o })
  it("credits only for a matching, brand-new, not-yet-client booker", () => expect(decideReferralCredit(f())).toEqual({ credit: true }))
  it("no referrer on the row = no credit", () => expect(decideReferralCredit(f({ hasReferrer: false }))).toEqual({ credit: false, outcome: "no_referrer" }))
  it("a wrong-email booking never earns a credit (a card asks instead)", () => expect(decideReferralCredit(f({ mismatch: true }))).toEqual({ credit: false, outcome: "mismatch" }))
  it("an existing lead is not a new person", () => expect(decideReferralCredit(f({ createdNewLead: false }))).toEqual({ credit: false, outcome: "not_new_lead" }))
  it("an established client is not a new person", () => expect(decideReferralCredit(f({ bookerEstablished: true }))).toEqual({ credit: false, outcome: "booker_is_client" }))
  it("if the client check could not be made, no credit (fails closed)", () => expect(decideReferralCredit(f({ bookerEstablished: null }))).toEqual({ credit: false, outcome: "booker_unchecked" }))
})

describe("normalizeLeadLanguage", () => {
  it("maps the dirty contact values to the two canonical lead values", () => {
    for (const v of ["Italian", "italian", "it", "IT", "Italiano", "Italiana", "Italian / Englis", "ita"]) expect(normalizeLeadLanguage(v)).toBe("Italian")
    for (const v of ["English", "en", "EN", "english", "Inglese", "eng"]) expect(normalizeLeadLanguage(v)).toBe("English")
  })
  it("writes nothing for anything it cannot read", () => {
    for (const v of ["", " ", null, undefined, 3, "Español", "Deutsch", "itinerary", "entry"]) expect(normalizeLeadLanguage(v)).toBeNull()
  })
})

describe("the switch", () => {
  it("only the exact words count; anything else is off", () => {
    expect(parseBookingMode({ mode: "live" })).toBe("live")
    expect(parseBookingMode({ mode: "page" })).toBe("page")
    expect(parseBookingMode({ mode: "off" })).toBe("off")
    for (const bad of [null, undefined, {}, [], "yes", true, { mode: "LIVE" }, { mode: "on" }, { enabled: true }, 5]) expect(parseBookingMode(bad)).toBe("off")
    expect(parseBookingMode("live")).toBe("live")
  })
  it("absent row, failing read and thrown read all mean off", async () => {
    expect(await readBookingMode(miniDb())).toBe("off")
    expect(await readBookingMode(miniDb({}, { failing: { app_settings: "boom" } }))).toBe("off")
    expect(await readBookingMode({ from: () => { throw new Error("boom") } })).toBe("off")
    expect(await readBookingMode(miniDb({ app_settings: [{ key: "booking", value: { mode: "live" } }] }))).toBe("live")
    expect(await readBookingMode(miniDb({ app_settings: [{ key: "other", value: { mode: "live" } }] }))).toBe("off")
  })
  it("the webhook branch needs live AND the secret; with no secret no database read is made at all", async () => {
    const live = miniDb({ app_settings: [{ key: "booking", value: { mode: "live" } }] })
    expect(await webhookBranchEnabled(live, "secret")).toBe(true)
    expect(await webhookBranchEnabled(live, undefined)).toBe(false)
    expect(await webhookBranchEnabled(live, "")).toBe(false)
    expect(live.log).toHaveLength(1)
    const page = miniDb({ app_settings: [{ key: "booking", value: { mode: "page" } }] })
    expect(await webhookBranchEnabled(page, "secret")).toBe(false)
    expect(await webhookBranchEnabled(miniDb(), "secret")).toBe(false)
  })
})

describe("database error shapes", () => {
  it("missing table", () => {
    expect(isMissingTable({ code: "42P01" })).toBe(true)
    expect(isMissingTable({ code: "PGRST205" })).toBe(true)
    expect(isMissingTable({ message: 'relation "booking_links" does not exist' })).toBe(true)
    expect(isMissingTable({ message: "Could not find the table 'public.booking_links' in the schema cache" })).toBe(true)
    expect(isMissingTable({ code: "23505" })).toBe(false)
    expect(isMissingTable(null)).toBe(false)
    expect(isMissingTable("x")).toBe(false)
  })
  it("unique violation", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true)
    expect(isUniqueViolation({ code: "42P01" })).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })
})
