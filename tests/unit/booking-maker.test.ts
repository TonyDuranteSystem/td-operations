import { describe, it, expect } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { loadPerson, searchPeople, cleanEmail } from "@/lib/booking/person"
import { judgeLink, makeFreeLink, calendlyFailureText } from "@/lib/booking/make-link"
import { listLinks, revokeLink, linkStatusOf, describeLinkState } from "@/lib/booking/links"
import { decideRedirect, looksLikeBot } from "@/lib/booking/redirect"
import { CalendlyError, type CalendlyCtx, type CalendlyHttpRequest } from "@/lib/calendly/api"

const C1 = "c0000000-0000-4000-8000-000000000001"
const C2 = "c0000000-0000-4000-8000-000000000002"
const L1 = "10000000-0000-4000-8000-000000000001"
const A1 = "a0000000-0000-4000-8000-000000000001"
const TYPE = "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const SALES_TYPE = "https://api.calendly.com/event_types/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
const NOW = new Date("2026-11-14T12:00:00.000Z")

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true, sort_order: 10 },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20 },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false, sort_order: 30 },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false, sort_order: 40 },
}
const kinds = [
  ...(["lead", "client", "partner", "private"] as const).map((s) => ({ id: `k-${s}`, catalog_id: "booking_kinds", slug: s, display_name: s[0].toUpperCase() + s.slice(1), status: "active", metadata: META[s] })),
  { id: "k-old", catalog_id: "booking_kinds", slug: "vendor", display_name: "Vendor", status: "deprecated", metadata: META.partner },
  { id: "k-bare", catalog_id: "booking_kinds", slug: "bare", display_name: "Bare", status: "active", metadata: {} },
]
const seed = (over: Record<string, Array<Record<string, unknown>>> = {}) => ({
  catalog_entries: kinds,
  contacts: [
    { id: C1, full_name: "Maria Rossi", email: "maria@example.com", email_2: "maria2@example.com", alt_emails: ["m.rossi@example.org"], language: "Italian", portal_tier: "active", merged_into: null, is_partner: false, created_at: "2026-01-01" },
    { id: C2, full_name: "Old Merged", email: "old@example.com", email_2: null, alt_emails: [], portal_tier: null, merged_into: C1, created_at: "2026-01-02" },
  ],
  account_contacts: [{ contact_id: C1, account_id: A1, is_primary: true, ended_at: null }],
  accounts: [{ id: A1, company_name: "Rossi Consulting LLC" }],
  service_deliveries: [],
  client_partners: [],
  leads: [
    { id: L1, full_name: "Daniel Green", email: "Daniel@Example.com", language: "English", status: "Call Scheduled", converted_to_contact_id: null, created_at: "2026-11-10" },
    { id: "10000000-0000-4000-8000-000000000002", full_name: "Became Contact", email: "bc@example.com", status: "Converted", converted_to_contact_id: C1, created_at: "2026-11-01" },
  ],
  app_settings: [
    { key: "booking", value: { mode: "page" } },
    { key: "booking_templates", value: { plain: { event_type_uri: TYPE, scheduling_url: "https://calendly.com/x/new-meeting" }, sales: { event_type_uri: SALES_TYPE, scheduling_url: "https://calendly.com/x/free-meet-greet-call" } } },
  ],
  booking_links: [],
  ...over,
})

function calendly(answers: Array<{ status: number; body?: unknown }> = []) {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = {
    token: "t",
    http: async (req) => {
      calls.push(req)
      const a = answers.shift() ?? { status: 500 }
      return { status: a.status, json: async () => a.body }
    },
  }
  return { ctx, calls }
}
const shareOk = { status: 201, body: { resource: { scheduling_links: [{ booking_url: "https://calendly.com/d/abc-123/new-meeting" }] } } }

