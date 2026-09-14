/**
 * lib/documents/visibility-guard.ts — a personal document (passport/ID/proof of
 * address/BOI report) with no resolved single owner must stay hidden from the
 * portal. Regression pin for dev job f1dc4048 / ece21c44: the process-and-share
 * route used to force it visible anyway, notifying every co-owner on the account
 * by name with no way to retract it.
 */

import { describe, it, expect } from "vitest"
import { isUnresolvedPersonalDocument } from "@/lib/documents/visibility-guard"

const PERSONAL_CATEGORY = 2
const OTHER_CATEGORY = 1 // Company

describe("isUnresolvedPersonalDocument", () => {
  it("is true for a personal document with no resolved contact (the leak this guards against)", () => {
    expect(isUnresolvedPersonalDocument({ category: PERSONAL_CATEGORY, contact_id: null })).toBe(true)
  })

  it("is false once the personal document has a resolved owner", () => {
    expect(isUnresolvedPersonalDocument({ category: PERSONAL_CATEGORY, contact_id: "contact-123" })).toBe(false)
  })

  it("is false for a non-personal category, even with no contact", () => {
    expect(isUnresolvedPersonalDocument({ category: OTHER_CATEGORY, contact_id: null })).toBe(false)
  })

  it("is false when category hasn't been classified yet (null)", () => {
    expect(isUnresolvedPersonalDocument({ category: null, contact_id: null })).toBe(false)
  })

  it("is false for a non-personal category with a contact set", () => {
    expect(isUnresolvedPersonalDocument({ category: OTHER_CATEGORY, contact_id: "contact-123" })).toBe(false)
  })
})
