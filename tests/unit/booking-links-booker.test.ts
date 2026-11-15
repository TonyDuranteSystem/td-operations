/**
 * "Links I made": who booked (dev job 4ebfe4d3, Antonio 15 Nov 2026: "more information about who booked it, name last name email").
 * The shapes are the REAL ones read from the stored deliveries on 15 Nov 2026: ONE name field (first_name and last_name null), an email, no phone, no answers for the short-note call type.
 */
import { describe, it, expect } from "vitest"
import { loadStoredBookings, parseBooker, whoBooked, type Booker } from "@/lib/booking/link-bookings"
import { bookerCard, loadLinkCards, withBooker } from "@/lib/booking/link-cards"
import { listLinks } from "@/lib/booking/links"
import type { CardModel } from "@/lib/crm-lists/hover-cards"

const TAG = "imPPbbGXsfiKBvusoe29vA"
const EV = "https://api.calendly.com/scheduled_events/eca35d2a-fa30-4632-ae08-82a55f4a07bf"

// ── a tiny chainable fake of the database calls these modules make ──
function fakeDb(tables: Record<string, unknown[]>, failing: string[] = []) {
  return {
    from(table: string) {
      const result = failing.includes(table) ? { data: null, error: { message: "boom" } } : { data: tables[table] ?? [], error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      }
      return q
    },
  }
}

const delivery = (over: Record<string, unknown> = {}) => ({
  storedAt: "2026-11-15T14:55:50Z", tag: TAG, eventUri: EV, startTime: "2026-11-17T15:00:00.000000Z", cancelUrl: "https://calendly.com/cancellations/x",
  bookerName: "Uxio Lead Test", bookerFirst: null, bookerLast: null, bookerEmail: "housedurante@icloud.com", bookerPhone: null, bookerAnswers: [], ...over,
})
const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "b0000000-0000-4000-8000-000000000001", public_id: TAG, kind_label: "Private", rule_snapshot: {}, contact_id: null, lead_id: null, person_name: null, person_emails: [],
  duration_minutes: 30, once: true, status: "open", revoked_at: null, expires_at: null, claimed_event_uri: null, claimed_at: null, open_count: 1, last_opened_at: null,
  created_at: "2026-11-15T14:53:00Z", template_slug: "plain", ...over,
})
const NOW = new Date("2026-11-15T15:00:00Z")

describe("parseBooker: the booker from one stored delivery", () => {
  it("the real shape: ONE name, an email, nothing else", () => {
    expect(parseBooker({ name: "Uxio Lead Test", first: null, last: null, email: "housedurante@icloud.com", phone: null, answers: [] })).toEqual({ name: "Uxio Lead Test", email: "housedurante@icloud.com", phone: null, answers: [] })
  })
  it("a first and last name are used only when Calendly really sent them, and only if there is no single name", () => {
    expect(parseBooker({ name: null, first: "Maria", last: "Rossi", email: "m@example.com" })?.name).toBe("Maria Rossi")
    expect(parseBooker({ name: null, first: "Maria", last: null, email: null })?.name).toBe("Maria")
    expect(parseBooker({ name: "Maria Rossi", first: "M", last: "R" })?.name).toBe("Maria Rossi")
  })
  it("answers: question text cut to its first line, empty ones dropped, at most six, long answers cut", () => {
    const b = parseBooker({
      name: "A",
      answers: [
        { question: "What is the main reason for booking this call?\n\nQual è il motivo…", answer: "LLC formation" },
        { question: "Empty", answer: "  " },
        { question: "", answer: "no question" },
        "junk",
        ...Array.from({ length: 10 }, (_, i) => ({ question: `Q${i}`, answer: "x".repeat(500) })),
      ],
    })
    expect(b?.answers[0]).toEqual({ question: "What is the main reason for booking this call?", answer: "LLC formation" })
    expect(b?.answers.length).toBe(6)
    expect(b?.answers[1].answer.length).toBe(300)
  })
  it("a delivery that says nothing about the booker gives null", () => {
    expect(parseBooker({})).toBeNull()
    expect(parseBooker({ name: "  ", email: "", phone: null, answers: "nope" })).toBeNull()
  })
})