describe("loadPerson", () => {
  it("a contact: every email they are known by, the company link, and whether they are established", async () => {
    const r = await loadPerson(miniDb(seed()), { type: "contact", id: C1 })
    expect(r).toMatchObject({ ok: true, person: { state: "contact", established: true, contactId: C1, accountId: A1, name: "Maria Rossi" } })
    if (r.ok) expect(r.person.emails).toEqual(["maria@example.com", "maria2@example.com", "m.rossi@example.org"])
  })
  it("a merged contact is refused in plain words", async () => {
    const r = await loadPerson(miniDb(seed()), { type: "contact", id: C2 })
    expect(r).toEqual({ ok: false, error: "That contact was merged into another record. Pick the other one." })
  })
  it("a lead: one email, lower-cased; a lead that already became a contact is refused", async () => {
    const r = await loadPerson(miniDb(seed()), { type: "lead", id: L1 })
    expect(r).toMatchObject({ ok: true, person: { state: "lead", leadId: L1, emails: ["daniel@example.com"] } })
    expect(await loadPerson(miniDb(seed()), { type: "lead", id: "10000000-0000-4000-8000-000000000002" })).toMatchObject({ ok: false })
  })
  it("someone new: name and email are optional; a bad email is refused, not silently dropped", async () => {
    expect(await loadPerson(miniDb(seed()), { type: "new" })).toMatchObject({ ok: true, person: { state: "new", emails: [], name: null } })
    expect(await loadPerson(miniDb(seed()), { type: "new", name: "  Sofia   Bianchi ", email: " Sofia@Example.com " })).toMatchObject({ ok: true, person: { name: "Sofia Bianchi", emails: ["sofia@example.com"] } })
    expect(await loadPerson(miniDb(seed()), { type: "new", email: "not an email" })).toMatchObject({ ok: false })
  })
  it("a made-up id, or a database that fails, is a plain error", async () => {
    expect(await loadPerson(miniDb(seed()), { type: "contact", id: "nope" })).toMatchObject({ ok: false })
    expect(await loadPerson(miniDb(seed(), { failing: { contacts: "boom" } }), { type: "contact", id: C1 })).toEqual({ ok: false, error: "The person could not be read. Try again." })
  })
  it("cleanEmail", () => {
    expect(cleanEmail("A@B.co")).toBe("a@b.co")
    for (const bad of ["", "a@b", "a b@c.com", "a@b.c", null, 3]) expect(cleanEmail(bad)).toBeNull()
  })
})

describe("searchPeople", () => {
  it("finds contacts and leads by name or email, labels them, and leaves out merged contacts and converted leads", async () => {
    const r = await searchPeople(miniDb(seed()), "ma")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rossi = r.hits.find((h) => h.id === C1)!
    expect(rossi).toMatchObject({ type: "contact", name: "Maria Rossi", sub: "Rossi Consulting LLC", badge: "Client", suggestedKind: "client" })
    expect(r.hits.find((h) => h.id === C2)).toBeUndefined()
    const dan = (await searchPeople(miniDb(seed()), "daniel")) as { ok: true; hits: Array<{ type: string; badge: string; suggestedKind: string }> }
    expect(dan.hits[0]).toMatchObject({ type: "lead", badge: "Lead", suggestedKind: "lead" })
    const conv = (await searchPeople(miniDb(seed()), "became")) as { ok: true; hits: unknown[] }
    expect(conv.hits).toEqual([])
  })
  it("a contact who is a partner is suggested the Partner kind", async () => {
    const r = (await searchPeople(miniDb(seed({ client_partners: [{ contact_id: C1 }] })), "maria")) as { ok: true; hits: Array<{ badge: string; suggestedKind: string }> }
    expect(r.hits[0]).toMatchObject({ badge: "Partner", suggestedKind: "partner" })
  })
  it("short text finds nothing; a failing database is an error, never an empty list", async () => {
    expect(await searchPeople(miniDb(seed()), "m")).toEqual({ ok: true, hits: [] })
    expect(await searchPeople(miniDb(seed(), { failing: { leads: "x" } }), "maria")).toMatchObject({ ok: false })
  })
  it("a % or _ in the text is matched literally, not as a wildcard", async () => {
    const r = (await searchPeople(miniDb(seed()), "%%")) as { ok: true; hits: unknown[] }
    expect(r.hits).toEqual([])
  })
})

