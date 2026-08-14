/**
 * extractInviteeFields + detectLanguage + buildLeadNotes — Calendly parser.
 *
 * Regression guard for the 2026-05-27 bug: real Calendly v2 webhooks place the
 * invitee fields DIRECTLY on payload.payload; our parser previously read them
 * from payload.payload.invitee.*. These cases lock in both shapes plus the
 * richer field extraction (name parts, phone, language, call time, meeting URL,
 * notes) added 2026-05-28.
 *
 * The "real" fixture mirrors the verbatim shape Calendly delivered for the live
 * booking (event b478a575) on 2026-05-28.
 */

import { describe, it, expect } from "vitest"
import {
  extractInviteeFields,
  detectLanguage,
  buildLeadNotes,
  type ParsedQA,
} from "@/lib/calendly/parse-invitee"

function realPayload(extraQA: Array<{ question: string; answer: string }> = []) {
  return {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/b478a575/invitees/ce872cb7",
      event: "https://api.calendly.com/scheduled_events/b478a575",
      email: "Pasquale@BlueMagicLinic.com",
      name: "Pasquale Minasi",
      first_name: "Pasquale",
      last_name: "Minasi",
      timezone: "Europe/Berlin",
      tracking: { utm_campaign: null, utm_source: null },
      questions_and_answers: [
        { answer: "Interested to open a company in US", position: 0, question: "What is the main reason for booking this call?\n\nQual è il motivo..." },
        { answer: "Referred by Guido", position: 1, question: "How did you find out about our services? (Instagram, YouTube, Google, website, referral, other)" },
        { answer: "+39 333 437 4360", position: 2, question: "What is your phone number? Please include your country code." },
        ...extraQA,
      ],
      scheduled_event: {
        name: "Free meet&greet call",
        start_time: "2026-06-01T17:00:00.000000Z",
        location: { type: "zoom", join_url: "https://us06web.zoom.us/j/84833905915?pwd=abc" },
      },
    },
  }
}

describe("extractInviteeFields — real Calendly v2 shape", () => {
  it("parses email (lowercased), name, and name parts", () => {
    const f = extractInviteeFields(realPayload())!
    expect(f.email).toBe("pasquale@bluemagiclinic.com")
    expect(f.name).toBe("Pasquale Minasi")
    expect(f.firstName).toBe("Pasquale")
    expect(f.lastName).toBe("Minasi")
  })

  it("extracts phone from the form answer (dedicated field empty)", () => {
    expect(extractInviteeFields(realPayload())!.phone).toBe("+39 333 437 4360")
  })

  it("captures reason, call date+time, timezone, event type, meeting URL", () => {
    const f = extractInviteeFields(realPayload())!
    expect(f.reason).toBe("Interested to open a company in US")
    expect(f.callDate).toBe("2026-06-01")
    expect(f.callTime).toBe("2026-06-01T17:00:00.000000Z")
    expect(f.timezone).toBe("Europe/Berlin")
    expect(f.eventTypeName).toBe("Free meet&greet call")
    expect(f.meetingUrl).toBe("https://us06web.zoom.us/j/84833905915?pwd=abc")
  })

  // Regression guard for the 2026-08-13 change: a "how did you find out about
  // us" answer is a marketing channel, not a person — it must NOT become a
  // referrer's name (that field is gone entirely), and the raw answer must
  // still survive verbatim in the lead's notes so nothing is lost.
  it("does NOT extract a referrer from the how-they-heard answer", () => {
    const f = extractInviteeFields(realPayload())!
    expect("referrerName" in f).toBe(false)
  })

  it("still preserves the how-they-heard answer verbatim in the notes", () => {
    const f = extractInviteeFields(realPayload())!
    expect(buildLeadNotes(f)).toContain("Referred by Guido")
  })

  it("does NOT false-match phone as the referral code", () => {
    expect(extractInviteeFields(realPayload())!.referralCode).toBeNull()
  })
})

describe("language detection — flexible, label-independent", () => {
  const cases: Array<[string, string | null]> = [
    ["Italian", "Italian"],
    ["Italiano", "Italian"],
    ["🇮🇹 Italiano", "Italian"],
    ["it", "Italian"],
    ["English", "English"],
    ["Inglese", "English"],
    ["🇬🇧 English", "English"],
    ["en", "English"],
  ]
  it.each(cases)("language question answer %s → %s", (answer, expected) => {
    const qa: ParsedQA[] = [{ question: "Preferred language / Lingua preferita", answer }]
    expect(detectLanguage(qa)).toBe(expected)
  })

  it("does not false-match free-text containing 'ital' (e.g. capital)", () => {
    const qa: ParsedQA[] = [
      { question: "What is the main reason?", answer: "I need help raising capital" },
    ]
    expect(detectLanguage(qa)).toBeNull()
  })

  it("falls back to a short language answer when no language question keyword", () => {
    const qa: ParsedQA[] = [
      { question: "Choose one", answer: "Italiano" },
      { question: "Reason", answer: "open an LLC" },
    ]
    expect(detectLanguage(qa)).toBe("Italian")
  })

  it("flows language into the parsed lead when the form includes it", () => {
    const f = extractInviteeFields(
      realPayload([{ question: "Which language do you prefer? / Lingua", answer: "Italiano" }])
    )!
    expect(f.language).toBe("Italian")
  })

  it("language is null when not present", () => {
    expect(extractInviteeFields(realPayload())!.language).toBeNull()
  })
})

describe("buildLeadNotes", () => {
  it("includes call type, time+timezone, meeting URL, and full Q&A", () => {
    const f = extractInviteeFields(realPayload())!
    const notes = buildLeadNotes(f)
    expect(notes).toContain("Free meet&greet call")
    expect(notes).toContain("2026-06-01T17:00:00.000000Z")
    expect(notes).toContain("Europe/Berlin")
    expect(notes).toContain("https://us06web.zoom.us/j/84833905915?pwd=abc")
    expect(notes).toContain("Interested to open a company in US")
    expect(notes).toContain("+39 333 437 4360")
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
    const f = extractInviteeFields(legacyPayload)!
    expect(f.email).toBe("qa-test@example.com")
    expect(f.name).toBe("QA Test")
    expect(f.phone).toBe("+1234567890")
    expect(f.referralCode).toBe("marco-rossi")
  })
})

describe("extractInviteeFields — guards", () => {
  it("returns null when there is no email in either shape", () => {
    expect(extractInviteeFields({ event: "invitee.created", payload: { name: "No Email" } })).toBeNull()
    expect(extractInviteeFields({ event: "invitee.created", payload: {} })).toBeNull()
    expect(extractInviteeFields({ event: "invitee.created" })).toBeNull()
  })
})
