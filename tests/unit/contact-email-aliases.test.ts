import { describe, it, expect } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { contactEmailSet, contactHasEmail, escapeLike, findContactByAnyEmail } from "@/lib/operations/contact-email-aliases"

const c = (over: Record<string, unknown>) => ({ id: "c", full_name: "N", email: null, email_2: null, alt_emails: null, portal_tier: null, merged_into: null, created_at: "2026-01-01T00:00:00Z", ...over })

describe("contactEmailSet", () => {
  it("collects email, email_2 and every alternate address, lowercased, without duplicates or blanks", () => {
    expect(contactEmailSet({ email: "A@x.com", email_2: " b@x.com ", alt_emails: ["c@x.com", "a@x.com", ""] })).toEqual(["a@x.com", "b@x.com", "c@x.com"])
    expect(contactEmailSet({ email: null, email_2: null, alt_emails: null })).toEqual([])
  })
  it("contactHasEmail", () => {
    expect(contactHasEmail({ email: "a@x.com", email_2: "b@x.com", alt_emails: [] }, "B@X.com")).toBe(true)
    expect(contactHasEmail({ email: "a@x.com", email_2: null, alt_emails: [] }, "")).toBe(false)
  })
})

describe("escapeLike", () => {
  it("makes _ % and backslash literal", () => expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d"))
})

describe("findContactByAnyEmail", () => {
  it("finds a person by their primary email, case-insensitively", async () => {
    const r = await findContactByAnyEmail(miniDb({ contacts: [c({ id: "c1", email: "Maria@X.com" })] }), "MARIA@x.com")
    expect(r.state === "found" && r.contact.id).toBe("c1")
  })
  it("finds a person by email_2 — the column today's helpers miss", async () => {
    const r = await findContactByAnyEmail(miniDb({ contacts: [c({ id: "c1", email: "a@x.com", email_2: "second@y.com" })] }), "second@y.com")
    expect(r.state === "found" && r.contact.id).toBe("c1")
  })
  it("finds a person by an alternate (merged) address", async () => {
    const r = await findContactByAnyEmail(miniDb({ contacts: [c({ id: "c1", email: "a@x.com", alt_emails: ["old@z.com"] })] }), "OLD@z.com")
    expect(r.state === "found" && r.contact.id).toBe("c1")
  })
  it("an underscore is not a wildcard: a_b@x.com does not find aXb@x.com", async () => {
    const db = miniDb({ contacts: [c({ id: "c1", email: "aXb@x.com" })] })
    expect((await findContactByAnyEmail(db, "a_b@x.com")).state).toBe("none")
    const db2 = miniDb({ contacts: [c({ id: "c2", email: "a_b@x.com" })] })
    expect((await findContactByAnyEmail(db2, "a_b@x.com")).state).toBe("found")
  })
  it("ignores merged-away records and prefers the oldest contact", async () => {
    const db = miniDb({ contacts: [
      c({ id: "newer", email: "m@x.com", created_at: "2026-05-01T00:00:00Z" }),
      c({ id: "older", email: "m@x.com", created_at: "2026-02-01T00:00:00Z" }),
      c({ id: "gone", email: "m@x.com", created_at: "2025-01-01T00:00:00Z", merged_into: "older" }),
    ] })
    const r = await findContactByAnyEmail(db, "m@x.com")
    expect(r.state === "found" && r.contact.id).toBe("older")
    expect(r.state === "found" && r.others).toBe(1)
  })
  it("no match, blank input = none", async () => {
    expect((await findContactByAnyEmail(miniDb({ contacts: [c({ email: "a@x.com" })] }), "zzz@x.com")).state).toBe("none")
    expect((await findContactByAnyEmail(miniDb(), "  ")).state).toBe("none")
  })
  it("a database error is reported as an error, never as 'no such person'", async () => {
    expect(await findContactByAnyEmail(miniDb({}, { failing: { contacts: "db down" } }), "a@x.com")).toEqual({ state: "error", message: "db down" })
    expect((await findContactByAnyEmail({ from: () => { throw new Error("boom") } }, "a@x.com")).state).toBe("error")
  })
})
