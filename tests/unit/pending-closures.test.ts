import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { isClosureFormSubmitted, type ClosureSdForCheck, type ClosureSubmissionRow } from "@/lib/portal/pending-closures"

/**
 * lib/portal/pending-closures.ts — "has the closure FORM for this closure SD
 * already been sent?" (Antonio, 2026-09-24 — DoctorGut / Patrick Covelli: the
 * closure entrance nagged a client for months after he had sent the form
 * twice, because an active closure SD was treated as "form still owed").
 */

const CONTACT = "contact-patrick"

const contactOnlySd: ClosureSdForCheck = {
  id: "sd-closure-1",
  account_id: null,
  created_at: "2026-06-01T18:00:23Z",
  source_closure_token: null,
}

function sub(over: Partial<ClosureSubmissionRow>): ClosureSubmissionRow {
  return {
    token: "tok-1",
    account_id: null,
    contact_id: CONTACT,
    status: "completed",
    created_at: "2026-06-09T15:03:43Z",
    ...over,
  }
}

describe("isClosureFormSubmitted", () => {
  it("nothing on file → still owed", () => {
    expect(isClosureFormSubmitted({ sd: contactOnlySd, contactId: CONTACT, progressRows: [], submissions: [] })).toBe(false)
  })

  it("Patrick Covelli shape: legacy progress row with NO service_delivery_id, two completed contact-only submissions made after the SD → submitted", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [{ service_delivery_id: null, status: "submitted" }],
        submissions: [sub({}), sub({ token: "tok-2", created_at: "2026-07-17T10:47:46Z" })],
      }),
    ).toBe(true)
  })

  it("progress row scoped to THIS SD and submitted → submitted", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [{ service_delivery_id: "sd-closure-1", status: "submitted" }],
        submissions: [],
      }),
    ).toBe(true)
  })

  it("progress row for a DIFFERENT closure, or only in_progress → still owed", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [
          { service_delivery_id: "sd-other", status: "submitted" },
          { service_delivery_id: "sd-closure-1", status: "in_progress" },
        ],
        submissions: [],
      }),
    ).toBe(false)
  })

  it("an OLD submission made before this closure SD existed does not count (second closure for the same person)", () => {
    const laterSd = { ...contactOnlySd, id: "sd-closure-2", created_at: "2026-09-01T00:00:00Z" }
    expect(
      isClosureFormSubmitted({ sd: laterSd, contactId: CONTACT, progressRows: [], submissions: [sub({})] }),
    ).toBe(false)
  })

  it("SD auto-created FROM a submission (source_closure_token) counts even though the submission predates the SD", () => {
    const autoSd = { ...contactOnlySd, created_at: "2026-06-10T00:00:00Z", source_closure_token: "tok-1" }
    expect(
      isClosureFormSubmitted({ sd: autoSd, contactId: CONTACT, progressRows: [], submissions: [sub({})] }),
    ).toBe(true)
  })

  it("a draft / not-completed submission does not count", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [],
        submissions: [sub({ status: "pending" }), sub({ status: null })],
      }),
    ).toBe(false)
  })

  it("'reviewed' counts as sent", () => {
    expect(
      isClosureFormSubmitted({ sd: contactOnlySd, contactId: CONTACT, progressRows: [], submissions: [sub({ status: "reviewed" })] }),
    ).toBe(true)
  })

  it("contact-only closure is NOT satisfied by a submission tied to an account (a different company)", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [],
        submissions: [sub({ account_id: "acct-x" })],
      }),
    ).toBe(false)
  })

  it("account closure is satisfied only by a submission for that same account", () => {
    const accountSd: ClosureSdForCheck = { ...contactOnlySd, account_id: "acct-1" }
    expect(
      isClosureFormSubmitted({ sd: accountSd, contactId: CONTACT, progressRows: [], submissions: [sub({ account_id: "acct-2" })] }),
    ).toBe(false)
    expect(
      isClosureFormSubmitted({ sd: accountSd, contactId: CONTACT, progressRows: [], submissions: [sub({ account_id: "acct-1", contact_id: "someone-else" })] }),
    ).toBe(true)
  })

  it("another person's contact-only submission never counts", () => {
    expect(
      isClosureFormSubmitted({
        sd: contactOnlySd,
        contactId: CONTACT,
        progressRows: [],
        submissions: [sub({ contact_id: "contact-other" })],
      }),
    ).toBe(false)
  })

  it("two contact-only closures for the same person: an unlinked submission can't be attributed, so the legacy rule declines for BOTH (card stays) — never clears the wrong one", () => {
    const a = { ...contactOnlySd, id: "sd-a", created_at: "2026-06-01T00:00:00Z" }
    const b = { ...contactOnlySd, id: "sd-b", created_at: "2026-06-02T00:00:00Z" }
    const submissions = [sub({ created_at: "2026-06-09T00:00:00Z" })]
    expect(isClosureFormSubmitted({ sd: a, contactId: CONTACT, progressRows: [], submissions, allSds: [a, b] })).toBe(false)
    expect(isClosureFormSubmitted({ sd: b, contactId: CONTACT, progressRows: [], submissions, allSds: [a, b] })).toBe(false)
  })

  it("…but a closure proven by its own SD-scoped progress row still clears while its sibling stays owed", () => {
    const a = { ...contactOnlySd, id: "sd-a" }
    const b = { ...contactOnlySd, id: "sd-b" }
    const progressRows = [{ service_delivery_id: "sd-a", status: "submitted" }]
    expect(isClosureFormSubmitted({ sd: a, contactId: CONTACT, progressRows, submissions: [], allSds: [a, b] })).toBe(true)
    expect(isClosureFormSubmitted({ sd: b, contactId: CONTACT, progressRows, submissions: [], allSds: [a, b] })).toBe(false)
  })

  it("a contact-only sibling does not block the legacy rule for an ACCOUNT closure (different scope)", () => {
    const acct = { ...contactOnlySd, id: "sd-acct", account_id: "acct-1" }
    const other = { ...contactOnlySd, id: "sd-contact" }
    expect(
      isClosureFormSubmitted({ sd: acct, contactId: CONTACT, progressRows: [], submissions: [sub({ account_id: "acct-1" })], allSds: [acct, other] }),
    ).toBe(true)
  })

  it("legacy emailed link: row created BEFORE the SD but completed after it → counts (uses completed_at)", () => {
    const sd = { ...contactOnlySd, created_at: "2026-06-05T00:00:00Z" }
    expect(
      isClosureFormSubmitted({ sd, contactId: CONTACT, progressRows: [], submissions: [sub({ created_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-10T00:00:00Z" })] }),
    ).toBe(true)
  })

  it("a submission already claimed by ANOTHER closure's source token never clears this one", () => {
    const own = { ...contactOnlySd, id: "sd-own" }
    const autoCreated = { ...contactOnlySd, id: "sd-auto", account_id: "acct-9", source_closure_token: "tok-claimed" }
    expect(
      isClosureFormSubmitted({ sd: own, contactId: CONTACT, progressRows: [], submissions: [sub({ token: "tok-claimed" })], allSds: [own, autoCreated] }),
    ).toBe(false)
  })
})
