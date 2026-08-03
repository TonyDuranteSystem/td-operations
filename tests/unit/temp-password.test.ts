import { describe, it, expect } from "vitest"
import {
  generateTempPassword,
  TEMP_PASSWORD_ALPHABET,
  TEMP_PASSWORD_RANDOM_LENGTH,
} from "@/lib/portal/temp-password"

describe("generateTempPassword", () => {
  it("keeps the familiar TD…! shape staff and clients recognise", () => {
    const pw = generateTempPassword()
    expect(pw.startsWith("TD")).toBe(true)
    expect(pw.endsWith("!")).toBe(true)
    expect(pw).toHaveLength(2 + TEMP_PASSWORD_RANDOM_LENGTH + 1)
  })

  it("clears the portal's 8-character minimum without relying on luck", () => {
    // The reset/change-password pages reject anything under 8 characters.
    // The fixed TD…! wrapper plus 12 random characters means that can never
    // depend on what the generator happened to produce.
    for (let i = 0; i < 50; i++) {
      expect(generateTempPassword().length).toBeGreaterThanOrEqual(8)
    }
  })

  it("uses only the declared alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const middle = generateTempPassword().slice(2, -1)
      for (const ch of middle) {
        expect(TEMP_PASSWORD_ALPHABET).toContain(ch)
      }
    }
  })

  it("never emits the confusable characters 0, o, 1 or l", () => {
    // A client types this by hand out of an email. "Was that a one or an ell?"
    // is a support ticket, and those characters buy almost no entropy.
    const banned = ["0", "o", "1", "l"]
    for (let i = 0; i < 500; i++) {
      const middle = generateTempPassword().slice(2, -1)
      for (const b of banned) {
        expect(middle).not.toContain(b)
      }
    }
  })

  it("does not repeat itself across many mints", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateTempPassword())
    expect(seen.size).toBe(1000)
  })

  it("keeps the alphabet a power of two, with no duplicate symbols", () => {
    // THIS is the property that actually governs bias, and an earlier version of
    // this file got it backwards: it claimed 256 was NOT a multiple of the
    // alphabet size and that the distribution test below guarded against modulo
    // bias. Both were false — 32 divides 256 evenly, so modulo would be unbiased
    // today and the distribution test could not fail when the bug was
    // deliberately reintroduced. Pin the real invariant instead: drop to 31 or
    // grow to 33 and a modulo implementation WOULD skew toward the earliest
    // symbols. randomInt() is unbiased either way; this test protects the
    // margin for anyone who later "simplifies" it.
    expect(TEMP_PASSWORD_ALPHABET).toHaveLength(32)
    expect(TEMP_PASSWORD_ALPHABET.length & (TEMP_PASSWORD_ALPHABET.length - 1)).toBe(0)
    expect(new Set(TEMP_PASSWORD_ALPHABET).size).toBe(TEMP_PASSWORD_ALPHABET.length)
  })

  it("spreads across the whole alphabet rather than sitting on a few symbols", () => {
    // A sanity check on the draw, NOT a modulo-bias guard (see above). It would
    // catch a generator stuck on a constant or a truncated alphabet.
    const counts = new Map<string, number>()
    const draws = 20_000
    for (let i = 0; i < draws / TEMP_PASSWORD_RANDOM_LENGTH; i++) {
      for (const ch of generateTempPassword().slice(2, -1)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1)
      }
    }
    // Every symbol must actually appear...
    expect(counts.size).toBe(TEMP_PASSWORD_ALPHABET.length)
    // ...and no symbol may run away with the distribution. Expected share is
    // 1/32 ≈ 3.1%; a modulo-biased generator pushes the low symbols toward 4.7%.
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    for (const [, n] of counts) {
      const share = n / total
      expect(share).toBeGreaterThan(0.015)
      expect(share).toBeLessThan(0.055)
    }
  })
})
