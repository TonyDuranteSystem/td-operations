/**
 * "Does this payment actually name this client?" — the rule that replaced
 * "did ANY one word of the name appear anywhere in the payment text".
 *
 * The fixtures are REAL production strings from the 2026-07-22 incident and from the Chase
 * alert that proved the correct client had paid by Zelle. They pin a literal name universe
 * deliberately: a fixture that read the live client list would change behaviour every time a
 * client is added, which is precisely the property this design was chosen to avoid.
 */

import { describe, it, expect } from "vitest"
import {
  evaluateNameEvidence,
  bestNameEvidence,
  nameSignificantWords,
  normalizeNameText,
  NAME_COVERAGE_THRESHOLD,
  NAME_STOP_WORDS,
} from "@/lib/finance/feed-signals"

// The exact text on the Mercury wire that was credited to the wrong company.
const LC_WIRE = [
  "LC Marketing Consulting",
  "LC Marketing Consulting — From LC Marketing Consulting via mercury.com",
  "From LC Marketing Consulting via mercury.com",
]

describe("the 2026-07-22 wrong-client match", () => {
  it("does NOT accept the wire as naming Aces Marketing Solutions", () => {
    // This is the whole bug: "marketing" is the only word the two companies share, and it
    // used to be enough to score top confidence and auto-settle Aces' invoice.
    const ev = evaluateNameEvidence("Aces Marketing Solutions LLC", LC_WIRE)
    expect(ev.sufficient).toBe(false)
    expect(ev.matchedWords).toEqual([])
  })

  it("does NOT accept the wire as naming LC Marketing Consulting either", () => {
    // Deliberate, and it corrects the first draft of this fix. Every word of LC's name is
    // either too short ("lc") or generic ("marketing", "consulting", "llc"), so the name
    // cannot identify them. If it could, a wire from ANY other company with "marketing" in
    // its name would settle LC's invoice — the same bug pointed at a different victim.
    const ev = evaluateNameEvidence("LC Marketing Consulting LLC", LC_WIRE)
    expect(ev.words).toEqual([])
    expect(ev.sufficient).toBe(false)
  })

  it("treats 'marketing' as generic — it cannot carry identity on its own", () => {
    expect(NAME_STOP_WORDS.has("marketing")).toBe(true)
  })
})

describe("legitimate matches that must keep working", () => {
  it("recognises the real Zelle payer string for Aces", () => {
    // The Chase alert that proved Aces had genuinely paid printed the payer as
    // "ACES MEDICAL MARKETING & CONSULTANCY" — not their registered name. A rule demanding
    // the full legal name would have broken this, which is why coverage is measured against
    // the client's SIGNIFICANT words only.
    const ev = evaluateNameEvidence("Aces Marketing Solutions LLC", [
      "ACES MEDICAL MARKETING & CONSULTANCY",
    ])
    expect(ev.words).toEqual(["aces"])
    expect(ev.matchedWords).toEqual(["aces"])
    expect(ev.coverage).toBe(1)
    expect(ev.sufficient).toBe(true)
  })

  it("a single distinctive word is full coverage", () => {
    // "GScaling International LLC" reduces to one significant word; naming it is naming them.
    const ev = evaluateNameEvidence("GScaling International LLC", ["GSCALING INTERNATIONAL LLC"])
    expect(ev.sufficient).toBe(true)
  })

  it("folds diacritics, so a bank printing ASCII still matches its own client", () => {
    const ev = evaluateNameEvidence("Café Móvil Studio", ["CAFE MOVIL STUDIO"])
    expect(ev.sufficient).toBe(true)
  })

  it("but folding cannot hand one client's payment to a similarly-named other", () => {
    // "Cafe Central" shares only "cafe" with the payer text — half its name — so folding
    // makes the words comparable without making the evidence sufficient.
    const ev = evaluateNameEvidence("Cafe Central Studio", ["CAFE MOVIL"])
    expect(ev.matchedWords).toEqual(["cafe"])
    expect(ev.sufficient).toBe(false)
    expect(ev.weak).toBe(true)
  })
})

describe("coverage arithmetic", () => {
  it("two significant words require both", () => {
    const one = evaluateNameEvidence("Alpha Bravo Studio", ["payment from alpha"])
    expect(one.coverage).toBeCloseTo(1 / 3)
    expect(one.sufficient).toBe(false)

    const all = evaluateNameEvidence("Alpha Bravo Studio", ["alpha bravo studio"])
    expect(all.coverage).toBe(1)
    expect(all.sufficient).toBe(true)
  })

  it("two of three significant words clears the bar", () => {
    const ev = evaluateNameEvidence("Alpha Bravo Charlie", ["alpha bravo"])
    expect(ev.coverage).toBeCloseTo(2 / 3)
    expect(ev.sufficient).toBe(true)
  })

  it("the threshold is injectable so a test pins behaviour, not the constant", () => {
    const strict = evaluateNameEvidence("Alpha Bravo Charlie", ["alpha bravo"], 0.9)
    expect(strict.sufficient).toBe(false)
    expect(NAME_COVERAGE_THRESHOLD).toBeGreaterThan(0.5)
    expect(NAME_COVERAGE_THRESHOLD).toBeLessThanOrEqual(1)
  })

  it("a name with no significant words can never be evidence", () => {
    for (const generic of ["Consulting Services LLC", "The Global Group Inc", "LC Co"]) {
      const ev = evaluateNameEvidence(generic, ["consulting services global group lc"])
      expect(ev.words).toEqual([])
      expect(ev.sufficient).toBe(false)
    }
  })
})

describe("word extraction", () => {
  it("drops legal suffixes, generic words and short tokens", () => {
    expect(nameSignificantWords("Nexo Agency LLC")).toEqual(["nexo"])
    expect(nameSignificantWords("LC Marketing Consulting LLC")).toEqual([])
    expect(nameSignificantWords("Aces Marketing Solutions LLC")).toEqual(["aces"])
  })

  it("de-duplicates repeated words so coverage cannot be inflated", () => {
    expect(nameSignificantWords("Kappa Kappa Studio")).toEqual(["kappa", "studio"])
  })

  it("splits on punctuation, not just spaces", () => {
    expect(nameSignificantWords("Vega-Nova, S.r.l.")).toEqual(["vega", "nova"])
  })

  it("matches on word boundaries — 'solution' must not match inside 'solutions'", () => {
    const ev = evaluateNameEvidence("Vertex Studio", ["vertexstudio"])
    expect(ev.matchedWords).toEqual([])
  })

  it("normalizeNameText lowercases and strips accents", () => {
    expect(normalizeNameText("CAFÉ Móvil")).toBe("cafe movil")
  })
})

describe("bestNameEvidence across a pool", () => {
  it("takes the strongest name in the pool (third-party payer paying for their company)", () => {
    const ev = bestNameEvidence(
      ["Aces Marketing Solutions LLC", "Vertex Studio"],
      ["payment from VERTEX STUDIO"],
    )
    expect(ev.sufficient).toBe(true)
    expect(ev.matchedWords).toEqual(["vertex", "studio"])
    expect(ev.coverage).toBe(1)
  })

  it("an empty pool is not evidence", () => {
    expect(bestNameEvidence([], ["anything"]).sufficient).toBe(false)
    expect(bestNameEvidence([null, undefined, ""], ["anything"]).sufficient).toBe(false)
  })

  it("no feed text is not evidence", () => {
    expect(bestNameEvidence(["Vertex Studio"], []).sufficient).toBe(false)
    expect(bestNameEvidence(["Vertex Studio"], [null, ""]).sufficient).toBe(false)
  })
})