describe("judgeLink / makeFreeLink", () => {
  const base = { person: { type: "contact" as const, id: C1 }, kindSlug: "client", minutes: 30 }

  it("a standard 30-minute link for a contact needs NO call to Calendly and writes one open row", async () => {
    const db = miniDb(seed())
    const { ctx, calls } = calendly()
    const r = await makeFreeLink({ db, calendly: ctx, createdBy: "antonio@example.com", baseUrl: "https://app.example.com/" }, base)
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    expect(calls).toHaveLength(0)
    expect(r.link.url).toBe(`https://app.example.com/r/b/${r.link.publicId}`)
    expect(r.link.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const row = db.tables.booking_links[0]
    expect(row).toMatchObject({
      kind_label: "Client", kind_entry_id: "k-client", contact_id: C1, account_id: A1, lead_id: null, person_name: "Maria Rossi", person_language: "Italian",
      person_emails: ["maria@example.com", "maria2@example.com", "m.rossi@example.org"], template_slug: "plain", duration_minutes: 30, share_url: null, once: false, status: "open", created_by: "antonio@example.com",
    })
    expect((row.rule_snapshot as { kind_slug: string }).kind_slug).toBe("client")
  })
  it("the first-booking-only tick makes the standard link one-time", async () => {
    const db = miniDb(seed())
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, { ...base, firstBookingOnly: true })
    expect(r.ok).toBe(true)
    expect(db.tables.booking_links[0].once).toBe(true)
  })
  it("any other length asks Calendly for a one-time link and stores its address; the sales call type is used for a new lead", async () => {
    const db = miniDb(seed())
    const { ctx, calls } = calendly([shareOk])
    const r = await makeFreeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "new", name: "Sofia", email: "sofia@example.com" }, kindSlug: "lead", minutes: 45 })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].body as string)).toEqual({ event_type: SALES_TYPE, duration: 45, duration_options: [45] })
    expect(db.tables.booking_links[0]).toMatchObject({ template_slug: "sales", share_url: "https://calendly.com/d/abc-123/new-meeting", once: true, duration_minutes: 45, contact_id: null, person_emails: ["sofia@example.com"] })
  })
  it("someone new with nothing typed still gets a link (no emails to check)", async () => {
    const db = miniDb(seed())
    expect((await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, { person: { type: "new" }, kindSlug: "lead", minutes: 30 })).ok).toBe(true)
    expect(db.tables.booking_links[0].person_emails).toEqual([])
  })
  it("refuses, in plain words and without writing: unknown / retired / needs-setup kind, bad length, merged person", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ kindSlug: "nope" }, /does not exist/],
      [{ kindSlug: "vendor" }, /retired/],
      [{ kindSlug: "bare" }, /needs setup/],
      [{ kindSlug: "" }, /Pick what kind/],
      [{ minutes: 0 }, /whole number of minutes/],
      [{ minutes: "45 min" }, /whole number of minutes/],
      [{ minutes: 721 }, /whole number of minutes/],
      [{ person: { type: "contact", id: C2 } }, /merged/],
    ]
    for (const [over, re] of cases) {
      const db = miniDb(seed())
      const { ctx, calls } = calendly()
      const r = await makeFreeLink({ db, calendly: ctx, createdBy: "a" }, { ...base, ...over } as never)
      expect(r.ok).toBe(false)
      if ("errors" in r) expect(r.errors.join(" ")).toMatch(re)
      expect(db.tables.booking_links).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }
  })
  it("a kind whose effect the page cannot honour is refused: the maker never offers a link that promises nothing", async () => {
    const r = await judgeLink(miniDb(seed({ catalog_entries: [{ id: "k-x", catalog_id: "booking_kinds", slug: "weird", display_name: "Weird", status: "active", metadata: { existing_person: "attach", new_person: "teleport", mark_lead: false, sales_template: false } }] })), { ...base, kindSlug: "weird" })
    expect(r.ok).toBe(false)
  })
  it("missing call types = a plain sentence, nothing written, no call to Calendly", async () => {
    const db = miniDb(seed({ app_settings: [{ key: "booking", value: { mode: "page" } }] }))
    const { ctx, calls } = calendly()
    const r = await makeFreeLink({ db, calendly: ctx, createdBy: "a" }, base)
    expect(r).toEqual({ ok: false, errors: ["The Calendly call types for this page are not set up yet. Ask Claude to set them."] })
    expect(calls).toHaveLength(0)
    expect(db.tables.booking_links).toHaveLength(0)
  })
  it("Calendly refusing a custom length makes nothing and says why in plain words (never the technical text)", async () => {
    for (const [status, re] of [[403, /did not allow/], [429, /busy/], [500, /could not be reached/]] as const) {
      const db = miniDb(seed())
      const r = await makeFreeLink({ db, calendly: calendly([{ status }]).ctx, createdBy: "a" }, { ...base, minutes: 60 })
      expect(r.ok).toBe(false)
      if ("errors" in r) expect(r.errors[0]).toMatch(re)
      expect(db.tables.booking_links).toHaveLength(0)
    }
    expect(calendlyFailureText(new CalendlyError("not_configured", null, "x"))).toMatch(/A 30-minute link still works/)
  })
  it("a clash on the random id draws another; a missing table is said plainly", async () => {
    const db = miniDb(seed(), { unique: { booking_links: [["public_id"]] } })
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, base)
    expect(r.ok).toBe(true)
    expect((await makeFreeLink({ db: miniDb(seed(), { missing: ["booking_links"] }), calendly: calendly().ctx, createdBy: "a" }, base))).toMatchObject({ ok: false })
  })
  it("the preview and the made link come from the same judgement", async () => {
    const j = await judgeLink(miniDb(seed()), base)
    expect(j.ok).toBe(true)
    if (j.ok) {
      expect(j.judged.lines.map((l) => l.label)).toEqual(["Call", "Page", "Record", "Recording", "Use", "If it differs"])
      expect(j.judged.plan.recorder).toBe("attach")
    }
  })
})

