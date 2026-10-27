/**
 * Job 80cce1cb — the ONE rule for a formation company's legal name. Pure, so it is table-tested hard: the real cases
 * that went wrong in production (Tanto per, Accreditation Training, Art of Profit Academy, Salemark llc) plus the
 * nasty names the reviewers tried (trailing dots, quotes, zero-width spaces, "LLC Partners", Lincoln/Zinc…).
 */
import { describe, it, expect } from "vitest"
import {
  cleanNameText,
  hasValidLlcEnding,
  blockedEndingOf,
  legalNameFor,
  displayLegalName,
  canonicalNameKey,
  sameCompanyName,
  validateConfirmedLegalName,
  resolveFormationLegalName,
  MAX_LEGAL_NAME_LENGTH,
} from "@/lib/flows/legal-name"
import { newNameEndingProblem } from "@/lib/operations/change-name-apply"

const legal = (s: unknown) => {
  const r = legalNameFor(s)
  return r.ok ? r.name : `REFUSED:${r.reason}`
}

describe("legalNameFor — the table", () => {
  const cases: Array<[string, string]> = [
    // the four real production cases
    ["Tanto per", "Tanto per LLC"],
    ["Accreditation Training", "Accreditation Training LLC"],
    ["Art of Profit Academy", "Art of Profit Academy LLC"],
    ["Salemark llc", "Salemark LLC"],
    // already fine — never doubled
    ["Acme LLC", "Acme LLC"],
    ["Acme, LLC", "Acme, LLC"],
    ["Acme L.L.C.", "Acme L.L.C."],
    ["Acme L.L.C", "Acme L.L.C"],
    ["Acme Limited Liability Company", "Acme Limited Liability Company"],
    ["Acme Limited Liability Co", "Acme Limited Liability Co"],
    ["Acme Limited Company", "Acme Limited Company"],
    ["Acme PLLC", "Acme PLLC"],
    ["Acme LC", "Acme LC"],
    ["Acme L.C.", "Acme L.C."],
    // recase only the plain ending
    ["Acme Llc", "Acme LLC"],
    ["Acme llc", "Acme LLC"],
    ["ACME LLC", "ACME LLC"],
    // stray punctuation / quotes / spaces
    ["Acme LLC.", "Acme LLC"],
    ['"Acme LLC"', '"Acme LLC'],
    ["  Acme   Studio  ", "Acme Studio LLC"],
    ["Acme LLC,", "Acme LLC"],
    ["Acme;", "Acme LLC"],
    // the ending word inside the name is not an ending
    ["LLC Partners", "LLC Partners LLC"],
    ["Acme LLC Holdings", "Acme LLC Holdings LLC"],
    ["Delc", "Delc LLC"],
    ["Pilc", "Pilc LLC"],
    // other words that look like a type but are not
    ["Zinc", "Zinc LLC"],
    ["Yelp", "Yelp LLC"],
    ["Kelp", "Kelp LLC"],
    ["Lincoln Partners", "Lincoln Partners LLC"],
    ["Tapeo Company", "Tapeo Company LLC"],
    ["Acme Co", "Acme Co LLC"],
    ["Acme Co.", "Acme Co LLC"],
    // zero-width / non-breaking space survive nothing
    ["Acme​ LLC", "Acme LLC"],
    ["Acme Studio", "Acme Studio LLC"],
    ["Acme​", "Acme LLC"],
  ]
  it.each(cases)("%j -> %j", (input, expected) => {
    expect(legal(input)).toBe(expected)
  })

  it("refuses a clearly non-LLC type instead of guessing", () => {
    for (const n of ["Acme Inc", "Acme Inc.", "Acme INC", "Acme Incorporated", "Acme Corp", "Acme Corp.", "Acme Corporation", "Acme LP", "Acme L.P.", "Acme LLP", "Acme LLLP", "Acme Ltd", "Acme Ltd.", "Acme Limited"]) {
      const r = legalNameFor(n)
      expect(r.ok, n).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe("blocked_ending")
        expect(r.detail).toContain("not an LLC ending")
      }
    }
  })

  it("refuses an empty / non-string name and an over-long one", () => {
    expect(legalNameFor("")).toMatchObject({ ok: false, reason: "empty" })
    expect(legalNameFor("   ")).toMatchObject({ ok: false, reason: "empty" })
    expect(legalNameFor(null)).toMatchObject({ ok: false, reason: "empty" })
    expect(legalNameFor(42)).toMatchObject({ ok: false, reason: "empty" })
    const long = "A".repeat(MAX_LEGAL_NAME_LENGTH)
    expect(legalNameFor(long)).toMatchObject({ ok: false, reason: "too_long" })
    expect(legalNameFor("A".repeat(MAX_LEGAL_NAME_LENGTH - 4))).toMatchObject({ ok: true })
  })

  it("reports what it did", () => {
    expect(legalNameFor("Acme")).toMatchObject({ ok: true, change: "added" })
    expect(legalNameFor("Acme llc")).toMatchObject({ ok: true, change: "recased" })
    expect(legalNameFor("Acme LLC")).toMatchObject({ ok: true, change: "none" })
    expect(legalNameFor("Acme L.L.C.")).toMatchObject({ ok: true, change: "none" })
  })

  it("is idempotent: f(f(x)) === f(x) for every case above", () => {
    for (const [input] of cases) {
      const once = legalNameFor(input)
      if (!once.ok) continue
      const twice = legalNameFor(once.name)
      expect(twice.ok, input).toBe(true)
      if (twice.ok) {
        expect(twice.name, input).toBe(once.name)
        expect(twice.change, input).toBe("none")
      }
    }
  })
})

