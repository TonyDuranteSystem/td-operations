import { describe, it, expect, vi, beforeEach } from "vitest"
import { miniDb } from "./helpers/mini-db"

// The catalog framework writes through the real service client; here it is replaced by a small in-memory stand-in that keeps the same rules.
const fw = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: unknown[] }>, failNext: null as null | string }))
vi.mock("@/lib/catalog/framework", () => ({
  addEntry: async (catalogId: string, data: Record<string, unknown>, reason: string, actor: unknown) => {
    fw.calls.push({ fn: "addEntry", args: [catalogId, data, reason, actor] })
    if (fw.failNext) { const m = fw.failNext; fw.failNext = null; throw new Error(m) }
    return { id: `new-${data.slug}`, slug: data.slug, display_name: data.display_name, status: "active", metadata: data.metadata }
  },
  renameEntry: async (id: string, name: string, reason: string, actor: unknown) => {
    fw.calls.push({ fn: "renameEntry", args: [id, name, reason, actor] })
    return { id, slug: "x", display_name: name, status: "active", metadata: {} }
  },
  deprecateEntry: async (id: string, reason: string, actor: unknown) => {
    fw.calls.push({ fn: "deprecateEntry", args: [id, reason, actor] })
    return { id, slug: "x", display_name: "x", status: "deprecated", metadata: {} }
  },
  restoreEntry: async (id: string, reason: string, actor: unknown) => {
    fw.calls.push({ fn: "restoreEntry", args: [id, reason, actor] })
    return { id, slug: "x", display_name: "x", status: "active", metadata: {} }
  },
}))

import { addKind, changeKind, listKinds, slugFromName, ruleForChoice } from "@/lib/booking/kinds-admin"
import { parseKindRule } from "@/lib/booking/kinds"
import { describeCheck, loadOpenChecks, answerCheck, ANSWERS_BY_KIND, type CheckRow } from "@/lib/booking/checks"

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true, sort_order: 10 },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20 },
}
const kindRows = () => [
  { id: "k1", catalog_id: "booking_kinds", slug: "lead", display_name: "Lead", status: "active", metadata: META.lead },
  { id: "k2", catalog_id: "booking_kinds", slug: "client", display_name: "Client", status: "active", metadata: META.client },
  { id: "k3", catalog_id: "booking_kinds", slug: "vendor", display_name: "Vendor", status: "deprecated", metadata: META.client },
  { id: "k4", catalog_id: "booking_kinds", slug: "bare", display_name: "Bare", status: "active", metadata: {} },
]

beforeEach(() => { fw.calls.length = 0; fw.failNext = null })

