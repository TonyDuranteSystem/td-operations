/**
 * REAL RUN against the SANDBOX database (Booking page, Stage 1b). Skipped unless BOOKING_SANDBOX_RUN=1 — `npm run test:unit` and CI never touch a database.
 *
 * The in-memory tests prove the logic; this proves what only a real Postgres + PostgREST can: the people search filters, the link maker's insert, the list and the
 * stop-a-link update, the public redirect's lookup and visit count, the kinds written through the catalog framework (with its decision log), and the whole
 * "Same person: link this email" answer (alternate email, lead tag, call under the contact, the link claimed, the card answered).
 * It calls the REAL route handlers with the login mocked as an admin and the REAL supabase-js client from .env.local, on test people carrying a unique ZZ prefix,
 * then removes every row it made. Refuses to run unless the database is the sandbox. No Calendly call is made (a 30-minute link needs none).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { NextRequest } from "next/server"
import dotenv from "dotenv"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const RUN = process.env.BOOKING_SANDBOX_RUN === "1"
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const PROD_REF = "ydzipybqeebtpcvsbtvs"

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "zz-admin@example.invalid", app_metadata: { role: "admin" } } } }) } }),
}))

if (RUN) dotenv.config({ path: ".env.local" })

const STAMP = `${Date.now()}`
const HOST = "app.example.com"
const req = (method: string, url: string, body?: unknown) =>
  new NextRequest(`https://${HOST}${url}`, {
    method,
    headers: { host: HOST, ...(body !== undefined ? { "content-type": "application/json", origin: `https://${HOST}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> }) // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!RUN)("booking page — REAL run against the sandbox database", () => {
  let db: SupabaseClient
  const mine = { contacts: [] as string[], leads: [] as string[], links: [] as string[], cards: [] as string[], kindSlugs: [] as string[], leadCalls: [] as string[], settings: [] as string[] }
  const email = (k: string) => `zz-b1b-${STAMP}-${k}@example.invalid`
  const EVENT = `https://api.calendly.com/scheduled_events/aaaaaaaa-0000-4000-8000-${STAMP.padStart(12, "0").slice(-12)}`
  const ctx = (id = "x", slug = "x") => ({ params: Promise.resolve({ id, slug }) })

  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
    if (!url.includes(SANDBOX_REF) || url.includes(PROD_REF)) throw new Error("REFUSING to run: the database is not the sandbox")
    db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } })
    // the call types the maker needs (only if the sandbox has none)
    const { data } = await db.from("app_settings").select("key").in("key", ["booking_templates"])
    if (!data?.length) {
      const { error } = await db.from("app_settings").insert({ key: "booking_templates", value: { plain: { event_type_uri: "https://api.calendly.com/event_types/11111111-aaaa-4bbb-8ccc-000000000001", scheduling_url: "https://calendly.com/zz-test/new-meeting" }, sales: { event_type_uri: "https://api.calendly.com/event_types/11111111-aaaa-4bbb-8ccc-000000000002", scheduling_url: "https://calendly.com/zz-test/free-meet" } } })
      if (error) throw error
      mine.settings.push("booking_templates")
    }
    const { data: mode } = await db.from("app_settings").select("key").eq("key", "booking")
    if (!mode?.length) {
      const { error } = await db.from("app_settings").insert({ key: "booking", value: { mode: "page" } })
      if (error) throw error
      mine.settings.push("booking")
    }
  })

  afterAll(async () => {
    if (!db) return
    /* eslint-disable no-restricted-syntax -- cleanup of test rows seeded into the SANDBOX only */
    if (mine.cards.length) await db.from("call_checks").delete().in("id", mine.cards)
    if (mine.links.length) { await db.from("contact_calls").delete().in("booking_link_id", mine.links); await db.from("booking_links").delete().in("id", mine.links) }
    if (mine.contacts.length) await db.from("contact_calls").delete().in("contact_id", mine.contacts)
    if (mine.leadCalls.length) await db.from("lead_calls").delete().in("id", mine.leadCalls)
    if (mine.leads.length) await db.from("leads").delete().in("id", mine.leads)
    if (mine.contacts.length) await db.from("contacts").delete().in("id", mine.contacts)
    for (const slug of mine.kindSlugs) {
      const { data } = await db.from("catalog_entries").select("id").eq("catalog_id", "booking_kinds").eq("slug", slug)
      for (const e of data ?? []) { await db.from("catalog_decision_log").delete().eq("catalog_entry_id", e.id); await db.from("catalog_entries").delete().eq("id", e.id) }
    }
    for (const key of mine.settings) await db.from("app_settings").delete().eq("key", key)
    /* eslint-enable no-restricted-syntax */
  })

  it("the whole page: search → make a link → list → open it → stop it", async () => {
    // eslint-disable-next-line no-restricted-syntax -- a test person seeded straight into the SANDBOX
    const { data: c, error } = await db.from("contacts").insert({ full_name: `ZZ Booking Proof ${STAMP}`, email: email("c1"), email_2: email("c1b"), is_test: true, language: "Italian" }).select("id").single()
    if (error) throw error
    mine.contacts.push(c!.id)

    const { POST: makeLink, GET: listLinks } = await import("../../app/api/booking/links/route")
    const { GET: people } = await import("../../app/api/booking/people/route")
    const { POST: preview } = await import("../../app/api/booking/preview/route")
    const { POST: revoke } = await import("../../app/api/booking/links/[id]/revoke/route")
    const { decideRedirect } = await import("@/lib/booking/redirect")
    const { supabaseAdmin } = await import("@/lib/supabase-admin")

    // the picker finds the person by name and by email
    const byName = await json(await people(req("GET", `/api/booking/people?q=${encodeURIComponent(`ZZ Booking Proof ${STAMP}`)}`)))
    expect(byName.body.hits.map((h: { id: string }) => h.id)).toContain(c!.id)
    const byEmail = await json(await people(req("GET", `/api/booking/people?q=${encodeURIComponent(email("c1").slice(0, 24))}`)))
    expect(byEmail.status).toBe(200)

    // the preview says what will happen; a bad choice is refused in plain words
    const body = { person: { type: "contact", id: c!.id }, kindSlug: "client", minutes: 30, firstBookingOnly: false }
    const pv = await json(await preview(req("POST", "/api/booking/preview", body)))
    expect(pv.body).toMatchObject({ ok: true, once: false, minutes: 30, ready: true })
    expect(pv.body.lines.map((l: { label: string }) => l.label)).toContain("Page")
    expect((await json(await preview(req("POST", "/api/booking/preview", { ...body, minutes: 0 })))).body.errors[0]).toMatch(/whole number of minutes/)

    // make the link: one row, the contact's two emails snapshotted
    const made = await json(await makeLink(req("POST", "/api/booking/links", body)))
    expect(made.status).toBe(200)
    const linkId = made.body.link.id as string
    mine.links.push(linkId)
    const publicId = made.body.link.publicId as string
    expect(made.body.link.url).toMatch(new RegExp(`/r/b/${publicId}$`))
    const { data: row } = await db.from("booking_links").select("*").eq("id", linkId).single()
    expect(row).toMatchObject({ contact_id: c!.id, kind_label: "Client", template_slug: "plain", duration_minutes: 30, once: false, status: "open", share_url: null, person_name: `ZZ Booking Proof ${STAMP}` })
    expect(row!.person_emails).toEqual([email("c1"), email("c1b")])

    // "Links I made" lists it
    const list = await json(await listLinks())
    expect(list.body.links.find((l: { id: string }) => l.id === linkId)).toMatchObject({ status: "open", what: "Open for bookings", kindLabel: "Client" })

    // the public redirect finds it by its id, tags it, fills in the name, and counts the visit
    const r1 = await decideRedirect(supabaseAdmin, publicId, { now: new Date(), userAgent: "Mozilla/5.0 Safari" })
    expect(r1).toMatchObject({ kind: "redirect", tagged: true })
    const u = new URL((r1 as { location: string }).location)
    expect(u.searchParams.get("utm_term")).toBe(publicId)
    expect(u.hostname).toBe("calendly.com")
    expect((await db.from("booking_links").select("open_count").eq("id", linkId).single()).data!.open_count).toBe(1)

    // stop it: afterwards the visitor lands on the normal booking page, untagged
    expect((await json(await revoke(req("POST", `/api/booking/links/${linkId}/revoke`, {}), ctx(linkId)))).status).toBe(200)
    expect((await json(await revoke(req("POST", `/api/booking/links/${linkId}/revoke`, {}), ctx(linkId)))).body.message).toMatch(/already stopped/)
    const r2 = await decideRedirect(supabaseAdmin, publicId, { now: new Date(), userAgent: "Mozilla/5.0 Safari" })
    expect(r2).toMatchObject({ kind: "redirect", tagged: false })
    expect((await db.from("booking_links").select("open_count").eq("id", linkId).single()).data!.open_count).toBe(1)
  }, 60_000)

  it("kinds: add, refuse a twin (capitals), rename, retire, restore — all through the catalog framework", async () => {
    const { POST: add } = await import("../../app/api/booking/kinds/route")
    const { PATCH: change } = await import("../../app/api/booking/kinds/[slug]/route")
    const name = `ZZ Vendor ${STAMP}`
    const a = await json(await add(req("POST", "/api/booking/kinds", { name, choice: "record" })))
    expect(a.status).toBe(200)
    const slug = a.body.kind.slug as string
    mine.kindSlugs.push(slug)
    expect(a.body.kind).toMatchObject({ name, status: "active", ready: true })
    expect((await json(await add(req("POST", "/api/booking/kinds", { name: name.toUpperCase(), choice: "none" })))).status).toBe(409)
    const renamed = await json(await change(req("PATCH", `/api/booking/kinds/${slug}`, { rename: `${name} Two` }), ctx("x", slug)))
    expect(renamed.body.kind.name).toBe(`${name} Two`)
    expect((await json(await change(req("PATCH", `/api/booking/kinds/${slug}`, { status: "retired" }), ctx("x", slug)))).body.kind.status).toBe("retired")
    // a retired kind cannot be used for a link
    const { POST: makeLink } = await import("../../app/api/booking/links/route")
    const refused = await json(await makeLink(req("POST", "/api/booking/links", { person: { type: "new" }, kindSlug: slug, minutes: 30 })))
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatch(/retired/)
    expect((await json(await change(req("PATCH", `/api/booking/kinds/${slug}`, { status: "active" }), ctx("x", slug)))).body.kind.status).toBe("active")
    const { data: log } = await db.from("catalog_decision_log").select("action").eq("catalog_id", "booking_kinds").eq("reason", "Booking page: kind retired")
    expect((log ?? []).length).toBeGreaterThan(0)
  }, 60_000)

  it("Calls to check: 'Same person: link this email' does all four things for real, and the card is answered", async () => {
    // eslint-disable-next-line no-restricted-syntax -- test people seeded straight into the SANDBOX
    const { data: c } = await db.from("contacts").insert({ full_name: `ZZ Booking Ferri ${STAMP}`, email: email("ferri"), is_test: true }).select("id").single()
    mine.contacts.push(c!.id)
    const stray = email("ferri.new")
    // eslint-disable-next-line no-restricted-syntax -- a stray lead, as the webhook makes it
    const { data: lead } = await db.from("leads").insert({ full_name: `ZZ Booking Stray ${STAMP}`, email: stray, status: "Call Scheduled", is_test: true }).select("id").single()
    mine.leads.push(lead!.id)
    const { data: lc } = await db.from("lead_calls").insert({ lead_id: lead!.id, booked_at: new Date().toISOString(), scheduled_start: "2026-12-15T15:00:00Z", scheduled_date: "2026-12-15", state: "scheduled", calendly_event_uri: EVENT, source: "calendly" }).select("id").single()
    mine.leadCalls.push(lc!.id)
    const { data: link } = await db.from("booking_links").insert({ public_id: `ZZB1${STAMP}`.slice(0, 22).padEnd(22, "0"), kind_label: "Client", rule_snapshot: { v: 1, kind_slug: "client", kind_label: "Client", rule: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false } }, contact_id: c!.id, person_name: `ZZ Booking Ferri ${STAMP}`, person_emails: [email("ferri")], template_slug: "plain", duration_minutes: 30, once: true, status: "open", created_by: "zz" }).select("id").single()
    mine.links.push(link!.id)
    const invitee = `${EVENT}/invitees/bbbbbbbb-0000-4000-8000-${STAMP.padStart(12, "0").slice(-12)}`
    const { data: card } = await db.from("call_checks").insert({ kind: "mismatch", dedupe_key: invitee, status: "open", booking_link_id: link!.id, contact_id: c!.id, calendly_event_uri: EVENT, payload: { booker_email: stray, booker_name: "ZZ Stray", kind_label: "Client", person_name: `ZZ Booking Ferri ${STAMP}` } }).select("id").single()
    mine.cards.push(card!.id)

    const { loadOpenChecks } = await import("@/lib/booking/checks")
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const before = await loadOpenChecks(supabaseAdmin, new Date())
    expect(before).toMatchObject({ ok: true })
    const shown = (before as { cards: Array<{ id: string; callAt: string | null; answers: Array<{ key: string }> }> }).cards.find((x) => x.id === card!.id)!
    expect(new Date(shown.callAt as string).toISOString()).toBe("2026-12-15T15:00:00.000Z")
    expect(shown.answers.map((a) => a.key)).toEqual(["same_person", "different_person", "dismiss"])

    const { POST: answer } = await import("../../app/api/booking/checks/[id]/answer/route")
    const res = await json(await answer(req("POST", `/api/booking/checks/${card!.id}/answer`, { answer: "same_person" }), ctx(card!.id)))
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    expect((await db.from("contacts").select("alt_emails").eq("id", c!.id).single()).data!.alt_emails).toContain(stray)
    expect((await db.from("leads").select("existing_client_contact_id").eq("id", lead!.id).single()).data!.existing_client_contact_id).toBe(c!.id)
    const { data: cc } = await db.from("contact_calls").select("contact_id, scheduled_start, state, booking_link_id").eq("calendly_event_uri", EVENT)
    expect(cc).toHaveLength(1)
    expect(cc![0]).toMatchObject({ contact_id: c!.id, state: "scheduled", booking_link_id: link!.id })
    expect((await db.from("booking_links").select("status, claimed_email, effects_done_at").eq("id", link!.id).single()).data).toMatchObject({ status: "claimed", claimed_email: stray })
    expect((await db.from("call_checks").select("status, answer").eq("id", card!.id).single()).data).toMatchObject({ status: "answered", answer: "same_person" })

    // pressing it again changes nothing
    const again = await json(await answer(req("POST", `/api/booking/checks/${card!.id}/answer`, { answer: "same_person" }), ctx(card!.id)))
    expect(again.body.message).toBe("This card was already answered.")
    expect((await db.from("contact_calls").select("id").eq("calendly_event_uri", EVENT)).data).toHaveLength(1)
    const after = await loadOpenChecks(supabaseAdmin, new Date())
    expect((after as { cards: Array<{ id: string }> }).cards.find((x) => x.id === card!.id)).toBeUndefined()
  }, 60_000)

  it("two calls on the same day: the first call's summary leaves the second listed (real rows)", async () => {
    const { bookedCallsToShow, listContactCalls } = await import("@/lib/leads/contact-calls")
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line no-restricted-syntax -- a test person seeded straight into the SANDBOX
    const { data: c } = await db.from("contacts").insert({ full_name: `ZZ Booking Day ${STAMP}`, email: email("day"), is_test: true }).select("id").single()
    mine.contacts.push(c!.id)
    await db.from("contact_calls").insert([
      { contact_id: c!.id, scheduled_start: "2026-12-16T15:00:00Z", scheduled_date: "2026-12-16", state: "scheduled", calendly_event_uri: `${EVENT}D1`, source: "calendly" },
      { contact_id: c!.id, scheduled_start: "2026-12-16T19:00:00Z", scheduled_date: "2026-12-16", state: "scheduled", calendly_event_uri: `${EVENT}D2`, source: "calendly" },
    ])
    const rows = await listContactCalls(supabaseAdmin, c!.id)
    expect(rows).toHaveLength(2)
    const shown = bookedCallsToShow(rows, ["2026-12-16T16:30:00Z"])
    expect(shown).toHaveLength(1)
    expect(shown[0].calendly_event_uri).toBe(`${EVENT}D2`)
  }, 60_000)
})
