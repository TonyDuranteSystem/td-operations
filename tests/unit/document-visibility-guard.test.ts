/**
 * lib/documents/visibility-guard.ts — a personal document (passport/ID/proof of
 * address/BOI report) with no resolved single owner must stay hidden from the
 * portal. Pins the PURE PREDICATE's arithmetic only — it says nothing about
 * which call sites actually invoke it (three do; see the module's own header
 * comment). For the call-site-level regression — process-and-share's two
 * branches used to force it visible anyway, and toggleDocumentPortalVisibility
 * was still unguarded on the first pass at this fix (dev job f1dc4048 /
 * ece21c44) — see tests/unit/toggle-document-portal-visibility.test.ts.
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
