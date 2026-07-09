import { describe, it, expect } from "vitest"
import { buildReferrerLinkedCopy } from "@/lib/operations/referral-notify"

describe("buildReferrerLinkedCopy", () => {
  it("builds Italian copy with a first-name greeting", () => {
    const c = buildReferrerLinkedCopy("it", "Marco")
    expect(c.greeting).toBe("Ciao Marco,")
    expect(c.subject).toContain("segnalazione")
    expect(c.ctaLabel).toBe("Vai al Portale")
    // Privacy: never names the referred person.
    expect(c.chat.toLowerCase()).not.toContain("amin")
  })

  it("builds English copy and falls back to a generic greeting without a name", () => {
    const c = buildReferrerLinkedCopy("en", null)
    expect(c.greeting).toBe("Hi,")
    expect(c.subject).toBe("Thank you for your referral")
    expect(c.ctaLabel).toBe("Go to Portal")
  })

  it("keeps the referred person unnamed in both locales", () => {
    for (const loc of ["en", "it"] as const) {
      const c = buildReferrerLinkedCopy(loc, "Test")
      expect(c.body).toBeTruthy()
      expect(c.chat).toBeTruthy()
    }
  })
})