describe("whoBooked: what the For column shows", () => {
  const booker = (over: Partial<Booker> = {}): Booker => ({ name: "Uxio Lead Test", email: "housedurante@icloud.com", phone: null, answers: [], ...over })

  it("nobody has booked: the link's own name, or 'Someone new' (the old words)", () => {
    expect(whoBooked({ personName: "Maria Rossi", personEmails: ["m@example.com"] }, null)).toEqual({ primary: "Maria Rossi", secondary: null, differs: false })
    expect(whoBooked({ personName: null, personEmails: [] }, null)).toEqual({ primary: "Someone new", secondary: null, differs: false })
  })
  it("a link with no name shows the real booker, with their email underneath (the two real test rows)", () => {
    expect(whoBooked({ personName: null, personEmails: [] }, booker({ name: "antonnio noel", email: "antonionoeldurante@gmail.com" }))).toEqual({ primary: "antonnio noel", secondary: "antonionoeldurante@gmail.com", differs: false })
  })
  it("a link with no name and a booker with no name shows the email alone", () => {
    expect(whoBooked({ personName: null, personEmails: [] }, booker({ name: null }))).toEqual({ primary: "housedurante@icloud.com", secondary: null, differs: false })
  })
  it("the booker is who the link was made for: the name stays, the email confirms it (capitals and spaces do not matter)", () => {
    expect(whoBooked({ personName: "Uxio Lead Test", personEmails: ["HouseDurante@iCloud.com"] }, booker({ name: "  uxio   lead test " }))).toEqual({ primary: "Uxio Lead Test", secondary: "housedurante@icloud.com", differs: false })
  })
  it("a different email on a link that has emails: shows both, flagged", () => {
    const w = whoBooked({ personName: "Maria Rossi", personEmails: ["maria@example.com"] }, booker({ name: "Maria Rossi", email: "other@example.com" }))
    expect(w).toEqual({ primary: "Maria Rossi", secondary: "Booked by Maria Rossi · other@example.com", differs: true })
  })
  it("a different name: shows both, flagged", () => {
    expect(whoBooked({ personName: "Maria Rossi", personEmails: [] }, booker({ name: "Marco Bianchi", email: "marco@example.com" }))).toMatchObject({ primary: "Maria Rossi", secondary: "Booked by Marco Bianchi · marco@example.com", differs: true })
  })
  it("a link with a name but no emails is not 'different' just because the booker has an email", () => {
    expect(whoBooked({ personName: "Maria Rossi", personEmails: null }, booker({ name: "Maria Rossi", email: "maria@example.com" }))).toMatchObject({ secondary: "maria@example.com", differs: false })
  })
})