describe("endings and blocked endings", () => {
  it("hasValidLlcEnding", () => {
    for (const n of ["Acme LLC", "Acme llc", "Acme, LLC", "Acme L.L.C.", "Acme L L C", "Acme LC", "Acme PLLC", "Acme Limited Liability Company"]) expect(hasValidLlcEnding(n), n).toBe(true)
    for (const n of ["Acme", "Acme Inc", "Delc", "LLC Partners", "", null, undefined, 5]) expect(hasValidLlcEnding(n), String(n)).toBe(false)
  })
  it("blockedEndingOf matches the last word only", () => {
    expect(blockedEndingOf("Acme Inc")).toBe("Inc")
    expect(blockedEndingOf("Acme Corp.")).toBe("Corp")
    expect(blockedEndingOf("Lincoln Group")).toBeNull()
    expect(blockedEndingOf("Zinc")).toBeNull()
    expect(blockedEndingOf("Acme LLC")).toBeNull()
    expect(blockedEndingOf("Acme Inc LLC")).toBeNull() // already a valid LLC ending
  })
})

describe("displayLegalName — total, never refuses", () => {
  it("adds the ending for display, leaves a refused name as it is", () => {
    expect(displayLegalName("Tanto per")).toBe("Tanto per LLC")
    expect(displayLegalName("Acme L.L.C.")).toBe("Acme L.L.C.") // the old regex made "Acme L.L.C. LLC"
    expect(displayLegalName("Pinnacle Corp")).toBe("Pinnacle Corp")
    expect(displayLegalName("")).toBe("")
    expect(displayLegalName(undefined)).toBe("")
  })
})

describe("canonicalNameKey / sameCompanyName", () => {
  it("capitals, punctuation, accents and the ending do not make a different company", () => {
    expect(sameCompanyName("Tanto per", "Tanto Per LLC")).toBe(true)
    expect(sameCompanyName("TANTO PER, L.L.C.", "tanto per llc")).toBe(true)
    expect(sameCompanyName("Café Nero", "Cafe Nero LLC")).toBe(true)
    expect(sameCompanyName("Smith & Sons", "Smith and Sons")).toBe(false) // a different WORD
    expect(sameCompanyName("Acme LLC LLC", "Acme")).toBe(true)
  })
  it("a different word is a different company", () => {
    expect(sameCompanyName("Tanto per", "Tanto per Italia LLC")).toBe(false)
    expect(sameCompanyName("Acme", "Acme Holdings")).toBe(false)
  })
  it("an empty / ending-only name has no key and matches nothing", () => {
    expect(canonicalNameKey("")).toBe("")
    expect(canonicalNameKey("LLC")).toBe("")
    expect(sameCompanyName("", "")).toBe(false)
    expect(sameCompanyName("LLC", "LLC")).toBe(false)
  })
})

