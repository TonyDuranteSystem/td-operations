import { describe, it, expect } from "vitest"
import { assessPair, isMaterialToken, isMarkLike, normHash } from "@/lib/crm-store/understand/duplicates"

const LEASE = "RENT OFFICE AGREEMENT This Virtual Office Agreement is effective as of 03/10/2024 between Tony Durante LLC and DIECI DIECI COMPANY LLC. Rent is $150.00 per month. " + "clause ".repeat(300) + "Title:Owner Tenant By: (Signature) Mario Cerbone"

describe("what counts as a real number or date", () => {
  it.each(["$8,000", "800", "03/10/2024", "2025", "5", "12%", "(150)", "10:30"])("%s is material", (t) => expect(isMaterialToken(t)).toBe(true))
  it.each(["ΑΣ", "Α2", "Title:Owner", "Tenant", "A1", "x", "Sept."])("%s is not", (t) => expect(isMaterialToken(t)).toBe(false))
})

describe("are two files the same document — accuracy set", () => {
  it("identical bytes", () => expect(assessPair("a", "b", { sameBytes: true }).verdict).toBe("same_bytes"))
  it("a re-saved copy with different spacing is the same words", () => {
    expect(assessPair(LEASE, LEASE.replace(/ /g, "  ").replace("Rent is", "Rent\nis")).verdict).toBe("same_words")
  })
  it("the real Dieci Dieci case: two stray signature marks are minor, for a person to confirm — never silently 'same'", () => {
    const r = assessPair(LEASE.replace("Title:Owner", "ΑΣ Α2 Title:Owner"), LEASE)
    expect(r.verdict).toBe("minor_marks")
    expect(r.note).toMatch(/ΑΣ Α2/)
  })
  it("$150.00 vs $160.00 is different even though it is one word in 300", () => {
    const r = assessPair(LEASE, LEASE.replace("$150.00", "$160.00"))
    expect(r.verdict).toBe("different_words")
    expect(r.materialDifferences.length).toBeGreaterThan(0)
  })
  it("$8,000 vs $800 is different", () => expect(assessPair("Total due $8,000 today " + "w ".repeat(400), "Total due $800 today " + "w ".repeat(400)).verdict).toBe("different_words"))
  it("a changed date is different", () => expect(assessPair(LEASE, LEASE.replace("03/10/2024", "03/11/2024")).verdict).toBe("different_words"))
  it("a changed name (non-numeric) beyond the tiny budget is different", () => {
    const b = LEASE.replace("Mario Cerbone", "Luigi Rossi Bianchi Verdi Neri Gialli Blu")
    expect(assessPair(LEASE, b).verdict).toBe("different_words")
  })
  it("unrelated documents are different", () => expect(assessPair("alpha ".repeat(4000), "omega ".repeat(4000)).verdict).toBe("different_words"))
  it("no readable words in one file → not compared, never 'same'", () => expect(assessPair("", LEASE).verdict).toBe("not_compared"))
  it("the same words hash the same however they are spaced", () => expect(normHash("a  b\nc")).toBe(normHash("a b c")))
})

describe("noise versus a real change", () => {
  it.each(["ΑΣ", "Α2", "x", "AS", "~~", "|", "Ж"])("%s looks like a mark", (t) => expect(isMarkLike(t)).toBe(true))
  it.each(["Second", "Rossi", "Tenant", "Lessor"])("%s is a real word", (t) => expect(isMarkLike(t)).toBe(false))
  it("a changed company name is a different document, not a stray mark", () => {
    const a = "CERTIFICATE OF FORMATION OF ZZ Test Company LLC " + "State of Delaware ".repeat(80)
    expect(assessPair(a, a.replace("Test", "Second")).verdict).toBe("different_words")
  })
})