describe("kinds: add / rename / retire / restore", () => {
  it("lists active and retired kinds in order, and marks a kind with no rule as not ready", async () => {
    const r = await listKinds(miniDb({ catalog_entries: kindRows() }))
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) return
    expect(r.kinds.map((k) => [k.slug, k.status, k.ready])).toEqual([["lead", "active", true], ["client", "active", true], ["vendor", "retired", true], ["bare", "active", false]])
  })
  it("adds a kind with the rule of the choice drawn on the page", async () => {
    const db = miniDb({ catalog_entries: kindRows() })
    const rec = await addKind(db, { name: "  Pixel   Print ", choice: "record" }, "u1")
    expect(rec).toMatchObject({ ok: true, kind: { slug: "pixel-print", name: "Pixel Print", status: "active", ready: true } })
    const data = fw.calls[0].args[1] as { slug: string; metadata: Record<string, unknown> }
    expect(data.metadata).toMatchObject({ existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false })
    expect(parseKindRule(data.metadata).ok).toBe(true)
    expect(fw.calls[0].args[3]).toEqual({ kind: "admin_api", userId: "u1" })
    await addKind(db, { name: "Calendar only", choice: "none" }, null)
    expect((fw.calls[1].args[1] as { metadata: unknown }).metadata).toMatchObject({ existing_person: "none", new_person: "none" })
    expect(parseKindRule(ruleForChoice("none", 50)).ok).toBe(true)
  })
  it("refuses a name that is the same ignoring capitals, accents and spaces — retired kinds count", async () => {
    const db = miniDb({ catalog_entries: kindRows() })
    for (const name of ["client", "CLIENT", "  Cliënt ", "Vendor", "vén dor".replace(" ", "")]) {
      const r = await addKind(db, { name, choice: "record" }, null)
      expect(r).toMatchObject({ ok: false, status: 409 })
    }
    expect(fw.calls).toHaveLength(0)
  })
  it("refuses an empty name, a name of only symbols, an unknown choice", async () => {
    const db = miniDb({ catalog_entries: kindRows() })
    expect(await addKind(db, { name: "   ", choice: "record" }, null)).toMatchObject({ ok: false, status: 400 })
    expect(await addKind(db, { name: "!!!", choice: "record" }, null)).toMatchObject({ ok: false, status: 400 })
    expect(await addKind(db, { name: "Fine", choice: "mystery" }, null)).toMatchObject({ ok: false, status: 400 })
    expect(slugFromName("Cliënt  & Co.")).toBe("client-co")
    expect(fw.calls).toHaveLength(0)
  })
  it("a clash caught by the database (two people at once) is a name-taken answer, other failures are a plain error", async () => {
    const db = miniDb({ catalog_entries: kindRows() })
    fw.failNext = 'duplicate key value violates unique constraint "uq_catalog_entries_booking_kind_name"'
    expect(await addKind(db, { name: "Vendor Two", choice: "record" }, null)).toMatchObject({ ok: false, status: 409 })
    fw.failNext = "connection reset"
    expect(await addKind(db, { name: "Vendor Three", choice: "record" }, null)).toMatchObject({ ok: false, status: 500 })
  })
  it("renames (a change of capitals on its own name is fine), retires, restores", async () => {
    const db = miniDb({ catalog_entries: kindRows() })
    expect(await changeKind(db, "client", { rename: "Customer" }, "u1")).toMatchObject({ ok: true })
    expect(fw.calls[0].fn).toBe("renameEntry")
    expect(fw.calls[0].args.slice(0, 2)).toEqual(["k2", "Customer"])
    expect(await changeKind(db, "client", { rename: "CLIENT" }, "u1")).toMatchObject({ ok: true })
    expect(await changeKind(db, "client", { rename: "lead" }, "u1")).toMatchObject({ ok: false, status: 409 })
    expect(await changeKind(db, "client", { rename: "Vendor" }, "u1")).toMatchObject({ ok: false, status: 409 })
    expect(await changeKind(db, "client", { status: "retired" }, "u1")).toMatchObject({ ok: true })
    expect(fw.calls.at(-1)!.fn).toBe("deprecateEntry")
    expect(fw.calls.at(-1)!.args[0]).toBe("k2")
    expect(await changeKind(db, "vendor", { status: "active" }, "u1")).toMatchObject({ ok: true })
    expect(fw.calls.at(-1)!.fn).toBe("restoreEntry")
    expect(fw.calls.at(-1)!.args[0]).toBe("k3")
    expect(await changeKind(db, "nope", { status: "retired" }, "u1")).toMatchObject({ ok: false, status: 404 })
    expect(await changeKind(db, "client", { status: "weird" }, "u1")).toMatchObject({ ok: false, status: 400 })
  })
  it("a read failure is a plain error", async () => {
    expect(await listKinds(miniDb({}, { failing: { catalog_entries: "x" } }))).toMatchObject({ ok: false })
    expect(await addKind(miniDb({}, { failing: { catalog_entries: "x" } }), { name: "A", choice: "record" }, null)).toMatchObject({ ok: false, status: 500 })
  })
})

// ─── Calls to check ───────────────────────────────────────────────────────