describe("Links I made", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "b0000000-0000-4000-8000-00000000000" + Math.floor(Math.random() * 9 + 1), public_id: "AAAAAAAAAAAAAAAAAAAAAA", kind_label: "Client", rule_snapshot: { v: 1, kind_slug: "client", kind_label: "Client", rule: META.client },
    contact_id: C1, lead_id: null, person_name: "Maria Rossi", person_emails: ["maria@example.com"], duration_minutes: 30, once: true, status: "open", revoked_at: null, expires_at: null,
    claimed_event_uri: null, claimed_at: null, open_count: 0, last_opened_at: null, created_at: "2026-11-13T10:00:00Z", ...over,
  })
  it("status: revoked wins, claimed stays claimed past its expiry, an open link past its expiry is expired", () => {
    expect(linkStatusOf({ status: "open", revoked_at: null, expires_at: null }, NOW)).toBe("open")
    expect(linkStatusOf({ status: "open", revoked_at: "2026-11-13T00:00:00Z", expires_at: null }, NOW)).toBe("revoked")
    expect(linkStatusOf({ status: "claimed", revoked_at: null, expires_at: "2026-01-01T00:00:00Z" }, NOW)).toBe("claimed")
    expect(linkStatusOf({ status: "open", revoked_at: null, expires_at: "2026-01-01T00:00:00Z" }, NOW)).toBe("expired")
    expect(linkStatusOf({ status: "claimed", revoked_at: "2026-11-13T00:00:00Z", expires_at: null }, NOW)).toBe("revoked")
  })
  it("plain-English 'what happened'", () => {
    expect(describeLinkState("open", { once: true, open_count: 0 }, null)).toBe("Waiting, not booked yet")
    expect(describeLinkState("open", { once: true, open_count: 1 }, null)).toBe("Waiting, not booked yet · opened 1 time")
    expect(describeLinkState("open", { once: false, open_count: 3 }, null)).toBe("Open for bookings · opened 3 times")
    expect(describeLinkState("revoked", { once: true, open_count: 0 }, null)).toBe("Stopped by you")
    expect(describeLinkState("expired", { once: true, open_count: 0 }, null)).toBe("Not used, expired")
    expect(describeLinkState("claimed", { once: true, open_count: 0 }, null)).toBe("Booked")
    expect(describeLinkState("claimed", { once: true, open_count: 0 }, "2026-11-20T15:00:00Z")).toMatch(/^Booked Fri, Nov 20, 10:00 AM ET$/)
  })
  it("lists newest first with the booked time read from the call log, and builds the address from the app address", async () => {
    const uri = "https://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555"
    const db = miniDb(seed({
      booking_links: [row({ id: "b0000000-0000-4000-8000-000000000001", created_at: "2026-11-12T10:00:00Z" }), row({ id: "b0000000-0000-4000-8000-000000000002", status: "claimed", claimed_event_uri: uri, created_at: "2026-11-13T10:00:00Z", public_id: "BBBBBBBBBBBBBBBBBBBBBB" })],
      contact_calls: [{ calendly_event_uri: uri, scheduled_start: "2026-11-20T15:00:00Z" }],
      lead_calls: [],
    }))
    const r = await listLinks(db, NOW, 100, "https://app.example.com")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.links.map((l) => l.id)).toEqual(["b0000000-0000-4000-8000-000000000002", "b0000000-0000-4000-8000-000000000001"])
    expect(r.links[0]).toMatchObject({ status: "claimed", bookedStart: "2026-11-20T15:00:00Z", url: "https://app.example.com/r/b/BBBBBBBBBBBBBBBBBBBBBB", kindSlug: "client", email: "maria@example.com" })
    expect(r.links[1].status).toBe("open")
  })
  it("a missing table is an empty list; a failing read is an error (never an empty list that looks fine)", async () => {
    expect(await listLinks(miniDb({}, { missing: ["booking_links"] }), NOW)).toEqual({ ok: true, links: [] })
    expect(await listLinks(miniDb({}, { failing: { booking_links: "x" } }), NOW)).toMatchObject({ ok: false })
  })
  it("a failed read of the call log only leaves the booked time out", async () => {
    const uri = "https://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555"
    const db = miniDb(seed({ booking_links: [row({ status: "claimed", claimed_event_uri: uri })] }), { failing: { contact_calls: "x", lead_calls: "x" } })
    const r = await listLinks(db, NOW)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.links[0]).toMatchObject({ status: "claimed", what: "Booked", bookedStart: null })
  })
  it("revoke: stops an open link, repeating it is fine, a booked link cannot be stopped", async () => {
    const db = miniDb(seed({ booking_links: [row({ id: "b0000000-0000-4000-8000-000000000001" }), row({ id: "b0000000-0000-4000-8000-000000000002", status: "claimed" })] }))
    expect(await revokeLink(db, "b0000000-0000-4000-8000-000000000001", NOW)).toMatchObject({ ok: true })
    expect(db.tables.booking_links[0].revoked_at).toBe(NOW.toISOString())
    expect(await revokeLink(db, "b0000000-0000-4000-8000-000000000001", NOW)).toEqual({ ok: true, message: "The link was already stopped." })
    expect(await revokeLink(db, "b0000000-0000-4000-8000-000000000002", NOW)).toMatchObject({ ok: false, status: 409 })
    expect(await revokeLink(db, "b0000000-0000-4000-8000-000000000009", NOW)).toMatchObject({ ok: false, status: 404 })
    expect(await revokeLink(db, "not-an-id", NOW)).toMatchObject({ ok: false, status: 404 })
  })
})

