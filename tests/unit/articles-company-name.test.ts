/**
 * Job 80cce1cb — the company name printed on the Articles is only a PREFILL for the upload window's "Company legal name" field
 * (staff confirm it). It must never invent, decorate or truncate a name. The NM layout below is a real OCR sample; the WY / FL / DE
 * layouts are SYNTHETIC (modelled on the filing wording) — there is no real WY/FL/DE sample in the repo.
 */
import { describe, it, expect } from "vitest"
import { parseArticlesCompanyName, parseArticlesText } from "@/lib/articles-parse"
import { suggestLegalName, legalNameNeedsDifferTick } from "@/lib/flows/legal-name-prefill"

const NM_REAL = `STATE OF NEW MEXICO Secretary of State
ARTICLES OF ORGANIZATION - DOMESTIC LLC
New Mexico Secretary of State
-FILED-
File #: 3252197
Date Filed: 6/16/2026
Name of the Organization
Limited Liability Company Name
AI Venture Labs LLC
Filing Effective Date
The formation of the LLC will be effective When filed by the Secretary of State.`

describe("parseArticlesCompanyName", () => {
  it("reads the real NM layout", () => {
    expect(parseArticlesCompanyName(NM_REAL)).toBe("AI Venture Labs LLC")
  })

  it("keeps the Articles' own capitals", () => {
    expect(parseArticlesCompanyName("Limited Liability Company Name\nTanto Per LLC\nFiling Effective Date")).toBe("Tanto Per LLC")
    expect(parseArticlesCompanyName("Limited Liability Company Name\nTANTO PER LLC\nFiling")).toBe("TANTO PER LLC")
  })

  it("keeps a dotted ending's final period, drops a sentence full stop", () => {
    expect(parseArticlesCompanyName("Limited Liability Company Name\nAcme L.L.C.\nFiling")).toBe("Acme L.L.C.")
    expect(parseArticlesCompanyName("The name of the limited liability company is: Acme Holdings LLC.")).toBe("Acme Holdings LLC")
  })

  it("joins a name that wrapped onto a second line", () => {
    expect(parseArticlesCompanyName("Limited Liability Company Name\nTanto Per\nLLC\nFiling Effective Date")).toBe("Tanto Per LLC")
  })

  it("SYNTHETIC WY / FL / DE layouts", () => {
    expect(parseArticlesCompanyName("ARTICLES OF ORGANIZATION\n1. The name of the limited liability company is: Acme Holdings LLC\n2. The registered agent")).toBe("Acme Holdings LLC")
    expect(parseArticlesCompanyName("Article I - Name\nThe name of the Limited Liability Company is: ACME HOLDINGS, L.L.C.\nArticle II")).toBe("ACME HOLDINGS, L.L.C.")
    expect(parseArticlesCompanyName("FIRST: The name of the limited liability company is Acme Holdings, LLC.\nSECOND: The address")).toBe("Acme Holdings, LLC")
  })

  it("never decorates: a name without a valid ending is rejected, not completed", () => {
    expect(parseArticlesCompanyName("Limited Liability Company Name\nTanto Per\nFiling Effective Date")).toBeNull()
  })

  it("rejects instruction / label text that follows a label", () => {
    expect(parseArticlesCompanyName("Company Name: (must include LLC or L.L.C.)")).toBeNull()
    expect(parseArticlesCompanyName("Company Name:\nName of the Organization\nFiling Effective Date")).toBeNull()
    expect(parseArticlesCompanyName("Entity Name must include a designator such as LLC")).toBeNull()
  })

  it("returns null for empty / non-text / unreadable input", () => {
    expect(parseArticlesCompanyName("")).toBeNull()
    expect(parseArticlesCompanyName("lorem ipsum dolor")).toBeNull()
    expect(parseArticlesCompanyName(undefined as unknown as string)).toBeNull()
  })

  it("rejects an over-long capture", () => {
    expect(parseArticlesCompanyName(`Company Name: ${"Very ".repeat(40)}Long LLC`)).toBeNull()
  })
})

describe("parseArticlesText — the C-Corp guess uses whole words", () => {
  it("Lincoln / Zinc LLC are not corporations", () => {
    expect(parseArticlesText("Company Name: Lincoln Partners LLC").entity_type).not.toBe("C-Corp Elected")
    expect(parseArticlesText("Company Name: Zinc Works LLC").entity_type).not.toBe("C-Corp Elected")
  })
  it("a real Inc / Corp still is", () => {
    expect(parseArticlesText("Company Name: Acme Inc").entity_type).toBe("C-Corp Elected")
    expect(parseArticlesText("Company Name: Acme Corp.").entity_type).toBe("C-Corp Elected")
  })
})

describe("suggestLegalName — what the window prefills", () => {
  it("Articles read, same words as the filed name → the Articles' exact spelling (Tanto Per LLC)", () => {
    expect(suggestLegalName({ referenceName: "Tanto per", legalName: "Tanto per LLC", articlesName: "Tanto Per LLC" })).toEqual({
      value: "Tanto Per LLC",
      articlesName: "Tanto Per LLC",
      articlesDiffers: false,
    })
  })
  it("Articles read but a DIFFERENT word → the filed-derived name is prefilled, the Articles name is offered, never auto-picked", () => {
    expect(suggestLegalName({ referenceName: "Tanto per", legalName: "Tanto per LLC", articlesName: "Tanto Per Italia LLC" })).toEqual({
      value: "Tanto per LLC",
      articlesName: "Tanto Per Italia LLC",
      articlesDiffers: true,
    })
  })
  it("nothing readable → the filed-derived name", () => {
    expect(suggestLegalName({ referenceName: "Tanto per", legalName: "Tanto per LLC", articlesName: null })).toEqual({ value: "Tanto per LLC", articlesName: null, articlesDiffers: false })
  })
  it("an Articles name without a valid ending is not used", () => {
    expect(suggestLegalName({ referenceName: "Tanto per", legalName: "Tanto per LLC", articlesName: "Tanto Per" })).toMatchObject({ value: "Tanto per LLC", articlesName: null, articlesDiffers: false })
  })
  it("a filed name that cannot be used as it stands (Inc) is prefilled raw so staff must fix it", () => {
    expect(suggestLegalName({ referenceName: "Acme Inc", legalName: null, articlesName: null })).toMatchObject({ value: "Acme Inc" })
  })
  it("no reference at all (nothing filed, no wizard name) → the Articles name is used", () => {
    expect(suggestLegalName({ articlesName: "Acme LLC" })).toMatchObject({ value: "Acme LLC", articlesDiffers: false })
  })
})

describe("legalNameNeedsDifferTick", () => {
  it("only a different WORD needs the tick", () => {
    expect(legalNameNeedsDifferTick("Tanto Per LLC", "Tanto per")).toBe(false)
    expect(legalNameNeedsDifferTick("Tanto Per Italia LLC", "Tanto per")).toBe(true)
    expect(legalNameNeedsDifferTick("", "Tanto per")).toBe(false)
    expect(legalNameNeedsDifferTick("Anything LLC", "")).toBe(false)
  })
})
