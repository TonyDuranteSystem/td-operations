/**
 * REAL RUN against the SANDBOX database (booking engine, Stage 1a). Skipped unless BOOKING_SANDBOX_RUN=1 — `npm run test:unit` and CI never touch a database.
 *
 * The in-memory tests prove the logic; this proves what only a real Postgres + PostgREST can: the atomic claim (two bookings racing for one link), the plain unique
 * constraint behind "one card per booking", the foreign keys (cascade / set null), array and ilike filters, and that the new tables are really locked from a login token.
 * It runs the REAL webhook route (real supabase-js client from .env.local) on synthetic bookings for test people that carry a unique ZZ-prefix, then removes every row it made.
 * Refuses to run unless the database is the sandbox (never the production ref). Money / referral / error-report modules are mocked: nothing is sent, nothing is charged.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import type { NextRequest } from "next/server"
import dotenv from "dotenv"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { makeReq } from "./helpers/calendly-replay-harness"
import { buildRuleSnapshot, type KindRule } from "@/lib/booking/kinds"

const RUN = process.env.BOOKING_SANDBOX_RUN === "1"
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const PROD_REF = "ydzipybqeebtpcvsbtvs"

const h = vi.hoisted(() => ({ errors: [] as Array<{ message?: string }> }))
vi.mock("@/lib/operations/paid-call-credit", () => ({ recordPaidCall: async () => { throw new Error("must not be called in the real run") } }))
vi.mock("@/lib/operations/referral", () => ({ createPendingReferral: async () => { throw new Error("must not be called in the real run") } }))
vi.mock("@/lib/operations/referral-notify", () => ({ notifyReferrerLinked: async () => { throw new Error("must not be called in the real run") } }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (a: { message?: string }) => { h.errors.push(a) } }))

if (RUN) dotenv.config({ path: ".env.local" })

const STAMP = `${Date.now()}`
const EV = `https://api.calendly.com/scheduled_events/ZZBP${STAMP}`
const RULES: Record<string, KindRule> = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false },
}
const idOf = (n: number) => `ZZBP${STAMP}${String(n).padStart(5, "0")}` // 4 + 13 + 5 = 22 characters

describe.skipIf(!RUN)("booking engine — REAL run against the sandbox database", () => {
  let db: SupabaseClient
  const mine = { contacts: [] as string[], links: [] as string[], leads: [] as string[], settingRow: false }
  let secret = ""
  let POST: (req: NextRequest) => Promise<Response>

  const email = (k: string) => `zz-bp-${STAMP}-${k}@example.invalid`
  const send = async (payload: unknown) => {
    const res = await POST(makeReq(payload, secret) as unknown as NextRequest)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const booking = (o: { email: string; n: number; term?: string | null; old?: string }) => {
    const ev = `${EV}E${o.n}`
    return {
      event: "invitee.created",
      payload: {
        uri: `${ev}/invitees/I${o.n}`, event: ev, email: o.email, name: `ZZ Booking Proof ${o.n}`, first_name: "ZZ", last_name: `Proof ${o.n}`, timezone: "America/New_York",
        questions_and_answers: [], tracking: o.term ? { utm_term: o.term } : {}, scheduled_event: { start_time: "2026-12-15T15:00:00Z", name: "ZZ Proof Meeting" },
        ...(o.old ? { old_invitee: o.old } : {}),
      },
    }
  }
  async function makeContact(key: string, extra: Record<string, unknown> = {}) {
    // eslint-disable-next-line no-restricted-syntax -- a test person seeded straight into the SANDBOX (never production); removed again in afterAll
    const { data, error } = await db.from("contacts").insert({ full_name: `ZZ Booking Proof ${key}`, email: email(key), portal_tier: "active", ...extra }).select("id").single()
    if (error) throw new Error(`contact insert: ${error.message}`)
    mine.contacts.push(data.id)
    return data.id as string
  }
  async function makeLink(n: number, kind: keyof typeof RULES, over: Record<string, unknown> = {}) {
    const { data, error } = await db.from("booking_links").insert({
      public_id: idOf(n), kind_label: kind, rule_snapshot: buildRuleSnapshot({ slug: kind, label: kind }, RULES[kind]), person_emails: [], once: true, person_name: `ZZ Booking Proof ${n}`, ...over,
    }).select("id").single()
    if (error) throw new Error(`link insert: ${error.message}`)
    mine.links.push(data.id)
    return data.id as string
  }
  const link = async (id: string) => (await db.from("booking_links").select("*").eq("id", id).single()).data as Record<string, unknown>
  const callsOf = async (contactId: string) => (await db.from("contact_calls").select("*").eq("contact_id", contactId)).data ?? []
  const cardsFor = async (n: number) => (await db.from("call_checks").select("*").like("dedupe_key", `${EV}E${n}%`)).data ?? []
  const leadsOf = async (mail: string) => {
    const { data } = await db.from("leads").select("*").eq("email", mail)
    for (const l of data ?? []) if (!mine.leads.includes(l.id)) mine.leads.push(l.id)
    return data ?? []
  }

  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
    if (!url.includes(SANDBOX_REF) || url.includes(PROD_REF) || !key) throw new Error("REFUSED: this proof runs only against the sandbox database")
    db = createClient(url, key)
    secret = "zz-booking-proof-secret"
    process.env.CALENDLY_WEBHOOK_SECRET = secret
    process.env.CALENDLY_INTAKE_MODE = "auto_create"
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const existing = await db.from("app_settings").select("key").eq("key", "booking").maybeSingle()
    if (existing.data) throw new Error("REFUSED: the sandbox already has a `booking` setting — not overwriting someone else's state")
    const ins = await db.from("app_settings").insert({ key: "booking", value: { mode: "live" } })
    if (ins.error) throw new Error(`setting insert: ${ins.error.message}`)
    mine.settingRow = true
    POST = (await import("@/app/api/webhooks/calendly/route")).POST as unknown as typeof POST
  })

  afterAll(async () => {
    if (!db) return
    // exact rows only (by the ids this run made), children first
    if (mine.leads.length) await db.from("leads").delete().in("id", mine.leads) // lead_calls cascade
    if (mine.links.length) await db.from("call_checks").delete().in("booking_link_id", mine.links)
    await db.from("call_checks").delete().like("dedupe_key", `${EV}%`)
    if (mine.links.length) await db.from("booking_links").delete().in("id", mine.links)
    if (mine.contacts.length) await db.from("contacts").delete().in("id", mine.contacts) // contact_calls cascade
    await db.from("webhook_events").delete().like("external_id", `${EV}%`)
    if (mine.settingRow) await db.from("app_settings").delete().eq("key", "booking")
  })

  it("Client kind: the call is saved under the contact (real rows), no lead, link claimed with effects done", async () => {
    const c = await makeContact("a")
    const l = await makeLink(1, "client", { contact_id: c, person_emails: [email("a")] })
    const r = await send(booking({ email: email("a"), n: 1, term: idOf(1) }))
    expect(r.body).toMatchObject({ action: "attached", contact_id: c })
    expect((await callsOf(c)).length).toBe(1)
    expect((await callsOf(c))[0]).toMatchObject({ booking_link_id: l, state: "scheduled", scheduled_date: "2026-12-15" })
    expect(await leadsOf(email("a"))).toEqual([])
    expect(await link(l)).toMatchObject({ status: "claimed", claimed_email: email("a") })
    expect((await link(l)).effects_done_at).toBeTruthy()
    // the same delivery again: replay, nothing doubles
    const again = await send(booking({ email: email("a"), n: 1, term: idOf(1) }))
    expect(again.body).toEqual({ action: "replay" })
    expect((await callsOf(c)).length).toBe(1)
  })

  it("two deliveries racing for ONE one-time link: Postgres lets exactly one win", async () => {
    const c = await makeContact("race", { email_2: email("race2") })
    const l = await makeLink(2, "client", { contact_id: c })
    const [x, y] = await Promise.all([
      send(booking({ email: email("race"), n: 21, term: idOf(2) })),
      send(booking({ email: email("race"), n: 22, term: idOf(2) })),
    ])
    const actions = [x.body.action, y.body.action].sort()
    expect(actions).toEqual(["attached", "created"])
    expect((await callsOf(c)).length).toBe(1)
    const row = await link(l)
    expect(row.status).toBe("claimed")
    const loser = x.body.action === "created" ? 21 : 22
    const cards = await cardsFor(loser)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: "unknown_id", booking_link_id: l })
    expect((cards[0].payload as Record<string, unknown>).reason).toBe("used")
    await leadsOf(email("race"))
  })

  it("wrong email: a normal lead, no claim, ONE mismatch card even when delivered twice (real unique constraint)", async () => {
    const c = await makeContact("mm")
    const l = await makeLink(3, "client", { contact_id: c, person_emails: [email("mm")] })
    const p = booking({ email: email("stranger"), n: 3, term: idOf(3) })
    const r1 = await send(p)
    const r2 = await send(p)
    expect(r1.body.action).toBe("created")
    expect(r2.body.action).toBe("updated")
    expect((await link(l)).status).toBe("open")
    const cards = await cardsFor(3)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: "mismatch", status: "open" })
    expect((await leadsOf(email("stranger"))).length).toBe(1)
  })

  it("an id of our shape that matches no link: a lead as today + an unknown_id card; an ad keyword: nothing", async () => {
    const a = await send(booking({ email: email("u1"), n: 4, term: "Z".repeat(22) }))
    expect(a.body.action).toBe("created")
    expect((await cardsFor(4))[0]).toMatchObject({ kind: "unknown_id" })
    const b = await send(booking({ email: email("u2"), n: 5, term: "llc formation near me" }))
    expect(b.body.action).toBe("created")
    expect(await cardsFor(5)).toEqual([])
    await leadsOf(email("u1")); await leadsOf(email("u2"))
  })

  it("an email-less link is found for a booker using the contact's SECOND address (email_2) — a real ilike on the real column", async () => {
    const c = await makeContact("alias", { email_2: email("alias-work") })
    await makeLink(6, "client", { person_emails: [] })
    const r = await send(booking({ email: email("alias-work"), n: 6, term: idOf(6) }))
    expect(r.body).toMatchObject({ action: "attached", contact_id: c })
  })

  it("a booker whose alternate address is in alt_emails (real array filter) is attached too", async () => {
    const c = await makeContact("alt", { alt_emails: [email("alt-old")] })
    await makeLink(7, "client", { person_emails: [] })
    const r = await send(booking({ email: email("alt-old"), n: 7, term: idOf(7) }))
    expect(r.body).toMatchObject({ action: "attached", contact_id: c })
  })

  it("reschedule with the tag, and with NO tag: the claim follows the booking, the old call is marked moved, no stray lead", async () => {
    const c = await makeContact("resch")
    const l = await makeLink(8, "client", { contact_id: c })
    const first = booking({ email: email("resch"), n: 81, term: idOf(8) })
    await send(first)
    const second = booking({ email: email("resch"), n: 82, term: idOf(8), old: first.payload.uri })
    expect((await send(second)).body.action).toBe("attached")
    const third = booking({ email: email("resch"), n: 83, term: null, old: second.payload.uri })
    expect((await send(third)).body.action).toBe("attached")
    const calls = await callsOf(c)
    expect(calls).toHaveLength(3)
    expect(calls.filter((x) => x.state === "scheduled")).toHaveLength(1)
    expect(calls.filter((x) => x.state === "moved")).toHaveLength(2)
    expect((await link(l)).claimed_invitee_uri).toBe(third.payload.uri)
    expect(await leadsOf(email("resch"))).toEqual([])
  })

  it("Partner kind, new person: the lead is made, its notes start with the kind, the link remembers the lead", async () => {
    const l = await makeLink(9, "partner", { person_emails: [email("pnew")], person_language: "Italiano" })
    const r = await send(booking({ email: email("pnew"), n: 9, term: idOf(9) }))
    expect(r.body.action).toBe("created")
    const leads = await leadsOf(email("pnew"))
    expect(leads).toHaveLength(1)
    expect(String(leads[0].notes).split("\n")[0]).toBe("Booking kind: partner")
    expect(leads[0].language).toBe("Italian")
    const row = await link(l)
    expect(row.lead_id).toBe(leads[0].id)
    expect(row.effects_done_at).toBeTruthy()
    const { data: calls } = await db.from("lead_calls").select("id").eq("lead_id", leads[0].id as string)
    expect(calls).toHaveLength(1)
  })

  it("a reusable link never claims, however many people book through it", async () => {
    const c1 = await makeContact("r1")
    const c2 = await makeContact("r2")
    const l = await makeLink(10, "client", { once: false })
    expect((await send(booking({ email: email("r1"), n: 101, term: idOf(10) }))).body.action).toBe("attached")
    expect((await send(booking({ email: email("r2"), n: 102, term: idOf(10) }))).body.action).toBe("attached")
    expect(await link(l)).toMatchObject({ status: "open", claimed_invitee_uri: null })
    expect((await callsOf(c1)).length + (await callsOf(c2)).length).toBe(2)
  })

  it("the new tables are locked: a logged-in token (anon key) cannot read them", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
    for (const t of ["booking_links", "call_checks", "contact_calls"]) {
      const r = await anon.from(t).select("id").limit(1)
      expect(r.data ?? []).toEqual([])
      expect(r.error).not.toBeNull() // permission denied, not merely an empty list
    }
  })

  it("foreign keys: deleting a contact removes its logged calls and sets the link's contact to null (the link survives)", async () => {
    const c = await makeContact("fk")
    const l = await makeLink(11, "client", { contact_id: c })
    await send(booking({ email: email("fk"), n: 111, term: idOf(11) }))
    expect((await callsOf(c)).length).toBe(1)
    await db.from("contacts").delete().eq("id", c)
    expect((await callsOf(c)).length).toBe(0)
    expect((await link(l)).contact_id).toBeNull()
  })

  it("nothing was reported as a system error and no booking branch failure reached the log", () => {
    expect(h.errors).toEqual([])
  })
})
