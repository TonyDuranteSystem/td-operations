import { describe, it, expect } from "vitest"
import {
  missingFields, rosterNeedsAttention, applyMemberEdits, rosterProblem, primaryAccess, ownershipTotal, toGapView,
  type RosterMember,
} from "@/lib/members/oa-member-gaps"

const person = (o: Partial<RosterMember> = {}): RosterMember => ({
  id: "m1", member_type: "individual", full_name: "Giulia Schiavoni", company_name: null, email: "g@x.com", ownership_pct: 50,
  address_street: "via Goldoni 4", address_city: "Bologna", address_state: null, address_zip: null, address_country: "Italy",
  representative_name: null, representative_email: null, ...o,
})
const company = (o: Partial<RosterMember> = {}): RosterMember => person({ id: "c1", member_type: "company", full_name: null, company_name: "Acme Ltd", email: null, address_street: null, address_city: null, address_country: null, ...o })

describe("missingFields", () => {
  it("complete individual and company have nothing missing", () => {
    expect(missingFields(person())).toEqual([])
    expect(missingFields(company({ representative_name: "Rep", representative_email: "r@x.com" }))).toEqual([])
  })
  it("lists exactly what an individual lacks", () => {
    expect(missingFields(person({ email: "  ", address_city: null }))).toEqual(["email", "address_city"])
  })
  it("a company needs its representative, not an address", () => {
    expect(missingFields(company())).toEqual(["representative_name", "representative_email"])
  })
  it("a company that signs through its linked contact needs nothing (Azarexa case)", () => {
    expect(missingFields(company({ contact_id: "some-contact" }))).toEqual([])
    expect(missingFields(company({ representative_email: "r@x.com" }))).toEqual([])
  })
})

describe("rosterNeedsAttention", () => {
  it("is false for a complete roster totalling 100", () => {
    expect(rosterNeedsAttention([person({ id: "a" }), person({ id: "b", full_name: "Caterina", email: "c@x.com" })])).toBe(false)
  })
  it("is true when a member lacks something or the total is not 100", () => {
    expect(rosterNeedsAttention([person({ id: "a" }), person({ id: "b", email: null })])).toBe(true)
    expect(rosterNeedsAttention([person({ id: "a", ownership_pct: 60 }), person({ id: "b", full_name: "C", email: "c@x.com" })])).toBe(true)
  })
})

describe("applyMemberEdits", () => {
  it("fills blanks but never rewrites what is already there", () => {
    const [a] = applyMemberEdits([person({ email: "real@x.com", address_city: null })], [{ id: "m1", email: "attacker@x.com", address_city: "Rome" }])
    expect(a.email).toBe("real@x.com")
    expect(a.address_city).toBe("Rome")
  })
  it("replaces ownership percentages", () => {
    const out = applyMemberEdits([person({ id: "a" }), person({ id: "b" })], [{ id: "a", ownership_pct: 70 }, { id: "b", ownership_pct: 30 }])
    expect(ownershipTotal(out)).toBe(100)
  })
  it("ignores edits for unknown ids", () => {
    expect(applyMemberEdits([person()], [{ id: "zzz", email: "x@y.com" }])).toEqual([person()])
  })
})

describe("rosterProblem", () => {
  const ok = [person({ id: "a" }), person({ id: "b", full_name: "Caterina Levoni", email: "c@x.com" })]
  it("is null for a good roster", () => expect(rosterProblem(ok)).toBeNull())
  it("explains a missing field", () => expect(rosterProblem([ok[0], person({ id: "b", full_name: "Caterina", email: null })])).toMatch(/Caterina still needs: email/))
  it("rejects a malformed email", () => expect(rosterProblem([ok[0], { ...ok[1], email: "not-an-email" }])).toMatch(/does not look like an email/))
  it("rejects percentages not totalling 100", () => expect(rosterProblem([{ ...ok[0], ownership_pct: 60 }, ok[1]])).toMatch(/total 110%/))
  it("rejects a zero percentage", () => expect(rosterProblem([{ ...ok[0], ownership_pct: 0 }, { ...ok[1], ownership_pct: 100 }])).toMatch(/more than 0/))
  it("same name must have different emails", () => {
    expect(rosterProblem([person({ id: "a" }), person({ id: "b", full_name: "giulia  schiavoni", email: "G@x.com" })])).toMatch(/same name must have different emails/)
  })
  it("an old malformed email the client could not edit does not block them", () => {
    const roster = [{ ...ok[0], email: "old@gmailcom" }, ok[1]]
    expect(rosterProblem(roster, { typedEmailIds: new Set(["b"]) })).toBeNull()
    expect(rosterProblem(roster, { typedEmailIds: new Set(["a"]) })).toMatch(/does not look like an email/)
  })
  it("members with no email on the row are not compared for duplicates", () => {
    const a = company({ id: "x", contact_id: "c1", company_name: "Acme Ltd" })
    const b = company({ id: "y", contact_id: "c2", company_name: "Acme Ltd" })
    expect(rosterProblem([{ ...a, ownership_pct: 50 }, { ...b, ownership_pct: 50 }])).toBeNull()
  })
  it("same name with a different email is fine", () => {
    expect(rosterProblem([person({ id: "a" }), person({ id: "b", email: "other@x.com" })])).toBeNull()
  })
})

describe("primaryAccess", () => {
  const rows = [
    { is_primary: true, contact_id: "c-giulia", email: "g@x.com", representative_email: null },
    { is_primary: false, contact_id: "c-cat", email: "c@x.com", representative_email: null },
  ]
  it("primary by contact id or by email", () => {
    expect(primaryAccess(rows, { contactId: "c-giulia", email: null })).toBe("primary")
    expect(primaryAccess(rows, { contactId: "other", email: "G@x.com" })).toBe("primary")
  })
  it("a non-primary owner is refused", () => expect(primaryAccess(rows, { contactId: "c-cat", email: "c@x.com" })).toBe("not_primary"))
  it("with nobody primary, the flagged signer stands in", () => {
    const r = [{ is_primary: false, is_signer: true, contact_id: "c-s", email: "s@x.com", representative_email: null }, { is_primary: false, is_signer: false, contact_id: "c-o", email: "o@x.com", representative_email: null }]
    expect(primaryAccess(r, { contactId: "c-s", email: null })).toBe("primary")
    expect(primaryAccess(r, { contactId: "c-o", email: "o@x.com" })).toBe("not_primary")
  })
  it("no primary row is reported as such", () => expect(primaryAccess([{ ...rows[1] }], { contactId: "c-cat", email: "c@x.com" })).toBe("no_primary"))
})

describe("toGapView", () => {
  it("carries what the pop-up needs", () => {
    const v = toGapView(person({ email: null }))
    expect(v.missing).toEqual(["email"])
    expect(v.name).toBe("Giulia Schiavoni")
  })
})
