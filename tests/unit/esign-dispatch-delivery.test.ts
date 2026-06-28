import { describe, it, expect } from "vitest"
import { decideSignerChannel } from "@/lib/esign/dispatch-delivery"

describe("decideSignerChannel", () => {
  it("CRM client with a portal login → portal", () => {
    expect(decideSignerChannel({ contactId: "c1", email: "a@b.com", hasPortalLogin: true })).toBe("portal")
  })

  it("CRM client with a portal login but no email on file → still portal (portal needs no email)", () => {
    expect(decideSignerChannel({ contactId: "c1", email: null, hasPortalLogin: true })).toBe("portal")
  })

  it("CRM client WITHOUT a portal login but with an email → email fallback", () => {
    expect(decideSignerChannel({ contactId: "c1", email: "a@b.com", hasPortalLogin: false })).toBe("email")
  })

  it("CRM client WITHOUT a portal login and no email → undeliverable", () => {
    expect(decideSignerChannel({ contactId: "c1", email: null, hasPortalLogin: false })).toBe("none")
  })

  it("third party (no contact) with an email → email", () => {
    expect(decideSignerChannel({ contactId: null, email: "third@party.com", hasPortalLogin: false })).toBe("email")
  })

  it("third party with a blank/whitespace email → undeliverable", () => {
    expect(decideSignerChannel({ contactId: null, email: "   ", hasPortalLogin: false })).toBe("none")
  })

  it("no contact and no email → undeliverable", () => {
    expect(decideSignerChannel({ contactId: undefined, email: undefined, hasPortalLogin: false })).toBe("none")
  })

  it("hasPortalLogin is ignored without a contact link (third parties never use the portal)", () => {
    expect(decideSignerChannel({ contactId: null, email: "x@y.com", hasPortalLogin: true })).toBe("email")
  })
})