describe("the public redirect", () => {
  const ID = "AbCdEfGhIjKlMnOpQrStUv"
  const FALLBACK = "https://calendly.com/fallback/free-meet-greet-call"
  const link = (over: Record<string, unknown> = {}) => ({
    id: "b0000000-0000-4000-8000-000000000001", public_id: ID, kind_label: "Client", rule_snapshot: {}, status: "open", once: true, revoked_at: null, expires_at: null,
    claimed_invitee_uri: null, claimed_event_uri: null, claimed_email: null, effects_done_at: null, person_emails: ["maria@example.com"], contact_id: C1, account_id: null,
    lead_id: null, person_name: "Maria Rossi", person_language: null, referrer_contact_id: null, referrer_code: null, referral_outcome: null,
    template_slug: "plain", share_url: null, open_count: 0, ...over,
  })
  const go = (db: ReturnType<typeof miniDb>, id: unknown = ID, ua: string | null = "Mozilla/5.0 Safari") => decideRedirect(db as never, id, { now: NOW, fallbackUrl: FALLBACK, userAgent: ua })

  it("a standard link: the booking page named in the settings NOW + the link's id + name and email filled in; the visit is counted", async () => {
    const db = miniDb(seed({ booking_links: [link()] }))
    const r = await go(db)
    expect(r).toMatchObject({ kind: "redirect", tagged: true })
    const u = new URL((r as { location: string }).location)
    expect(u.origin + u.pathname).toBe("https://calendly.com/x/new-meeting")
    expect(u.searchParams.get("utm_term")).toBe(ID)
    expect(u.searchParams.get("name")).toBe("Maria Rossi")
    expect(u.searchParams.get("email")).toBe("maria@example.com")
    expect(Array.from(u.searchParams.keys()).sort()).toEqual(["email", "name", "utm_term"])
    expect(db.tables.booking_links[0].open_count).toBe(1)
    expect(db.tables.booking_links[0].last_opened_at).toBe(NOW.toISOString())
  })
  it("a renamed booking page in the settings is followed at click time", async () => {
    const db = miniDb(seed({ booking_links: [link()], app_settings: [{ key: "booking", value: { mode: "page" } }, { key: "booking_templates", value: { plain: { event_type_uri: TYPE, scheduling_url: "https://calendly.com/x/renamed-meeting" } } }] }))
    expect(((await go(db)) as { location: string }).location).toContain("/x/renamed-meeting")
  })
  it("a link with its own length goes to the one-time address stored when it was made", async () => {
    const db = miniDb(seed({ booking_links: [link({ share_url: "https://calendly.com/d/abc-123/new-meeting" })] }))
    expect(((await go(db)) as { location: string }).location).toMatch(/^https:\/\/calendly\.com\/d\/abc-123\/new-meeting\?/)
  })
  it("the switch off, an unknown id, a malformed id, a stopped link, an expired link, a missing table: the normal booking page, no tag, no count", async () => {
    const plain = { kind: "redirect", location: FALLBACK, tagged: false }
    expect(await go(miniDb(seed({ booking_links: [link()], app_settings: [] })))).toEqual(plain)
    expect(await go(miniDb(seed({ booking_links: [link()], app_settings: [{ key: "booking", value: { mode: "off" } }] })))).toEqual(plain)
    expect(await go(miniDb(seed()), ID)).toEqual(plain)
    for (const bad of ["short", "x".repeat(23), "has spaces here 12345", "../../etc/passwd", "", null, undefined, 5]) expect(await decideRedirect(miniDb(seed({ booking_links: [link()] })) as never, bad, { now: NOW, fallbackUrl: FALLBACK, userAgent: "Safari" })).toEqual(plain)
    expect(await go(miniDb(seed({ booking_links: [link({ revoked_at: "2026-11-13T00:00:00Z" })] })))).toEqual(plain)
    expect(await go(miniDb(seed({ booking_links: [link({ expires_at: "2026-01-01T00:00:00Z" })] })))).toEqual(plain)
    expect(await go(miniDb(seed(), { missing: ["booking_links"] }))).toEqual(plain)
    const stopped = miniDb(seed({ booking_links: [link({ revoked_at: "2026-11-13T00:00:00Z" })] }))
    await go(stopped)
    expect(stopped.tables.booking_links[0].open_count).toBe(0)
  })
  it("a template that is gone or an address that is not calendly.com: the normal booking page, never a redirect elsewhere", async () => {
    const plain = { kind: "redirect", location: FALLBACK, tagged: false }
    expect(await go(miniDb(seed({ booking_links: [link()], app_settings: [{ key: "booking", value: { mode: "live" } }] })))).toEqual(plain)
    expect(await go(miniDb(seed({ booking_links: [link({ share_url: "https://evil.example/d/x" })] })))).toEqual(plain)
    expect(await go(miniDb(seed({ booking_links: [link({ share_url: "http://calendly.com/d/x" })] })))).toEqual(plain)
  })
  it("a used link still goes on to Calendly (the engine decides what to do with a second booking)", async () => {
    const r = await go(miniDb(seed({ booking_links: [link({ status: "claimed" })] })))
    expect(r).toMatchObject({ kind: "redirect", tagged: true })
  })
  it("a lookup that FAILS answers 'try again' instead of quietly dropping the tag", async () => {
    expect(await go(miniDb(seed({ booking_links: [link()] }), { failing: { booking_links: "db down" } }))).toEqual({ kind: "retry" })
  })
  it("preview robots and tools do not count as a person opening it", async () => {
    for (const ua of ["Slackbot-LinkExpanding 1.0", "WhatsApp/2.23", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.1", null, ""]) {
      const db = miniDb(seed({ booking_links: [link()] }))
      expect(await go(db, ID, ua)).toMatchObject({ kind: "redirect", tagged: true })
      expect(db.tables.booking_links[0].open_count).toBe(0)
    }
    expect(looksLikeBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe(false)
  })
  it("the count is a best effort: a failing update never stops the visitor", async () => {
    const db = miniDb(seed({ booking_links: [link()] }), { failOps: { "booking_links:update": "x" } })
    expect(await go(db)).toMatchObject({ kind: "redirect", tagged: true })
  })
})
