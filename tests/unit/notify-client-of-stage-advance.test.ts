/**
 * Unit tests for lib/portal/notifications.ts::notifyClientOfStageAdvance.
 *
 * Covers: recipient resolution (contact_id vs account_id), bilingual rendering
 * (EN/IT), missing recipients, gmail send failures, multi-member fan-out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface ContactRow {
  email: string | null
  full_name: string | null
  language: string | null
}

let contactFixture: ContactRow | null = null
let accountContactsFixture: Array<{ contacts: ContactRow | null }> = []

const gmailPostMock = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "contacts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() => Promise.resolve({ data: contactFixture, error: null })),
        }
      }
      if (table === "account_contacts") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => Promise.resolve({ data: accountContactsFixture, error: null })),
        }
      }
      if (table === "portal_notifications") {
        return {
          insert: vi.fn(() => Promise.resolve({ error: null })),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

vi.mock("@/lib/gmail", () => ({
  gmailPost: (...args: unknown[]) => gmailPostMock(...args),
}))

vi.mock("@/lib/config", () => ({
  PORTAL_BASE_URL: "https://portal.test.local",
}))

import { notifyClientOfStageAdvance } from "@/lib/portal/notifications"

beforeEach(() => {
  contactFixture = null
  accountContactsFixture = []
  gmailPostMock.mockReset()
  gmailPostMock.mockResolvedValue({ id: "msg-1" })
})

function decodeRaw(arg: unknown): string {
  const payload = arg as { raw: string }
  return Buffer.from(payload.raw, "base64url").toString("utf8")
}

describe("notifyClientOfStageAdvance", () => {
  it("sends an English email when contact language is 'en'", async () => {
    contactFixture = { email: "alice@example.com", full_name: "Alice Smith", language: "en" }

    const result = await notifyClientOfStageAdvance({
      contact_id: "contact-1",
      service_name: "Tax Return 2024",
      stage_name: "TR Filed",
    })

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(gmailPostMock).toHaveBeenCalledTimes(1)
    const raw = decodeRaw(gmailPostMock.mock.calls[0][1])
    expect(raw).toContain("To: alice@example.com")
    // Subject is RFC 2047 base64-encoded — decode and verify.
    const subjectMatch = raw.match(/Subject: =\?utf-8\?B\?([^?]+)\?=/)
    expect(subjectMatch).not.toBeNull()
    const decodedSubject = Buffer.from(subjectMatch![1], "base64").toString("utf8")
    expect(decodedSubject).toBe("Service update: Tax Return 2024 — TR Filed")
    // HTML body is also base64 inside MIME — decode the inner part.
    const htmlMatch = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/)
    expect(htmlMatch).not.toBeNull()
    const decodedHtml = Buffer.from(htmlMatch![1], "base64").toString("utf8")
    expect(decodedHtml).toContain("Hi Alice,")
    expect(decodedHtml).toContain('Your service "Tax Return 2024" has moved to the "TR Filed" stage.')
    expect(decodedHtml).toContain("https://portal.test.local/portal/services")
  })

  it("sends an Italian email when contact language is 'it'", async () => {
    contactFixture = { email: "marco@example.com", full_name: "Marco Rossi", language: "it" }

    const result = await notifyClientOfStageAdvance({
      contact_id: "contact-2",
      service_name: "Formazione LLC",
      stage_name: "Closing",
    })

    expect(result).toEqual({ sent: 1, failed: 0 })
    const raw = decodeRaw(gmailPostMock.mock.calls[0][1])
    const subjectMatch = raw.match(/Subject: =\?utf-8\?B\?([^?]+)\?=/)
    const decodedSubject = Buffer.from(subjectMatch![1], "base64").toString("utf8")
    expect(decodedSubject).toBe("Aggiornamento servizio: Formazione LLC — Closing")
    const htmlMatch = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/)
    const decodedHtml = Buffer.from(htmlMatch![1], "base64").toString("utf8")
    expect(decodedHtml).toContain("Ciao Marco,")
    expect(decodedHtml).toContain('Il tuo servizio "Formazione LLC" è passato alla fase "Closing".')
  })

  it("defaults to English when contact has no language set", async () => {
    contactFixture = { email: "noone@example.com", full_name: "Noone Anon", language: null }

    await notifyClientOfStageAdvance({
      contact_id: "contact-3",
      service_name: "ITIN",
      stage_name: "ITIN Approved",
    })

    const raw = decodeRaw(gmailPostMock.mock.calls[0][1])
    const htmlMatch = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/)
    const decodedHtml = Buffer.from(htmlMatch![1], "base64").toString("utf8")
    expect(decodedHtml).toContain("Hi Noone,")
  })

  it("returns {sent: 0, failed: 0} when contact has no email", async () => {
    contactFixture = { email: null, full_name: "Ghost", language: "en" }

    const result = await notifyClientOfStageAdvance({
      contact_id: "contact-4",
      service_name: "X",
      stage_name: "Y",
    })

    expect(result).toEqual({ sent: 0, failed: 0 })
    expect(gmailPostMock).not.toHaveBeenCalled()
  })

  it("returns {sent: 0, failed: 0} when neither account_id nor contact_id provided", async () => {
    const result = await notifyClientOfStageAdvance({
      service_name: "X",
      stage_name: "Y",
    })

    expect(result).toEqual({ sent: 0, failed: 0 })
    expect(gmailPostMock).not.toHaveBeenCalled()
  })

  it("fans out to every contact linked via account_contacts when only account_id is provided", async () => {
    accountContactsFixture = [
      { contacts: { email: "owner@example.com", full_name: "Owner One", language: "en" } },
      { contacts: { email: "partner@example.com", full_name: "Partner Two", language: "it" } },
      { contacts: null }, // dropped silently
      { contacts: { email: null, full_name: "No Email", language: "en" } }, // dropped silently
    ]

    const result = await notifyClientOfStageAdvance({
      account_id: "acct-1",
      service_name: "TR",
      stage_name: "TR Completed",
    })

    expect(result).toEqual({ sent: 2, failed: 0 })
    expect(gmailPostMock).toHaveBeenCalledTimes(2)
    const recipients = gmailPostMock.mock.calls.map(c => decodeRaw(c[1]).match(/^To: (.+)$/m)?.[1])
    expect(recipients).toContain("owner@example.com")
    expect(recipients).toContain("partner@example.com")
  })

  it("prefers contact_id over account_id when both are supplied", async () => {
    contactFixture = { email: "specific@example.com", full_name: "Specific", language: "en" }
    accountContactsFixture = [
      { contacts: { email: "shouldnotsend@example.com", full_name: "Other", language: "en" } },
    ]

    const result = await notifyClientOfStageAdvance({
      account_id: "acct-1",
      contact_id: "contact-1",
      service_name: "X",
      stage_name: "Y",
    })

    expect(result).toEqual({ sent: 1, failed: 0 })
    const raw = decodeRaw(gmailPostMock.mock.calls[0][1])
    expect(raw).toContain("To: specific@example.com")
  })

  it("counts gmail failures into the failed bucket without throwing", async () => {
    contactFixture = { email: "broken@example.com", full_name: "Broken", language: "en" }
    gmailPostMock.mockRejectedValueOnce(new Error("gmail 503"))

    const result = await notifyClientOfStageAdvance({
      contact_id: "contact-99",
      service_name: "X",
      stage_name: "Y",
    })

    expect(result).toEqual({ sent: 0, failed: 1 })
  })

  it("HTML-escapes the service name and stage name in the rendered body", async () => {
    contactFixture = { email: "x@example.com", full_name: "X", language: "en" }

    await notifyClientOfStageAdvance({
      contact_id: "contact-x",
      service_name: 'Acme & <Co>',
      stage_name: 'TR "Filed"',
    })

    const raw = decodeRaw(gmailPostMock.mock.calls[0][1])
    const htmlMatch = raw.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/)
    const decodedHtml = Buffer.from(htmlMatch![1], "base64").toString("utf8")
    expect(decodedHtml).toContain("Acme &amp; &lt;Co&gt;")
    expect(decodedHtml).not.toContain("<Co>")
  })
})
