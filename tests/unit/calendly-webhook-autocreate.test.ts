/**
 * /api/webhooks/calendly — AUTO-CREATE mode wiring.
 *
 * Verifies that when CALENDLY_INTAKE_MODE=auto_create and a booking carries a
 * referral code that resolves to a referring client, the route:
 *   - creates a NEW lead with source='Referral'
 *   - calls createPendingReferral linking that referrer to the new lead
 * and that a plain (non-referral) booking creates a lead with source='Calendly'
 * and does NOT create a referral.
 *
 * Supabase is mocked with a small chainable builder; createPendingReferral is
 * mocked so we observe the call without touching the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextRequest } from "next/server"

// ── Mocked referral helper ──────────────────────────────────────────────────
const createPendingReferralMock = vi.fn(async () => ({ created: true, id: "ref-1" }))
vi.mock("@/lib/operations/referral", () => ({
  createPendingReferral: (...args: unknown[]) => createPendingReferralMock(...args),
}))

// ── Mutable fixtures + recorder (shared with the mocked supabase client) ──────
interface Fixtures {
  existingLeads: unknown[]
  existingContacts: unknown[]
  referrer: unknown | null
  newLeadId: string
  accountLinks: unknown[]
  serviceDeliveries: unknown[]
}
const fixtures: Fixtures = {
  existingLeads: [],
  existingContacts: [],
  referrer: null,
  newLeadId: "lead-new",
  accountLinks: [],
  serviceDeliveries: [],
}
const recorded: { leadInsert?: Record<string, unknown>; webhookInsert?: Record<string, unknown>; leadUpdate?: Record<string, unknown> } = {}

function makeBuilder(table: string) {
  const state: { table: string; insertPayload?: Record<string, unknown>; ilikeCol?: string; eqCol?: string } = { table }
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.order = chain
  builder.limit = chain
  builder.eq = (col: string) => {
    state.eqCol = col
    return builder
  }
  builder.ilike = (col: string) => {
    state.ilikeCol = col
    return builder
  }
  builder.insert = (payload: Record<string, unknown>) => {
    state.insertPayload = payload
    if (table === "leads") recorded.leadInsert = payload
    if (table === "webhook_events") recorded.webhookInsert = payload
    return builder
  }
  builder.update = (payload: Record<string, unknown>) => {
    if (table === "leads") recorded.leadUpdate = payload
    return builder
  }
  const resolve = () => {
    if (table === "leads" && state.insertPayload) return { data: { id: fixtures.newLeadId }, error: null }
    if (table === "leads") return { data: fixtures.existingLeads, error: null }
    if (table === "contacts" && state.ilikeCol === "referral_code") return { data: fixtures.referrer, error: null }
    if (table === "contacts") return { data: fixtures.existingContacts, error: null }
    if (table === "account_contacts") return { data: fixtures.accountLinks, error: null }
    if (table === "service_deliveries") return { data: fixtures.serviceDeliveries, error: null }
    if (table === "webhook_events") return { data: null, error: null }
    return { data: null, error: null }
  }
  builder.maybeSingle = async () => resolve()
  builder.single = async () => resolve()
  builder.then = (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF)
  return builder
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (table: string) => makeBuilder(table) }),
}))

// Import AFTER mocks are registered.
import { POST } from "@/app/api/webhooks/calendly/route"

function bookingPayload(referralCode: string | null) {
  return {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/E/invitees/I",
      event: "https://api.calendly.com/scheduled_events/E",
      email: "booker@example.com",
      name: "Booker Person",
      first_name: "Booker",
      last_name: "Person",
      timezone: "Europe/Rome",
      questions_and_answers: [
        { question: "What is your phone number?", answer: "+39 02 1234 5678" },
        { question: "Preferred language / Lingua", answer: "Italiano" },
      ],
      tracking: referralCode ? { utm_campaign: referralCode } : {},
      scheduled_event: { start_time: "2026-06-10T15:00:00Z", name: "Free Call" },
    },
  }
}

function makeReq(body: unknown): NextRequest {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as NextRequest
}

beforeEach(() => {
  createPendingReferralMock.mockClear()
  fixtures.existingLeads = []
  fixtures.existingContacts = []
  fixtures.referrer = null
  fixtures.newLeadId = "lead-new"
  fixtures.accountLinks = []
  fixtures.serviceDeliveries = []
  delete recorded.leadInsert
  delete recorded.webhookInsert
  delete recorded.leadUpdate
  process.env.CALENDLY_INTAKE_MODE = "auto_create"
})

describe("calendly webhook — auto_create with referral", () => {
  it("creates a Referral-source lead and a pending referral when the code resolves", async () => {
    fixtures.referrer = { id: "referrer-contact-1", full_name: "Uxio Test" }

    const res = await POST(makeReq(bookingPayload("uxio-test")))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(json.lead_id).toBe("lead-new")
    expect(json.referrer_contact_id).toBe("referrer-contact-1")

    expect(recorded.leadInsert?.source).toBe("Referral")
    expect(recorded.leadInsert?.referrer_name).toBe("Uxio Test")
    // New bundle fields flow into the lead insert
    expect(recorded.leadInsert?.first_name).toBe("Booker")
    expect(recorded.leadInsert?.last_name).toBe("Person")
    expect(recorded.leadInsert?.phone).toBe("+39 02 1234 5678")
    expect(recorded.leadInsert?.language).toBe("Italian")

    expect(createPendingReferralMock).toHaveBeenCalledTimes(1)
    const [params] = createPendingReferralMock.mock.calls[0] as [Record<string, unknown>]
    expect(params.referrerContactId).toBe("referrer-contact-1")
    expect(params.referredLeadId).toBe("lead-new")
    expect(params.referredEmail).toBe("booker@example.com")

    // The booking record is marked auto_created so it stays OFF the Intake review list
    expect(recorded.webhookInsert?.review_status).toBe("auto_created")
  })
})

describe("calendly webhook — auto_create without referral", () => {
  it("creates a Calendly-source lead and no referral when there is no code", async () => {
    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.source).toBe("Calendly")
    expect(createPendingReferralMock).not.toHaveBeenCalled()
  })

  it("does not create a referral when the code does not resolve to a client", async () => {
    fixtures.referrer = null // unknown code
    const res = await POST(makeReq(bookingPayload("does-not-exist")))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.source).toBe("Calendly")
    expect(createPendingReferralMock).not.toHaveBeenCalled()
  })
})

// ── Existing-client tagging (dev job 93580372) ─────────────────────────────
// The booking still ALWAYS creates a lead (referral attribution, paid-call
// recording, Kanban visibility, and the Circleback-outage fallback all
// depend on that never changing). The only new behavior: when the email
// matches an established contact and there's no existing lead, the new lead
// is tagged with existing_client_contact_id so diagnose-contact/
// diagnose-account stop flagging it as an open, unconverted sales lead.
describe("calendly webhook — existing contact match (no existing lead)", () => {
  it("still creates the lead (never skips) and tags it when the contact is an active client", async () => {
    fixtures.existingContacts = [{ id: "contact-1", full_name: "Established Client", portal_tier: "active" }]

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.full_name).toBe("Booker Person")
    expect(recorded.leadInsert?.existing_client_contact_id).toBe("contact-1")
  })

  it("tags a contact-only client (null portal_tier) who has a service delivery — the ITIN case", async () => {
    fixtures.existingContacts = [{ id: "contact-2", full_name: "ITIN Client", portal_tier: null }]
    fixtures.serviceDeliveries = [{ id: "sd-1" }]

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.existing_client_contact_id).toBe("contact-2")
  })

  it("tags a co-member (null portal_tier) who has an account link", async () => {
    fixtures.existingContacts = [{ id: "contact-3", full_name: "Co-Member", portal_tier: null }]
    fixtures.accountLinks = [{ account_id: "acct-1" }]

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.existing_client_contact_id).toBe("contact-3")
  })

  it("still creates an UNTAGGED lead when the matched contact looks like a stub, not an established client", async () => {
    fixtures.existingContacts = [{ id: "contact-4", full_name: "Stub Contact", portal_tier: "lead" }]
    // no account link, no service delivery

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.existing_client_contact_id).toBeUndefined()
  })

  it("still runs referral attribution for an existing-contact booking that carries a referral code", async () => {
    fixtures.existingContacts = [{ id: "contact-5", full_name: "Existing Client", portal_tier: "active" }]
    fixtures.referrer = { id: "referrer-contact-9", full_name: "Some Referrer" }

    const res = await POST(makeReq(bookingPayload("some-code")))
    const json = await res.json()

    expect(json.action).toBe("created")
    expect(recorded.leadInsert?.existing_client_contact_id).toBe("contact-5")
    expect(recorded.leadInsert?.source).toBe("Referral")
    expect(createPendingReferralMock).toHaveBeenCalledTimes(1)
  })
})

// ── Repeat booking against an EXISTING lead (dev job 93580372, review gap) ──
// A returning established client whose email already matches an old lead row
// takes the "update in place" path, not the "create" path. That path must be
// tagged too, or an established client's repeat booking would silently never
// qualify for the existing-client recognition — the exact gap the Bug Hunter
// found in council review of the Leads-page redesign.
describe("calendly webhook — repeat booking against an existing lead row", () => {
  it("tags an existing lead on update when the contact is established and it wasn't tagged yet", async () => {
    fixtures.existingLeads = [{ id: "lead-old", status: "Lost", existing_client_contact_id: null }]
    fixtures.existingContacts = [{ id: "contact-est", full_name: "Established Client", portal_tier: "active" }]

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("updated")
    expect(json.lead_id).toBe("lead-old")
    expect(recorded.leadUpdate?.existing_client_contact_id).toBe("contact-est")
  })

  it("does not overwrite an already-tagged existing lead on update", async () => {
    fixtures.existingLeads = [{ id: "lead-old", status: "Call Scheduled", existing_client_contact_id: "contact-already-set" }]
    fixtures.existingContacts = [{ id: "contact-est", full_name: "Established Client", portal_tier: "active" }]

    const res = await POST(makeReq(bookingPayload(null)))

    expect(res.status).toBe(200)
    expect(recorded.leadUpdate).toBeDefined()
    expect("existing_client_contact_id" in (recorded.leadUpdate as Record<string, unknown>)).toBe(false)
  })

  it("does not tag an existing lead when the matched contact looks like a stub, not an established client", async () => {
    fixtures.existingLeads = [{ id: "lead-old", status: "New", existing_client_contact_id: null }]
    fixtures.existingContacts = [{ id: "contact-stub", full_name: "Stub Contact", portal_tier: "lead" }]

    await POST(makeReq(bookingPayload(null)))

    expect(recorded.leadUpdate).toBeDefined()
    expect("existing_client_contact_id" in (recorded.leadUpdate as Record<string, unknown>)).toBe(false)
  })

  it("still just updates in place, untagged, when there's no contact match at all", async () => {
    fixtures.existingLeads = [{ id: "lead-old", status: "New", existing_client_contact_id: null }]
    fixtures.existingContacts = []

    const res = await POST(makeReq(bookingPayload(null)))
    const json = await res.json()

    expect(json.action).toBe("updated")
    expect(recorded.leadUpdate).toBeDefined()
    expect("existing_client_contact_id" in (recorded.leadUpdate as Record<string, unknown>)).toBe(false)
  })
})
