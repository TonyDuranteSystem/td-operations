/**
 * extractInviteeFields — Calendly webhook payload parser.
 *
 * Regression guard for the 2026-05-27 bug: real Calendly v2 webhooks place the
 * invitee fields DIRECTLY on payload.payload (email, name, questions_and_answers,
 * tracking). Our parser previously read them from payload.payload.invitee.* — a
 * wrapper that only existed in a synthetic test payload, never in real Calendly.
 * Result: every real booking was rejected with 400 "No invitee email" and never
 * stored. These cases lock in both shapes.
 *
 * The "real" fixture below is the verbatim shape returned by Calendly's API for
 * the live booking housedurante@gmail.com (event cadb5264, invitee ef8bf05c) —
 * confirmed via GET /scheduled_events/{uri}/invitees on 2026-05-27.
 */

import { describe, it, expect } from "vitest"
import { extractInviteeFields } from "@/lib/calendly/parse-invitee"

describe("extractInviteeFields — real Calendly v2 shape (fields on payload.payload)", () => {
  const realPayload = {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/cadb5264/invitees/ef8bf05c",
      event: "https://api.calendly.com/scheduled_events/cadb5264",
      email: "housedurante@gmail.com",
      name: "Antonio Noel Durante",
      first_name: "Antonio",
      last_name: "Noel Durante",
      questions_and_answers: [
        { answer: "uxio-test", position: 0, question: "What is the main reason for booking this call?" },
        { answer: "gg", position: 1, question: "How did you find out about our services? (Instagram, YouTube, Google, website, referral, other)" },
        { answer: "+1 727-253-5199", position: 2, question: "What is your phone number?" },
      ],
      tracking: {
        utm_campaign: "uxio-test",
        utm_source: "referral",
        utm_medium: "link",
        utm_content: null,
        utm_term: null,
      },
      scheduled_event: { start_time: "2026-06-03T13:30:00.000000Z", name: "Free Call" },
    },
  }

  it("parses email/name from the top level (no invitee wrapper)", () => {
    const f = extractInviteeFields(realPayload)
    expect(f).not.toBeNull()
    expect(f!.email).toBe("housedurante@gmail.com")
    expect(f!.name).toBe("Antonio Noel Durante")
  })

  it("extracts the referral code from tracking.utm_campaign", () => {
    const f = extractInviteeFields(realPayload)
    expect(f!.referralCode).toBe("uxio-test")
  })

  it("derives the call date from scheduled_event.start_time", () => {
    const f = extractInviteeFields(realPayload)
    expect(f!.callDate).toBe("2026-06-03")
  })
})

describe("extractInviteeFields — legacy nested shape (payload.payload.invitee.*)", () => {
  const legacyPayload = {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/TEST/invitees/TEST",
      invitee: {
        name: "QA Test",
        email: "qa-test@example.com",
        phone_number: "+1234567890",
        questions_and_answers: [
          { answer: "LLC formation", question: "What is the main reason for booking this call?" },
        ],
      },
      tracking: { utm_campaign: "marco-rossi" },
      scheduled_event: { start_time: "2026-04-05T14:00:00Z" },
    },
  }

  it("still parses the nested invitee shape", () => {
    const f = extractInviteeFields(legacyPayload)
    expect(f).not.toBeNull()
    expect(f!.email).toBe("qa-test@example.com")
    expect(f!.name).toBe("QA Test")
    expect(f!.referralCode).toBe("marco-rossi")
  })
})

describe("extractInviteeFields — guards", () => {
  it("returns null when there is no email in either shape", () => {
    expect(extractInviteeFields({ event: "invitee.created", payload: { name: "No Email" } })).toBeNull()
    expect(extractInviteeFields({ event: "invitee.created", payload: {} })).toBeNull()
    expect(extractInviteeFields({ event: "invitee.created" })).toBeNull()
  })
})
