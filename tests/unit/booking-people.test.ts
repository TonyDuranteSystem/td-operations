/**
 * Booking page, "People" (a person who is just a contact) + "Client is not offered for someone new" (Antonio, 14 Nov 2026).
 * Runs the real code against a small in-memory database. No Calendly, no network.
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { miniDb } from "./helpers/mini-db"
import { kindOfferedToNewPerson, parseKindRule } from "@/lib/booking/kinds"
import { checkPeopleInput, findOrCreateBookingContact, removeJustCreatedBookingContact } from "@/lib/operations/booking-contact"
import { loadPerson, searchPeople } from "@/lib/booking/person"
import { judgeLink, makeFreeLink } from "@/lib/booking/make-link"
import { listKinds } from "@/lib/booking/kinds-admin"
import { personRefFrom } from "@/lib/booking/route-helpers"
import { CalendlyError, type CalendlyCtx, type CalendlyHttpRequest } from "@/lib/calendly/api"

const C1 = "c0000000-0000-4000-8000-000000000001"
const C2 = "c0000000-0000-4000-8000-000000000002"
const C3 = "c0000000-0000-4000-8000-000000000003"
const L1 = "10000000-0000-4000-8000-000000000001"
const TYPE = "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const SALES_TYPE = "https://api.calendly.com/event_types/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
const NOW = new Date("2026-11-14T23:30:00.000Z") // 6:30 pm in New York, still 14 Nov there

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true, sort_order: 10 },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20, for_new_person: false },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false, sort_order: 30 },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false, sort_order: 40 },
  people: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 50, for_new_person: false },
}
const kinds = (["lead", "client", "partner", "private", "people"] as const).map((s) => ({ id: `k-${s}`, catalog_id: "booking_kinds", slug: s, display_name: s[0].toUpperCase() + s.slice(1), status: "active", metadata: META[s] }))

const seed = (over: Record<string, Array<Record<string, unknown>>> = {}) => ({
  catalog_entries: kinds,
  contacts: [
    // a bare contact: no tier, no company
    { id: C1, full_name: "Giulia Verdi", email: "giulia@example.com", email_2: "giulia2@example.com", alt_emails: ["g.verdi@example.org"], language: "Italian", portal_tier: null, merged_into: null, is_partner: false, created_at: "2026-01-01" },
    // a merged tombstone: never reused
    { id: C2, full_name: "Old Merged", email: "merged@example.com", email_2: null, alt_emails: [], portal_tier: null, merged_into: C1, created_at: "2026-01-02" },
    // an established client (has a company link)
    { id: C3, full_name: "Maria Rossi", email: "maria@example.com", email_2: null, alt_emails: [], language: "English", portal_tier: "active", merged_into: null, is_partner: false, created_at: "2026-01-03" },
  ],
  account_contacts: [{ contact_id: C3, account_id: "a0000000-0000-4000-8000-000000000001", is_primary: true, ended_at: null }],
  accounts: [{ id: "a0000000-0000-4000-8000-000000000001", company_name: "Rossi Consulting LLC" }],
  service_deliveries: [],
  client_partners: [],
  leads: [{ id: L1, full_name: "Daniel Green", email: "Daniel@Example.com", language: "English", status: "Call Scheduled", converted_to_contact_id: null, created_at: "2026-11-10" }],
  app_settings: [
    { key: "booking", value: { mode: "page" } },
    { key: "booking_templates", value: { plain: { event_type_uri: TYPE, scheduling_url: "https://calendly.com/x/new-meeting" }, sales: { event_type_uri: SALES_TYPE, scheduling_url: "https://calendly.com/x/free-meet-greet-call" } } },
  ],
  booking_links: [],
  ...over,
})

function calendly(answers: Array<{ status: number; body?: unknown }> = []) {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = { token: "t", http: async (req) => { calls.push(req); const a = answers.shift() ?? { status: 500 }; return { status: a.status, json: async () => a.body } } }
  return { ctx, calls }
}
const shareOk = { status: 201, body: { resource: { scheduling_links: [{ booking_url: "https://calendly.com/d/abc-123/new-meeting" }] } } }

describe("kindOfferedToNewPerson", () => {
  it("only an explicit false hides a kind from 'Someone new'", () => {
    expect(kindOfferedToNewPerson({ for_new_person: false })).toBe(false)
    expect(kindOfferedToNewPerson({ for_new_person: true })).toBe(true)
    expect(kindOfferedToNewPerson({ existing_person: "attach" })).toBe(true)
    expect(kindOfferedToNewPerson(null)).toBe(true)
    expect(kindOfferedToNewPerson("x")).toBe(true)
    expect(kindOfferedToNewPerson({ for_new_person: "no" })).toBe(true)
  })
  it("the extra key does not disturb the rule itself", () => {
    expect(parseKindRule(META.client)).toEqual({ ok: true, rule: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false }, sortOrder: 20 })
    expect(parseKindRule(META.people).ok).toBe(true)
  })
})

describe("checkPeopleInput", () => {
  it("needs a name AND an email, and says so in plain words", () => {
    expect(checkPeopleInput("Anna Bianchi", "ANNA@Example.com")).toMatchObject({ ok: true, fullName: "Anna Bianchi", firstName: "Anna", lastName: "Bianchi", email: "anna@example.com" })
    expect(checkPeopleInput("", "a@b.com")).toEqual({ ok: false, error: "Enter the person's name." })
    expect(checkPeopleInput("Anna", "")).toMatchObject({ ok: false, error: expect.stringMatching(/email/) })
    expect(checkPeopleInput("Anna", "not an email")).toMatchObject({ ok: false, error: expect.stringMatching(/does not look right/) })
    expect(checkPeopleInput(null, null)).toMatchObject({ ok: false })
  })
})

describe("findOrCreateBookingContact", () => {
  it("makes a plain contact: name, email, a note — and NOTHING else (no lead, no company, no tier)", async () => {
    const db = miniDb(seed())
    const r = await findOrCreateBookingContact(db, { name: "  Anna   Bianchi ", email: "Anna@Example.com" }, NOW)
    expect(r).toMatchObject({ ok: true, created: true, fullName: "Anna Bianchi" })
    const row = db.tables.contacts.find((c) => c.email === "anna@example.com") as Record<string, unknown>
    expect(row).toMatchObject({ full_name: "Anna Bianchi", first_name: "Anna", last_name: "Bianchi", email: "anna@example.com" })
    expect(row.notes).toMatch(/^Created 2026-11-14 from the Booking page \(a People link\)/)
    expect(row).not.toHaveProperty("portal_tier")
    expect(db.tables.leads).toHaveLength(1) // only the seeded one
    expect(db.tables.account_contacts).toHaveLength(1)
    expect(db.tables.accounts).toHaveLength(1)
  })
  it("reuses a contact found by ANY of its emails, never a duplicate", async () => {
    for (const email of ["giulia@example.com", "GIULIA2@example.com", "g.verdi@example.org"]) {
      const db = miniDb(seed())
      const r = await findOrCreateBookingContact(db, { name: "Whoever", email }, NOW)
      expect(r).toEqual({ ok: true, contactId: C1, created: false, fullName: "Giulia Verdi" })
      expect(db.tables.contacts).toHaveLength(3)
    }
  })
  it("ignores a merged tombstone: that email makes a fresh contact", async () => {
    const db = miniDb(seed())
    const r = await findOrCreateBookingContact(db, { name: "Merged Again", email: "merged@example.com" }, NOW)
    expect(r).toMatchObject({ ok: true, created: true })
    expect(r.ok && r.contactId).not.toBe(C2)
  })
  it("refuses a missing name or email without touching the database", async () => {
    const db = miniDb(seed())
    expect(await findOrCreateBookingContact(db, { name: "", email: "x@y.com" })).toMatchObject({ ok: false })
    expect(await findOrCreateBookingContact(db, { name: "Anna", email: "" })).toMatchObject({ ok: false })
    expect(db.log).toHaveLength(0)
  })
  it("a database error on the look-up or on the insert comes back in plain words, never as a thrown error", async () => {
    expect(await findOrCreateBookingContact(miniDb(seed(), { failing: { contacts: "boom" } }), { name: "Anna Bianchi", email: "a@b.com" }, NOW)).toEqual({ ok: false, error: "The contacts could not be read. Try again." })
    expect(await findOrCreateBookingContact(miniDb(seed(), { failOps: { "contacts:insert": "boom" } }), { name: "Anna Bianchi", email: "a@b.com" }, NOW)).toEqual({ ok: false, error: "The contact could not be saved. Try again." })
  })
  it("two requests for the same email at the same moment: the one that loses the race reuses the winner", async () => {
    const db = miniDb(seed(), { unique: { contacts: [["email"]] } })
    const realFrom = db.from.bind(db) as (t: string) => Record<string, (...a: unknown[]) => unknown>
    let injected = false
    const racing = {
      ...db,
      from: (t: string) => {
        const b = realFrom(t)
        if (t === "contacts") {
          const ins = b.insert
          b.insert = (p: unknown) => {
            if (!injected) { injected = true; db.tables.contacts.push({ id: "c0000000-0000-4000-8000-000000000009", full_name: "Anna Bianchi", email: "anna@example.com", email_2: null, alt_emails: [], merged_into: null, created_at: "2026-11-14" }) }
            return ins(p)
          }
        }
        return b
      },
    }
    const r = await findOrCreateBookingContact(racing as never, { name: "Anna Bianchi", email: "anna@example.com" }, NOW)
    expect(r).toEqual({ ok: true, contactId: "c0000000-0000-4000-8000-000000000009", created: false, fullName: "Anna Bianchi" })
    expect(db.tables.contacts.filter((c) => c.email === "anna@example.com")).toHaveLength(1)
  })
  it("with no unique rule on email, two simultaneous inserts converge: the OLDER record wins and the newer one is removed", async () => {
    const db = miniDb(seed())
    const realFrom = db.from.bind(db) as (t: string) => Record<string, (...a: unknown[]) => unknown>
    let injected = false
    const racing = {
      ...db,
      from: (t: string) => {
        const b = realFrom(t)
        if (t === "contacts") {
          const ins = b.insert
          b.insert = (p: unknown) => {
            if (!injected) { injected = true; db.tables.contacts.push({ id: "c0000000-0000-4000-8000-000000000008", full_name: "Anna Bianchi", email: "anna@example.com", email_2: null, alt_emails: [], merged_into: null, created_at: "2026-01-01T00:00:00.000Z" }) }
            return ins(p)
          }
        }
        return b
      },
    }
    const r = await findOrCreateBookingContact(racing as never, { name: "Anna Bianchi", email: "anna@example.com" }, NOW)
    expect(r).toMatchObject({ ok: true, contactId: "c0000000-0000-4000-8000-000000000008", created: false })
    expect(db.tables.contacts.filter((c) => c.email === "anna@example.com")).toHaveLength(1)
  })
  it("removeJustCreatedBookingContact deletes only the id it is given", async () => {
    const db = miniDb(seed())
    const r = await findOrCreateBookingContact(db, { name: "Anna Bianchi", email: "anna@example.com" }, NOW)
    expect(r.ok && (await removeJustCreatedBookingContact(db, r.contactId))).toBe(true)
    expect(db.tables.contacts).toHaveLength(3)
    expect(await removeJustCreatedBookingContact(miniDb(seed(), { failing: { contacts: "x" } }), C1)).toBe(false)
  })
})

describe("loadPerson — People (new_contact)", () => {
  it("a person who is not a contact: state contact, nothing created yet, the plan to create them", async () => {
    const db = miniDb(seed())
    const r = await loadPerson(db, { type: "new_contact", name: "Anna Bianchi", email: "Anna@Example.com" })
    expect(r).toMatchObject({ ok: true, person: { state: "contact", established: false, contactId: null, leadId: null, accountId: null, name: "Anna Bianchi", emails: ["anna@example.com"], people: { mode: "create", name: "Anna Bianchi", email: "anna@example.com" } } })
    expect(db.log.filter((l) => l.op !== "select")).toHaveLength(0)
  })
  it("a person who already is a contact (any email): their record is used, flagged existing", async () => {
    const r = await loadPerson(miniDb(seed()), { type: "new_contact", name: "Typo Name", email: "giulia2@example.com" })
    expect(r).toMatchObject({ ok: true, person: { state: "contact", contactId: C1, name: "Giulia Verdi", people: { mode: "existing" } } })
    expect(r.ok && r.person.emails).toEqual(["giulia@example.com", "giulia2@example.com", "g.verdi@example.org"])
  })
  it("an open lead's email is refused: pick the lead, do not make a second record", async () => {
    const r = await loadPerson(miniDb(seed()), { type: "new_contact", name: "Daniel Green", email: "daniel@example.com" })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already belongs to a lead \(Daniel Green\).*Someone in the system/) })
  })
  it("a missing or wrong name / email is refused in plain words", async () => {
    expect(await loadPerson(miniDb(seed()), { type: "new_contact", name: "", email: "a@b.com" })).toMatchObject({ ok: false })
    expect(await loadPerson(miniDb(seed()), { type: "new_contact", name: "Anna", email: null })).toMatchObject({ ok: false })
    expect(await loadPerson(miniDb(seed()), { type: "new_contact" })).toMatchObject({ ok: false })
  })
  it("a read failure is an error, not a 'nobody found'", async () => {
    expect(await loadPerson(miniDb(seed(), { failing: { contacts: "x" } }), { type: "new_contact", name: "Anna Bianchi", email: "a@b.com" })).toMatchObject({ ok: false })
    expect(await loadPerson(miniDb(seed(), { failing: { leads: "x" } }), { type: "new_contact", name: "Anna Bianchi", email: "a@b.com" })).toMatchObject({ ok: false })
  })
})

describe("judgeLink — Client is not for someone new; People is just a contact", () => {
  it("someone new + Client (or People) is refused on the server, in plain words", async () => {
    for (const kindSlug of ["client", "people"]) {
      const r = await judgeLink(miniDb(seed()), { person: { type: "new", name: "Sofia", email: "sofia@example.com" }, kindSlug, minutes: 30 })
      expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/only for people already in the system.*Someone in the system/)] })
    }
  })
  it("someone new + Lead / Partner / Private still works as before", async () => {
    for (const kindSlug of ["lead", "partner", "private"]) {
      expect(await judgeLink(miniDb(seed()), { person: { type: "new", name: "Sofia", email: "sofia@example.com" }, kindSlug, minutes: 30 })).toMatchObject({ ok: true })
    }
  })
  it("a PICKED contact can still be given Client (the rule is about someone NEW)", async () => {
    expect(await judgeLink(miniDb(seed()), { person: { type: "contact", id: C3 }, kindSlug: "client", minutes: 30 })).toMatchObject({ ok: true })
  })
  it("a kind with no for_new_person key (an old row, a kind added later) is offered for someone new", async () => {
    const r = await judgeLink(miniDb(seed({ catalog_entries: [{ id: "k-v", catalog_id: "booking_kinds", slug: "vendor", display_name: "Vendor", status: "active", metadata: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false } }] })), { person: { type: "new" }, kindSlug: "vendor", minutes: 30 })
    expect(r).toMatchObject({ ok: true })
  })
  it("People + the People kind: saved on the contact, no lead — and the preview says a contact is made, without making it", async () => {
    const db = miniDb(seed())
    const r = await judgeLink(db, { person: { type: "new_contact", name: "Anna Bianchi", email: "anna@example.com" }, kindSlug: "people", minutes: 30 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.judged.plan.recorder).toBe("attach")
    expect(r.judged.plan.template).toBe("plain")
    const text = r.judged.lines.map((l) => `${l.label}: ${l.text}`).join("\n")
    expect(text).toMatch(/Contact: Anna Bianchi is saved as a new contact when you make the link: name and email only, no lead and no company\./)
    expect(text).toMatch(/Page: The call is saved on Anna Bianchi's contact page, under Calls\./)
    expect(text).toMatch(/Record: No lead is created/)
    expect(db.log.filter((l) => l.op !== "select")).toHaveLength(0)
    expect(db.tables.contacts).toHaveLength(3)
  })
  it("People for someone who already is a contact says nothing new is created", async () => {
    const r = await judgeLink(miniDb(seed()), { person: { type: "new_contact", name: "Giulia", email: "giulia@example.com" }, kindSlug: "people", minutes: 30 })
    expect(r.ok && r.judged.lines.find((l) => l.label === "Contact")?.text).toBe("Giulia Verdi is already a contact, so nothing new is created.")
  })
  it("People + a kind that makes a lead (Lead) is refused: it would contradict 'just a contact'", async () => {
    const r = await judgeLink(miniDb(seed()), { person: { type: "new_contact", name: "Anna Bianchi", email: "anna@example.com" }, kindSlug: "lead", minutes: 30 })
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/makes a lead.*People is just a contact/)] })
  })
  it("People + Private / Partner / Client are allowed (they save on the contact or nothing; none makes a lead)", async () => {
    for (const kindSlug of ["private", "partner", "client"]) {
      expect(await judgeLink(miniDb(seed()), { person: { type: "new_contact", name: "Anna Bianchi", email: "anna@example.com" }, kindSlug, minutes: 30 })).toMatchObject({ ok: true })
    }
  })
})

describe("makeFreeLink — People", () => {
  const input = { person: { type: "new_contact" as const, name: "Anna Bianchi", email: "anna@example.com" }, kindSlug: "people", minutes: 30 }

  it("makes the contact AND the link on it; no lead, no company; the call will be saved under the contact", async () => {
    const db = miniDb(seed())
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "antonio@example.com", baseUrl: "https://app.example.com" }, input)
    expect(r.ok).toBe(true)
    const contact = db.tables.contacts.find((c) => c.email === "anna@example.com") as Record<string, unknown>
    expect(contact).toMatchObject({ full_name: "Anna Bianchi", first_name: "Anna", last_name: "Bianchi" })
    expect(db.tables.booking_links[0]).toMatchObject({ kind_label: "People", contact_id: contact.id, account_id: null, lead_id: null, person_name: "Anna Bianchi", person_emails: ["anna@example.com"], once: false, status: "open" })
    expect((db.tables.booking_links[0].rule_snapshot as { rule: { existing_person: string } }).rule.existing_person).toBe("attach")
    expect(db.tables.leads).toHaveLength(1)
    expect(db.tables.account_contacts).toHaveLength(1)
  })
  it("a person who already is a contact: the link is made on THEIR record, nothing new is created, and nothing is deleted later", async () => {
    const db = miniDb(seed())
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, { ...input, person: { type: "new_contact", name: "Someone Else", email: "giulia@example.com" } })
    expect(r.ok).toBe(true)
    expect(db.tables.contacts).toHaveLength(3)
    expect(db.tables.booking_links[0]).toMatchObject({ contact_id: C1, person_name: "Giulia Verdi" })
  })
  it("a refused link leaves NO contact behind (kind refused, bad length, lead email, Lead kind)", async () => {
    const cases: Array<Record<string, unknown>> = [{ kindSlug: "nope" }, { minutes: 0 }, { person: { type: "new_contact", name: "Daniel Green", email: "daniel@example.com" } }, { kindSlug: "lead" }]
    for (const over of cases) {
      const db = miniDb(seed())
      const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, { ...input, ...over } as never)
      expect(r.ok).toBe(false)
      expect(db.tables.contacts).toHaveLength(3)
      expect(db.tables.booking_links).toHaveLength(0)
    }
  })
  it("Calendly failing on a one-time length leaves no contact behind (the contact is made after Calendly)", async () => {
    const db = miniDb(seed())
    const ctx: CalendlyCtx = { token: "t", http: async () => { throw new CalendlyError("network", null, "down") } }
    const r = await makeFreeLink({ db, calendly: ctx, createdBy: "a" }, { ...input, minutes: 45 })
    expect(r.ok).toBe(false)
    expect(db.tables.contacts).toHaveLength(3)
  })
  it("a one-time length works for People too", async () => {
    const db = miniDb(seed())
    const r = await makeFreeLink({ db, calendly: calendly([shareOk]).ctx, createdBy: "a" }, { ...input, minutes: 45 })
    expect(r.ok).toBe(true)
    expect(db.tables.booking_links[0]).toMatchObject({ once: true, duration_minutes: 45, template_slug: "plain" })
  })
  it("if the link cannot be saved after the contact was made, THAT contact is removed again (an existing one never is)", async () => {
    const db = miniDb(seed(), { failOps: { "booking_links:insert": "boom" } })
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, input)
    expect(r).toMatchObject({ ok: false, errors: ["The link could not be saved. Try again."] })
    expect(db.tables.contacts).toHaveLength(3)

    const db2 = miniDb(seed(), { failOps: { "booking_links:insert": "boom" } })
    await makeFreeLink({ db: db2, calendly: calendly().ctx, createdBy: "a" }, { ...input, person: { type: "new_contact", name: "Someone Else", email: "giulia@example.com" } })
    expect(db2.tables.contacts).toHaveLength(3)
    expect(db2.tables.contacts.some((c) => c.id === C1)).toBe(true)
  })
  it("someone new + Client cannot make a link and writes nothing", async () => {
    const db = miniDb(seed())
    const r = await makeFreeLink({ db, calendly: calendly().ctx, createdBy: "a" }, { person: { type: "new", name: "Sofia", email: "sofia@example.com" }, kindSlug: "client", minutes: 30 })
    expect(r.ok).toBe(false)
    expect(db.tables.booking_links).toHaveLength(0)
  })
})

describe("the picker and the kinds list", () => {
  it("a bare contact is suggested People (no lead); a client stays Client; a lead stays Lead", async () => {
    const r = (await searchPeople(miniDb(seed()), "giulia")) as { ok: true; hits: Array<{ type: string; badge: string; suggestedKind: string }> }
    expect(r.hits[0]).toMatchObject({ type: "contact", badge: "Contact", suggestedKind: "people" })
    const c = (await searchPeople(miniDb(seed()), "maria")) as { ok: true; hits: Array<{ badge: string; suggestedKind: string }> }
    expect(c.hits[0]).toMatchObject({ badge: "Client", suggestedKind: "client" })
    const l = (await searchPeople(miniDb(seed()), "daniel")) as { ok: true; hits: Array<{ badge: string; suggestedKind: string }> }
    expect(l.hits[0]).toMatchObject({ badge: "Lead", suggestedKind: "lead" })
  })
  it("the kinds list tells the page which kinds are hidden for someone new", async () => {
    const r = await listKinds(miniDb(seed()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.fromEntries(r.kinds.map((k) => [k.slug, k.forNewPerson]))).toEqual({ lead: true, client: false, partner: true, private: true, people: false })
    expect(r.kinds.map((k) => k.slug)).toEqual(["lead", "client", "partner", "private", "people"])
  })
  it("the request body may name a People person", () => {
    expect(personRefFrom({ type: "new_contact", name: "Anna", email: "a@b.com" })).toEqual({ type: "new_contact", name: "Anna", email: "a@b.com" })
    expect(personRefFrom({ type: "new_contact", name: 5, email: null })).toEqual({ type: "new_contact", name: null, email: null })
    expect(personRefFrom({ type: "nobody" })).toBeNull()
  })
})

describe("migration 20261114-2100 (the People kind)", () => {
  const dir = path.join(process.cwd(), "scripts", "migrations")
  const sql = fs.readFileSync(path.join(dir, "20261114-2100-booking-people-kind.sql"), "utf8")
  const undo = fs.readFileSync(path.join(dir, "20261114-2100-booking-people-kind.UNDO.sql"), "utf8")
  const seedMeta = JSON.parse(/\('booking_kinds',\s*'people',[^\n]*?'(\{"existing_person[^']*\})'::jsonb\)/.exec(sql)?.[1] ?? "null")
  it("seeds People with a rule the maker and the webhook accept, saved on the contact, hidden for someone new", () => {
    expect(parseKindRule(seedMeta).ok).toBe(true)
    expect(seedMeta).toMatchObject({ existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, for_new_person: false })
    expect(kindOfferedToNewPerson(seedMeta)).toBe(false)
  })
  it("never overwrites a rename or a changed rule, and only fills the Client key when it is absent", () => {
    expect(sql).toMatch(/ON CONFLICT \(catalog_id, slug\) DO NOTHING/)
    expect(sql).toMatch(/slug = 'client' AND NOT \(metadata \? 'for_new_person'\)/)
  })
  it("changes catalog data only: no table, column, function or index", () => {
    expect(sql.replace(/--[^\n]*/g, "")).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i)
  })
  it("the UNDO removes People and gives Client back to someone new", () => {
    expect(undo).toMatch(/DELETE FROM public\.catalog_entries WHERE catalog_id = 'booking_kinds' AND slug = 'people'/)
    expect(undo).toMatch(/metadata - 'for_new_person'/)
  })
})