describe("the card gains the booker's details", () => {
  const base: CardModel = { title: "Maria Rossi", subtitle: "Portal stage: active", lines: [{ label: "Email", value: "maria@example.com" }], items: { heading: "Company", entries: ["Rossi LLC · Active"] } }
  const row = { person_name: "Maria Rossi", person_emails: ["maria@example.com"] }

  it("nobody booked: the card is untouched", () => {
    expect(withBooker(base, null, row)).toBe(base)
    expect(withBooker(null, null, row)).toBeNull()
  })
  it("no card of its own (someone new, no name or email): the booker's own card", () => {
    expect(withBooker(null, { name: "antonnio noel", email: "a@example.com", phone: "+1 555 0100", answers: [{ question: "Reason", answer: "LLC" }] }, { person_name: null, person_emails: [] })).toEqual({
      title: "antonnio noel", subtitle: "Booked this call", lines: [{ label: "Email", value: "a@example.com" }, { label: "Phone", value: "+1 555 0100" }, { label: "Reason", value: "LLC" }],
    })
    expect(bookerCard({ name: null, email: null, phone: "+1 555 0100", answers: [] }).title).toBe("Booker")
  })
  it("an existing card keeps everything it had and gains the phone and the answers (never a second Phone line)", () => {
    const withPhone: CardModel = { ...base, lines: [...base.lines, { label: "Phone", value: "+39 333" }] }
    const c = withBooker(withPhone, { name: "Maria Rossi", email: "maria@example.com", phone: "+1 555", answers: [{ question: "What is the main reason for booking this call?", answer: "LLC formation" }] }, row)!
    expect(c.items).toEqual(base.items)
    expect(c.lines.filter((l) => l.label === "Phone")).toHaveLength(1)
    expect(c.lines.at(-1)).toEqual({ label: "What is the main reason for…", value: "LLC formation" })
    expect(c.lines.some((l) => l.label === "Booked by")).toBe(false)
  })
  it("a booker who is not the person never has their phone shown as the person's phone, even when the card has no phone of its own", () => {
    const c = withBooker(base, { name: "Marco", email: "marco@example.com", phone: "+1 555", answers: [] }, row)!
    expect(c.lines.some((l) => l.label === "Phone")).toBe(false)
    expect(c.lines).toContainEqual({ label: "Booker phone", value: "+1 555" })
  })
  it("a booker who is not the person: 'Booked by' is added, and the booker's own phone is kept apart", () => {
    const withPhone: CardModel = { ...base, lines: [...base.lines, { label: "Phone", value: "+39 333" }] }
    const c = withBooker(withPhone, { name: "Marco", email: "marco@example.com", phone: "+1 555", answers: [] }, row)!
    expect(c.lines).toContainEqual({ label: "Booked by", value: "Marco · marco@example.com" })
    expect(c.lines).toContainEqual({ label: "Booker phone", value: "+1 555" })
  })
  it("never shows anything sensitive (a booking carries none)", () => {
    expect(JSON.stringify(withBooker(base, { name: "A", email: "a@example.com", phone: null, answers: [] }, row))).not.toMatch(/itin|passport|ein|birth/i)
  })
})

describe("Links I made: who booked, end to end from the stored delivery", () => {
  it("loadStoredBookings carries the booker (the real stored shape)", async () => {
    const r = await loadStoredBookings(fakeDb({ webhook_events: [delivery()] }), [TAG])
    expect(r.ok && r.byTag.get(TAG)?.[0].booker).toEqual({ name: "Uxio Lead Test", email: "housedurante@icloud.com", phone: null, answers: [] })
  })
  it("a link with no name shows the booker on the row and in the card", async () => {
    const r = await listLinks(fakeDb({ booking_links: [linkRow()], webhook_events: [delivery({ bookerName: "antonnio noel", bookerEmail: "antonionoeldurante@gmail.com" })] }), NOW)
    if (!r.ok) throw new Error("list failed")
    expect(r.links[0].who).toEqual({ primary: "antonnio noel", secondary: "antonionoeldurante@gmail.com", differs: false })
    expect(r.links[0].card).toMatchObject({ title: "antonnio noel", subtitle: "Booked this call" })
  })
  it("a booking with no stored copy leaves the row as it was", async () => {
    const r = await listLinks(fakeDb({ booking_links: [linkRow({ person_name: "Maria Rossi" })], webhook_events: [] }), NOW)
    if (!r.ok) throw new Error("list failed")
    expect(r.links[0].who).toEqual({ primary: "Maria Rossi", secondary: null, differs: false })
  })
  it("a failed read of the stored bookings never hides a link or its name", async () => {
    const r = await listLinks(fakeDb({ booking_links: [linkRow({ person_name: "Maria Rossi" })] }, ["webhook_events"]), NOW)
    expect(r.ok && r.links[0].who.primary).toBe("Maria Rossi")
  })
  it("loadLinkCards without bookers behaves as before", async () => {
    const cards = await loadLinkCards(fakeDb({ contacts: [], leads: [], account_contacts: [] }), [{ id: "r", contact_id: null, lead_id: null, person_name: "Anna", person_emails: ["a@example.com"] }])
    expect(cards.get("r")).toEqual({ title: "Anna", subtitle: "Not in the system yet", lines: [{ label: "Email", value: "a@example.com" }] })
  })
})
