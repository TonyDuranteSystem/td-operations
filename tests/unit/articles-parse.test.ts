import { describe, it, expect } from "vitest"
import { parseFormationDate, tryParseDate, parseArticlesText } from "@/lib/articles-parse"

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
