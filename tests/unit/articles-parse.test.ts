import { describe, it, expect } from "vitest"
import { parseFormationDate, tryParseDate, parseArticlesText, parseFilingId, normalizeFilingId } from "@/lib/articles-parse"

// Real OCR text from the NM SoS Articles of Organization (AI Venture Labs LLC).
const NM_ARTICLES = `STATE OF NEW MEXICO Secretary of State
ARTICLES OF ORGANIZATION - DOMESTIC LLC
New Mexico Secretary of State
-FILED-
File #: 3252197
Date Filed: 6/16/2026
Name of the Organization
Limited Liability Company Name
AI Venture Labs LLC
Filing Effective Date
The formation of the LLC will be effective When filed by the Secretary of State.
C0633-3055 06/16/2026 6:03 AM Received by New Mexico Secretary of State`

describe("parseFormationDate", () => {
  it("parses the NM 'Date Filed: M/D/YYYY' header (the format the old parser missed)", () => {
    expect(parseFormationDate(NM_ARTICLES)).toBe("2026-06-16")
  })

  it("parses 'this N day of Month YYYY' from an acceptance/signature block", () => {
    // OCR splits the year across lines as "June\n20 26." — the day-of pattern keys off the day+month.
    expect(parseFormationDate("accept the appointment as registered agent this 18 day of June 2026")).toBe("2026-06-18")
  })

  it("parses 'Filing Date:' and 'Effective Date:' forms", () => {
    expect(parseFormationDate("Filing Date: 03/24/2026")).toBe("2026-03-24")
    expect(parseFormationDate("Effective Date: March 9, 2026")).toBe("2026-03-09")
  })

  it("returns null when no date is present", () => {
    expect(parseFormationDate("no dates here at all")).toBeNull()
  })
})

describe("tryParseDate", () => {
  it("handles slash, dash, 2-digit year, and named months", () => {
    expect(tryParseDate("6/16/2026")).toBe("2026-06-16")
    expect(tryParseDate("06-16-26")).toBe("2026-06-16")
    expect(tryParseDate("June 16, 2026")).toBe("2026-06-16")
    expect(tryParseDate("18 day of June 2026")).toBe("2026-06-18")
  })
})

describe("parseArticlesText (full)", () => {
  it("extracts company name, state, and the filed date from real NM Articles", () => {
    const parsed = parseArticlesText(NM_ARTICLES)
    expect(parsed.formation_date).toBe("2026-06-16")
    expect(parsed.state_of_formation).toBe("New Mexico")
    expect(parsed.company_name).toContain("AI Venture Labs LLC")
    expect(parsed.filing_id).toBe("3252197")
  })
})

// Job 64d2be64 — the state Filing ID. The layouts below are SYNTHETIC (wording and shapes copied from the label forms found on
// 100 real stored Articles; no client text is in the repo). The reader was measured on those 100 real Articles: every ID an Articles
// prints was read right; the misses were Articles whose text carries no readable ID.
describe("parseFilingId — each state's wording", () => {
  it("Wyoming: 'Original ID: YYYY-NNNNNNNNN' (also with OCR spaces around the dash)", () => {
    expect(parseFilingId("Wyoming Secretary of State FILED: Jan 9 2025 9:21AM Original ID: 2025-001586941\nLimited Liability Company")).toBe("2025-001586941")
    expect(parseFilingId("FILED: Jan 9 2025 Original ID: 2025 - 001586941")).toBe("2025-001586941")
    expect(parseFilingId("Filing ID: 2026-002103965")).toBe("2026-002103965")
  })

  it("Florida: the L + 11 digits document-number stamp, also after 'Document Number'", () => {
    expect(parseFilingId("The name of the Limited Liability Company is: ACME LLC\nL26000009149\nFILED 8:00 AM January 13, 2026")).toBe("L26000009149")
    expect(parseFilingId("Document Number: L26000009149")).toBe("L26000009149")
  })

  it("New Mexico: 'File #:' and 'Filing Number:' labels", () => {
    expect(parseFilingId("New Mexico Secretary of State -FILED- File #: 3190157 Date Filed: 4/14/2026")).toBe("3190157")
    expect(parseFilingId("Office of the New Mexico Secretary of State Filing Number: 0002313166\nFiled On: 2/23/2023")).toBe("0002313166")
  })

  it("New Mexico: the stamp number the OCR printed WITHOUT its label — and never the registered agent's own id next to it", () => {
    const afterRa = 'Registered Agent Registered Agents Inc (4424925 BA) Non-Commercial Agent Address 1\nWhen filed by the Secretary of State. 3176962 ---PAGE BREAK--- I understand that the information'
    expect(parseFilingId(afterRa)).toBe("3176962")
    expect(parseFilingId("Certificate of Organization OF Horus LLC 7221592 New Mexico The Office of the Secretary of State certifies")).toBe("7221592")
  })

  it("Delaware: 'File Number 6462038'", () => {
    expect(parseFilingId("SR 20214037415 File Number 6462038 STATE of DELAWARE")).toBe("6462038")
  })

  it("the label wins over a distinctive shape elsewhere in the text", () => {
    expect(parseFilingId("Registered agent ref L20000174645\nFile #: 3190157")).toBe("3190157")
  })
})

describe("parseFilingId — never guesses", () => {
  it("returns null when the text carries no Filing ID", () => {
    expect(parseFilingId("")).toBeNull()
    expect(parseFilingId("Articles of Organization of Acme LLC. The purpose of the company is any lawful business.")).toBeNull()
  })

  it("does not take a phone number, an EIN or a bare long number just because it follows the word 'number'", () => {
    expect(parseFilingId("Telephone Number: 5051234567\nEIN number 352988585\nTotal Number of Pages: 1 of 3")).toBeNull()
  })

  it("does not take a plain date or a lone registered-agent id as a Filing ID", () => {
    expect(parseFilingId("Date Filed: 2026-03-24\nRegistered Agents Inc (4424925 BA)")).toBeNull()
  })

  it("is safe on non-string input", () => {
    expect(parseFilingId(undefined as unknown as string)).toBeNull()
    expect(parseFilingId(null as unknown as string)).toBeNull()
  })

  it("parseArticlesText carries the same Filing ID (one rule, no second copy)", () => {
    expect(parseArticlesText("Wyoming Secretary of State Original ID: 2025-001586941").filing_id).toBe("2025-001586941")
    expect(parseArticlesText("Articles of Organization of Acme LLC").filing_id).toBeNull()
  })
})

describe("normalizeFilingId — what staff typed, tidied for saving", () => {
  it("trims, upper-cases and closes the spaces around a dash", () => {
    expect(normalizeFilingId("  2026-002103965 ")).toBe("2026-002103965")
    expect(normalizeFilingId("2026 - 002103965")).toBe("2026-002103965")
    expect(normalizeFilingId("l26000009149")).toBe("L26000009149")
    expect(normalizeFilingId("3190157")).toBe("3190157")
  })

  it("refuses anything that is not a plausible ID (no silent half-saves)", () => {
    expect(normalizeFilingId("")).toBeNull()
    expect(normalizeFilingId("   ")).toBeNull()
    expect(normalizeFilingId("abc")).toBeNull()
    expect(normalizeFilingId("NOTANUMBER")).toBeNull() // no digit
    expect(normalizeFilingId("2026/002103965")).toBeNull() // a slash
    expect(normalizeFilingId("12 345")).toBeNull() // a space inside
    expect(normalizeFilingId("1".repeat(31))).toBeNull() // too long
    expect(normalizeFilingId(42 as unknown as string)).toBeNull()
    expect(normalizeFilingId(undefined)).toBeNull()
  })
})