const NOW = new Date("2026-11-14T12:00:00.000Z")
const CONTACT = "c0000000-0000-4000-8000-000000000001"
const LINK = "b0000000-0000-4000-8000-000000000001"
const LEAD = "10000000-0000-4000-8000-000000000001"
const CARD = "d0000000-0000-4000-8000-000000000001"
const EVENT = "https://api.calendly.com/scheduled_events/11111111-2222-3333-4444-555555555555"
const INVITEE = `${EVENT}/invitees/99999999-2222-3333-4444-555555555555`

const card = (over: Partial<CheckRow> = {}): CheckRow & Record<string, unknown> => ({
  id: CARD, kind: "mismatch", dedupe_key: INVITEE, status: "open", booking_link_id: LINK, lead_id: null, contact_id: CONTACT, calendly_event_uri: EVENT,
  payload: { booker_email: "carlo.new@example.com", booker_name: "Carlo Neri", kind_label: "Client", person_name: "Carlo Ferri" }, created_at: "2026-11-13T10:00:00Z", updated_at: "2026-11-13T10:00:00Z", ...over,
})
const link = (over: Record<string, unknown> = {}) => ({
  id: LINK, contact_id: CONTACT, account_id: "a0000000-0000-4000-8000-000000000001", person_name: "Carlo Ferri", person_emails: ["carlo@example.com"], kind_label: "Client",
  status: "open", once: true, revoked_at: null, claimed_invitee_uri: null, claimed_event_uri: null, claimed_email: null, effects_done_at: null, ...over,
})
const world = (over: Record<string, Array<Record<string, unknown>>> = {}) => ({
  call_checks: [card()],
  booking_links: [link()],
  contacts: [{ id: CONTACT, full_name: "Carlo Ferri", email: "carlo@example.com", email_2: null, alt_emails: [], merged_into: null }],
  leads: [{ id: LEAD, email: "carlo.new@example.com", existing_client_contact_id: null, updated_at: "2026-11-13T10:00:00Z", created_at: "2026-11-13T10:00:00Z" }],
  lead_calls: [{ lead_id: LEAD, calendly_event_uri: EVENT, scheduled_start: "2026-11-20T15:00:00Z", booked_at: "2026-11-13T10:00:00Z" }],
  contact_calls: [],
  ...over,
})
const OPTS = { unique: { contact_calls: [["calendly_event_uri"]], booking_links: [["claimed_invitee_uri"]], call_checks: [["kind", "dedupe_key"]] } }
const aliasOk = () => { const calls: Array<[string, string]> = []; return { calls, fn: async (c: string, e: string) => { calls.push([c, e]); return { ok: true } } } }

