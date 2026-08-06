import { describe, it, expect } from "vitest"
import {
  decideCallLinks,
  isInternalEmail,
  normalizeAttendeeEmail,
} from "@/lib/circleback/link-call"

describe("circleback link decision (WS-D, dev job c0a61e44)", () => {
  describe("normalizeAttendeeEmail", () => {
    it("lowercases and trims; null for blanks/non-emails/notetaker entries", () => {
      expect(normalizeAttendeeEmail(" Info@Luvain.IT ")).toBe("info@luvain.it")
      expect(normalizeAttendeeEmail("")).toBe(null)
      expect(normalizeAttendeeEmail("   ")).toBe(null)
      expect(normalizeAttendeeEmail("Alessandro Della B.")).toBe(null)
      expect(normalizeAttendeeEmail(null)).toBe(null)
      expect(normalizeAttendeeEmail(undefined)).toBe(null)
    })
  })

  describe("isInternalEmail", () => {
    it("excludes the company domain (Antonio is on every call)", () => {
      expect(isInternalEmail("antonio.durante@tonydurante.us")).toBe(true)
      expect(isInternalEmail("support@tonydurante.us")).toBe(true)
    })
    it("excludes the explicit non-domain internals (partner)", () => {
      expect(isInternalEmail("cristian@sirioos.design")).toBe(true)
    })
    it("keeps real client emails", () => {
      expect(isInternalEmail("info@luvain.it")).toBe(false)
    })
  })

  describe("decideCallLinks", () => {
    const antonio = { email: "antonio.durante@tonydurante.us" }
    const notetaker = { email: null }

    it("one lead identity → links the lead (the Alessandro case pre-conversion)", () => {
      const d = decideCallLinks([antonio, notetaker, { email: "Info@Luvain.it" }], {
        leads: [{ id: "lead-1", email: "info@luvain.it" }],
        contacts: [],
      })
      expect(d).toMatchObject({ lead_id: "lead-1", contact_id: null, review: null })
    })

    it("lead AND contact on the same email = ONE identity — links both ids (post-conversion)", () => {
      const d = decideCallLinks([antonio, { email: "info@luvain.it" }], {
        leads: [{ id: "lead-1", email: "info@luvain.it" }],
        contacts: [{ id: "contact-1", email: "INFO@luvain.it" }],
      })
      expect(d).toMatchObject({ lead_id: "lead-1", contact_id: "contact-1", review: null })
    })

    it("two co-founders matching two distinct identities → refuses with a review reason", () => {
      const d = decideCallLinks(
        [antonio, { email: "a@x.com" }, { email: "b@y.com" }],
        {
          leads: [{ id: "lead-a", email: "a@x.com" }],
          contacts: [{ id: "contact-b", email: "b@y.com" }],
        },
      )
      expect(d.lead_id).toBe(null)
      expect(d.contact_id).toBe(null)
      expect(d.review).toContain("2 distinct client identities")
    })

    it("duplicate rows behind one email (two contacts) → refuses rather than picks", () => {
      const d = decideCallLinks([{ email: "dup@x.com" }], {
        leads: [],
        contacts: [
          { id: "c1", email: "dup@x.com" },
          { id: "c2", email: "dup@x.com" },
        ],
      })
      expect(d.contact_id).toBe(null)
      expect(d.review).toContain("2 contacts")
    })

    it("only internal + notetaker attendees → no links, no review (nothing to match)", () => {
      const d = decideCallLinks([antonio, notetaker, { email: "cristian@sirioos.design" }], {
        leads: [],
        contacts: [],
      })
      expect(d).toMatchObject({ lead_id: null, contact_id: null, review: null })
      expect(d.client_emails).toEqual([])
    })

    it("an internal email that somehow exists as a contact row is never matched (excluded before matching)", () => {
      const d = decideCallLinks([antonio], {
        leads: [],
        contacts: [{ id: "c-staff", email: "antonio.durante@tonydurante.us" }],
      })
      expect(d.contact_id).toBe(null)
    })

    it("no candidates for a real external email → no links, no review (unknown caller, status quo)", () => {
      const d = decideCallLinks([{ email: "stranger@nowhere.com" }], { leads: [], contacts: [] })
      expect(d).toMatchObject({ lead_id: null, contact_id: null, review: null })
      expect(d.client_emails).toEqual(["stranger@nowhere.com"])
    })
  })
})

describe("ILIKE near-collision defense (hunter finding 3)", () => {
  it("a candidate whose own email is NOT exactly an attendee email is dropped (anna_rossi vs anna.rossi)", () => {
    const d = decideCallLinks([{ email: "anna_rossi@gmail.com" }], {
      leads: [{ id: "L-wrong", email: "anna.rossi@gmail.com" }],
      contacts: [],
    })
    expect(d.lead_id).toBe(null)
    expect(d.review).toBe(null) // no identity — plain no-match, not ambiguity
  })
})