describe("validateConfirmedLegalName — what staff confirmed on the Articles window", () => {
  it("keeps exactly what staff confirmed (no recasing, no decorating)", () => {
    expect(validateConfirmedLegalName({ confirmed: "Tanto Per LLC", referenceName: "Tanto per" })).toEqual({ ok: true, name: "Tanto Per LLC" })
    expect(validateConfirmedLegalName({ confirmed: "Acme llc", referenceName: "Acme" })).toEqual({ ok: true, name: "Acme llc" })
    expect(validateConfirmedLegalName({ confirmed: "Acme L.L.C.", referenceName: "Acme" })).toEqual({ ok: true, name: "Acme L.L.C." })
  })
  it("needs a valid ending — never silently adds one", () => {
    const r = validateConfirmedLegalName({ confirmed: "Tanto Per", referenceName: "Tanto per" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("must end in LLC")
  })
  it("names a non-LLC ending", () => {
    const r = validateConfirmedLegalName({ confirmed: "Acme Inc", referenceName: "Acme Inc" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('"Inc"')
  })
  it("a different word is refused unless staff tick that the Articles differ", () => {
    const refused = validateConfirmedLegalName({ confirmed: "Tanto per Italia LLC", referenceName: "Tanto per" })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain("differs from the filed name")
    expect(validateConfirmedLegalName({ confirmed: "Tanto per Italia LLC", referenceName: "Tanto per", articlesDiffer: true })).toEqual({ ok: true, name: "Tanto per Italia LLC" })
  })
  it("with no reference name (nothing filed yet) only the ending is checked", () => {
    expect(validateConfirmedLegalName({ confirmed: "Whatever LLC" })).toEqual({ ok: true, name: "Whatever LLC" })
  })
  it("empty, over-long, zero-width and control characters", () => {
    expect(validateConfirmedLegalName({ confirmed: "" }).ok).toBe(false)
    expect(validateConfirmedLegalName({ confirmed: "A".repeat(MAX_LEGAL_NAME_LENGTH + 1) + " LLC" }).ok).toBe(false)
    expect(validateConfirmedLegalName({ confirmed: "Acme​ LLC", referenceName: "Acme" })).toEqual({ ok: true, name: "Acme LLC" })
    expect(validateConfirmedLegalName({ confirmed: "Acme\u0000 LLC", referenceName: "Acme" })).toEqual({ ok: true, name: "Acme LLC" })
  })
  it("a name that ends in an invisible character before LLC is still seen as ending in LLC", () => {
    expect(validateConfirmedLegalName({ confirmed: "Acme LLC​", referenceName: "Acme" })).toEqual({ ok: true, name: "Acme LLC" })
  })
})

describe("resolveFormationLegalName — the one resolver", () => {
  it("a staff-confirmed name wins, untouched", () => {
    expect(resolveFormationLegalName({ confirmedLegalName: "Tanto Per LLC", filedName: "Tanto per" })).toEqual({ ok: true, name: "Tanto Per LLC", source: "confirmed", change: "none" })
  })
  it("filed name -> legal name", () => {
    expect(resolveFormationLegalName({ filedName: "Tanto per" })).toEqual({ ok: true, name: "Tanto per LLC", source: "filed", change: "added" })
  })
  it("no filed name -> the wizard's final name, then its chosen name (the old fallback order)", () => {
    expect(resolveFormationLegalName({ wizardFinalName: "Salemark llc", wizardChosenName: "Other" })).toMatchObject({ ok: true, name: "Salemark LLC", source: "wizard", change: "recased" })
    expect(resolveFormationLegalName({ wizardChosenName: "Other" })).toMatchObject({ ok: true, name: "Other LLC", source: "wizard" })
  })
  it("filed beats wizard", () => {
    expect(resolveFormationLegalName({ filedName: "Filed", wizardFinalName: "Wiz" })).toMatchObject({ name: "Filed LLC", source: "filed" })
  })
  it("nothing at all -> empty (the callers keep their existing 'no chosen name' failure)", () => {
    expect(resolveFormationLegalName({})).toMatchObject({ ok: false, reason: "empty" })
  })
  it("a blocked ending is returned as a failure carrying the plain sentence and the base name", () => {
    const r = resolveFormationLegalName({ filedName: "Acme Inc" })
    expect(r).toMatchObject({ ok: false, reason: "blocked_ending", base: "Acme Inc" })
    if (!r.ok) expect(r.detail).toContain("not an LLC ending")
  })
})

describe("cleanNameText", () => {
  it("strips invisible characters and control characters, collapses spaces, folds width forms", () => {
    expect(cleanNameText("  A​c\u0007me \t  Studio ")).toBe("Acme Studio")
    expect(cleanNameText("Ａcme")).toBe("Acme") // full-width A -> A (NFKC)
    expect(cleanNameText(null)).toBe("")
    expect(cleanNameText(7)).toBe("")
  })
})

describe("Company Change Name keeps an LLC's ending", () => {
  it("an LLC renamed to a name with no ending is refused with a plain sentence", () => {
    const p = newNameEndingProblem("Old Name LLC", "Acme")
    expect(p).toContain("no LLC ending")
    expect(p).toContain('"Acme"')
  })
  it("a valid ending (any accepted form) passes", () => {
    for (const n of ["Acme LLC", "Acme, LLC", "Acme L.L.C.", "Acme Limited Liability Company", "ACME llc"]) expect(newNameEndingProblem("Old Name LLC", n), n).toBeNull()
  })
  it("a company whose current name has no LLC ending (a corporation, a legacy record) is not held to it", () => {
    expect(newNameEndingProblem("Atlas Compliance INC", "Atlas Group Inc")).toBeNull()
    expect(newNameEndingProblem(null, "Whatever")).toBeNull()
    expect(newNameEndingProblem("", "Whatever")).toBeNull()
  })
})
