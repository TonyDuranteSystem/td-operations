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
}
const fixtures: Fixtures = { existingLeads: [], existingContacts: [], referrer: null, newLeadId: "lead-new" }
const recorded: { leadInsert?: Record<string, unknown>; webhookInsert?: Record<string, unknown> } = {}

function makeBuilder(table: string) {
  const state: { table: string; insertPayload?: Record<string, unknown>; ilikeCol?: string } = { table }
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.eq = chain
  builder.limit = chain
  builder.update = chain
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
  const resolve = () => {
    if (table === "leads" && state.insertPayload) return { data: { id: fixtures.newLeadId }, error: null }
    if (table === "leads") return { data: fixtures.existingLeads, error: null }
    if (table === "contacts" && state.ilikeCol === "referral_code") return { data: fixtures.referrer, error: null }
    if (table === "contacts") return { data: fixtures.existingContacts, error: null }
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
  delete recorded.leadInsert
  delete recorded.webhookInsert
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