describe("describeCheck: the cards in plain words", () => {
  it("mismatch with a contact: the three answers Antonio asked for", () => {
    const d = describeCheck(card(), link() as never, null)!
    expect(d.question).toBe("A different person booked Carlo Ferri's client link. Is it still Carlo's call?")
    expect(d.why).toBe("The link was made for Carlo Ferri. The booking came from Carlo Neri (carlo.new@example.com). It was saved as a normal lead, nothing was dropped.")
    expect(d.answers.map((a) => a.label)).toEqual(["Same person: link this email", "Different person", "Dismiss"])
    expect(d.answers[0].primary).toBe(true)
    expect(d.note).toBeNull()
  })
  it("mismatch for a lead-only link: no 'Same person', and the card says why in plain words", () => {
    const d = describeCheck(card({ contact_id: null }), link({ contact_id: null }) as never, null)!
    expect(d.answers.map((a) => a.label)).toEqual(["Different person", "Dismiss"])
    expect(d.note).toMatch(/a lead keeps only one email/)
  })
  it("shows the person's name from the payload, never an id", () => {
    const cards = [describeCheck(card(), link() as never, null)!, describeCheck(card({ kind: "unknown_id", payload: { booker_email: "x@y.com", reason: "used", person_name: "Carlo Ferri", kind_label: "Client" } }), link() as never, null)!]
    for (const c of cards) expect(`${c.question} ${c.why} ${c.note ?? ""}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
  it("unknown id: one plain sentence per reason; effect failed: says nothing was dropped", () => {
    expect(describeCheck(card({ kind: "unknown_id", booking_link_id: null, payload: { booker_email: "x@y.com", reason: "not_found" } }), null, null)!.question).toBe("A booking came through a link code we do not know.")
    expect(describeCheck(card({ kind: "unknown_id", payload: { booker_email: "x@y.com", reason: "used" } }), link() as never, null)!.question).toBe("A booking came through a link that had already been used.")
    expect(describeCheck(card({ kind: "unknown_id", payload: { reason: "revoked" } }), null, null)!.question).toMatch(/stopped/)
    const e = describeCheck(card({ kind: "effect_failed", payload: { booker_email: "x@y.com", reason: "The link's rule could not be read." } }), null, null)!
    expect(e.why).toBe("The link's rule could not be read.")
    expect(e.note).toMatch(/Nothing was dropped/)
    expect(e.answers.map((a) => a.key)).toEqual(["dismiss"])
  })
  it("a paid-call card (a later stage) is not shown", () => {
    expect(describeCheck(card({ kind: "unpaid_call" }), null, null)).toBeNull()
  })
  it("never uses vendor jargon", () => {
    const text = JSON.stringify(describeCheck(card(), link() as never, null)) + JSON.stringify(describeCheck(card({ kind: "unknown_id", payload: { reason: "not_found" } }), null, null))
    expect(text).not.toMatch(/utm|snapshot|slug|invitee|event type|webhook/i)
  })
})

describe("loadOpenChecks", () => {
  it("lists open cards newest first with the call time, hides answered ones, a card being answered right now, and kinds of a later stage", async () => {
    const db = miniDb(world({
      call_checks: [
        card(),
        card({ id: "d0000000-0000-4000-8000-000000000002", kind: "unknown_id", dedupe_key: "k2", booking_link_id: null, calendly_event_uri: null, payload: { reason: "not_found", booker_email: "z@z.com" }, created_at: "2026-11-14T08:00:00Z" }),
        card({ id: "d0000000-0000-4000-8000-000000000003", status: "answered" }),
        card({ id: "d0000000-0000-4000-8000-000000000004", status: "answering", updated_at: "2026-11-14T11:59:00Z", dedupe_key: "k4" }),
        card({ id: "d0000000-0000-4000-8000-000000000005", kind: "unpaid_call", dedupe_key: "k5" }),
      ],
    }))
    const r = await loadOpenChecks(db, NOW)
    expect(r).toMatchObject({ ok: true, count: 2 })
    if (r.ok) {
      expect(r.cards.map((c) => c.id)).toEqual(["d0000000-0000-4000-8000-000000000002", CARD])
      expect(r.cards[1].callAt).toBe("2026-11-20T15:00:00Z")
    }
  })
  it("a card stuck 'answering' for more than a few minutes comes back", async () => {
    const db = miniDb(world({ call_checks: [card({ status: "answering", updated_at: "2026-11-14T11:00:00Z" })] }))
    expect(await loadOpenChecks(db, NOW)).toMatchObject({ ok: true, count: 1 })
  })
  it("a missing table is zero cards; a failing read is an error (never 'nothing needs you')", async () => {
    expect(await loadOpenChecks(miniDb({}, { missing: ["call_checks"] }), NOW)).toEqual({ ok: true, cards: [], count: 0 })
    expect(await loadOpenChecks(miniDb({}, { failing: { call_checks: "x" } }), NOW)).toMatchObject({ ok: false })
  })
  it("a failed read of the links or the call log still shows the cards", async () => {
    const db = miniDb(world(), { failing: { booking_links: "x", lead_calls: "x" } })
    const r = await loadOpenChecks(db, NOW)
    expect(r).toMatchObject({ ok: true, count: 1 })
  })
})

describe("answering a card", () => {
  it("the allowed answers per kind", () => {
    expect(ANSWERS_BY_KIND.mismatch).toEqual(["same_person", "different_person", "dismiss"])
    expect(ANSWERS_BY_KIND.unknown_id).toEqual(["dismiss"])
    expect(ANSWERS_BY_KIND.effect_failed).toEqual(["dismiss"])
  })
  it("SAME PERSON: the email joins the contact, the stray lead is tagged, the call is saved under the contact, the link is closed, the card is answered", async () => {
    const db = miniDb(world(), OPTS)
    const alias = aliasOk()
    const r = await answerCheck({ db, now: NOW, by: "antonio@example.com", addAlias: alias.fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.message).toMatch(/carlo\.new@example\.com now belongs to Carlo Ferri/)
    expect(alias.calls).toEqual([[CONTACT, "carlo.new@example.com"]])
    expect(db.tables.leads[0].existing_client_contact_id).toBe(CONTACT)
    expect(db.tables.contact_calls).toHaveLength(1)
    expect(db.tables.contact_calls[0]).toMatchObject({ contact_id: CONTACT, booking_link_id: LINK, calendly_event_uri: EVENT, scheduled_start: "2026-11-20T15:00:00Z", state: "scheduled" })
    expect(db.tables.booking_links[0]).toMatchObject({ status: "claimed", claimed_invitee_uri: INVITEE, claimed_email: "carlo.new@example.com" })
    expect(db.tables.booking_links[0].effects_done_at).toBe(NOW.toISOString())
    expect(db.tables.call_checks[0]).toMatchObject({ status: "answered", answer: "same_person", answered_by: "antonio@example.com" })
  })
  it("repeating the answer on a card already answered changes nothing", async () => {
    const db = miniDb(world(), OPTS)
    const alias = aliasOk()
    await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person")
    const again = await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person")
    expect(again).toEqual({ ok: true, message: "This card was already answered." })
    expect(alias.calls).toHaveLength(1)
    expect(db.tables.contact_calls).toHaveLength(1)
  })
  it("a half-finished answer can be pressed again: every step is safe to repeat", async () => {
    const db = miniDb(world({ contacts: [{ id: CONTACT, full_name: "Carlo Ferri", email: "carlo@example.com", email_2: null, alt_emails: ["carlo.new@example.com"], merged_into: null }], leads: [{ id: LEAD, email: "carlo.new@example.com", existing_client_contact_id: CONTACT, updated_at: "2026-11-13T10:00:00Z", created_at: "x" }], contact_calls: [{ contact_id: CONTACT, calendly_event_uri: EVENT, state: "scheduled" }] }), OPTS)
    const alias = aliasOk()
    expect(await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person")).toMatchObject({ ok: true })
    expect(alias.calls).toHaveLength(0)
    expect(db.tables.contact_calls).toHaveLength(1)
  })
  it("a failure puts the card back to open with the reason, and nothing later happens", async () => {
    const db = miniDb(world(), OPTS)
    const bad = async () => ({ ok: false, error: "write failed" })
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: bad }, CARD, "same_person")
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(db.tables.call_checks[0].status).toBe("open")
    expect(db.tables.contact_calls).toHaveLength(0)
    expect(db.tables.booking_links[0].status).toBe("open")
  })
  it("a call that cannot be saved under the contact: card back to open", async () => {
    const db = miniDb(world(), { ...OPTS, failOps: { "contact_calls:insert": "boom" } })
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: aliasOk().fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: false })
    expect(db.tables.call_checks[0].status).toBe("open")
    expect(db.tables.booking_links[0].status).toBe("open")
  })
  it("a lead-only link cannot be 'same person' (a lead has no place for a second email); the card stays open", async () => {
    const db = miniDb(world({ booking_links: [link({ contact_id: null })], call_checks: [card({ contact_id: null })] }), OPTS)
    const alias = aliasOk()
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: false, status: 422 })
    if ("error" in r) expect(r.error).toMatch(/a lead keeps only one email/)
    expect(alias.calls).toHaveLength(0)
    expect(db.tables.call_checks[0].status).toBe("open")
  })
  it("a stray lead already linked to a DIFFERENT client is not overwritten", async () => {
    const db = miniDb(world({ leads: [{ id: LEAD, email: "x", existing_client_contact_id: "c0000000-0000-4000-8000-0000000000ff", updated_at: "u", created_at: "c" }] }), OPTS)
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: aliasOk().fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(db.tables.leads[0].existing_client_contact_id).toBe("c0000000-0000-4000-8000-0000000000ff")
    expect(db.tables.call_checks[0].status).toBe("open")
  })
  it("a reusable link stays open (it never claims); the call is still saved", async () => {
    const db = miniDb(world({ booking_links: [link({ once: false })] }), OPTS)
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: aliasOk().fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: true })
    expect(db.tables.booking_links[0].status).toBe("open")
    expect(db.tables.contact_calls).toHaveLength(1)
  })
  it("a link that was already closed by someone else is not an error", async () => {
    const db = miniDb(world({ booking_links: [link({ status: "claimed" })] }), OPTS)
    const r = await answerCheck({ db, now: NOW, by: "a", addAlias: aliasOk().fn }, CARD, "same_person")
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.message).toMatch(/already been closed/)
  })
  it("DIFFERENT PERSON and DISMISS change nothing but the card", async () => {
    for (const answer of ["different_person", "dismiss"]) {
      const db = miniDb(world(), OPTS)
      const alias = aliasOk()
      expect(await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, answer)).toMatchObject({ ok: true })
      expect(alias.calls).toHaveLength(0)
      expect(db.tables.contact_calls).toHaveLength(0)
      expect(db.tables.booking_links[0].status).toBe("open")
      expect(db.tables.leads[0].existing_client_contact_id).toBeNull()
      expect(db.tables.call_checks[0]).toMatchObject({ status: "answered", answer })
    }
  })
  it("validates the answer against the card's own kind, the card id, and a card that is not there", async () => {
    const db = miniDb(world({ call_checks: [card({ kind: "unknown_id" })] }), OPTS)
    expect(await answerCheck({ db, by: "a" }, CARD, "same_person")).toMatchObject({ ok: false, status: 400 })
    expect(await answerCheck({ db, by: "a" }, CARD, undefined)).toMatchObject({ ok: false, status: 400 })
    expect(await answerCheck({ db, by: "a" }, CARD, { x: 1 })).toMatchObject({ ok: false, status: 400 })
    expect(await answerCheck({ db, by: "a" }, "not-an-id", "dismiss")).toMatchObject({ ok: false, status: 404 })
    expect(await answerCheck({ db, by: "a" }, "d0000000-0000-4000-8000-0000000000ee", "dismiss")).toMatchObject({ ok: false, status: 404 })
    expect(await answerCheck({ db: miniDb(world({ call_checks: [card({ kind: "unpaid_call" })] })), by: "a" }, CARD, "dismiss")).toMatchObject({ ok: false, status: 400 })
    expect(db.tables.call_checks[0].status).toBe("open")
  })
  it("claim first: a card another click is already answering is refused, and nothing is done twice", async () => {
    const db = miniDb(world({ call_checks: [card({ status: "answering", updated_at: NOW.toISOString() })] }), OPTS)
    const alias = aliasOk()
    expect(await answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person")).toMatchObject({ ok: false, status: 409 })
    expect(alias.calls).toHaveLength(0)
  })
  it("two answers at the same moment: exactly one acts", async () => {
    const db = miniDb(world(), OPTS)
    const alias = aliasOk()
    const [a, b] = await Promise.all([
      answerCheck({ db, now: NOW, by: "a", addAlias: alias.fn }, CARD, "same_person"),
      answerCheck({ db, now: NOW, by: "b", addAlias: alias.fn }, CARD, "same_person"),
    ])
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1)
    expect(alias.calls.length).toBeLessThanOrEqual(1)
    expect(db.tables.contact_calls).toHaveLength(1)
  })
  it("a card whose read fails is a plain error", async () => {
    expect(await answerCheck({ db: miniDb({}, { failing: { call_checks: "x" } }), by: "a" }, CARD, "dismiss")).toMatchObject({ ok: false, status: 500 })
  })
})
