/**
 * Council 2026-07-17 blocker: the accountant hand-off picked the file to email by
 * name pattern alone, so a two-year client's 2024 workbook could be filed as the
 * 2025 return. The first fix only asked "is the year in the name somewhere", which
 * the Council broke with two real filenames — a revision date and a company name
 * carrying a year. These pin the rule that replaced it: the year must be the ONLY
 * year the name mentions, the company name is not evidence, location can prove a
 * year-less name, and anything unprovable is refused rather than guessed.
 */
import { describe, it, expect } from "vitest"
import { pickFileForYear, belongsToYear, yearsInName, stripCompanyName, proveYear, matchesCategory, decideSendGate, isSupersededRootCopy, type DriveCandidate } from "@/lib/tax/pick-tax-file"

const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const f = (id: string, name: string): DriveCandidate => ({ id, name, mimeType: xlsx })
const PNL = {
  namePattern: /p&l|pnl|profit.?loss/i,
  typeMatches: (c: DriveCandidate) => /spreadsheet|excel/i.test(c.mimeType || "") || /\.xlsx?$/i.test(c.name),
}
const pick = (files: DriveCandidate[], year: number, extra = {}) => pickFileForYear(files, year, { ...PNL, ...extra })

describe("yearsInName", () => {
  it("finds every standalone year and ignores embedded digits", () => {
    expect(yearsInName("PnL 2025.xlsx")).toEqual([2025])
    expect(yearsInName("PnL 2024 (revised 2025-01-30).xlsx")).toEqual([2024, 2025])
    expect(yearsInName("FY2024-2025 PnL.xlsx")).toEqual([2024, 2025])
    expect(yearsInName("PnL 20250101.xlsx")).toEqual([])
    expect(yearsInName("PnL 12025.xlsx")).toEqual([])
    expect(yearsInName("PnL final.xlsx")).toEqual([])
    expect(yearsInName("PnL 2025 v2 2025.xlsx")).toEqual([2025]) // de-duplicated
  })
})

describe("stripCompanyName", () => {
  it("removes the company name wherever it sits, however it was slugged", () => {
    expect(stripCompanyName("Trend 2025 LLC - PnL 2024.xlsx", "Trend 2025 LLC")).toBe("  - PnL 2024.xlsx")
    // Our organizer generator emits `Tax_Data_{Company}.pdf` — company in the
    // MIDDLE, spaces as underscores. A leading-prefix strip never fired here.
    expect(stripCompanyName("Tax_Data_Trend_2025_LLC.pdf", "Trend 2025 LLC")).toBe("Tax_Data_ .pdf")
    expect(stripCompanyName("Acme - PnL 2024.xlsx", "Nope LLC")).toBe("Acme - PnL 2024.xlsx")
    expect(stripCompanyName("Acme - PnL 2024.xlsx", undefined)).toBe("Acme - PnL 2024.xlsx")
    expect(stripCompanyName("acme - PnL 2024.xlsx", "Acme")).toBe("  - PnL 2024.xlsx") // case-insensitive
  })

  it("treats regex characters in a company name literally", () => {
    expect(stripCompanyName("A+B (Holdings) - PnL 2025.xlsx", "A+B (Holdings)")).toBe("  - PnL 2025.xlsx")
  })
})

describe("pickFileForYear — the wrong-year attacks the Council landed", () => {
  it("a revision date does NOT prove the year: 2024 P&L revised in 2025, asked for 2025 → refused", () => {
    const files = [f("a", "Dynamiq SR LLC - PnL 2024 (revised 2025-01-30).xlsx")]
    const p = pick(files, 2025)
    expect(p.file).toBeNull() // was: attached and filed as the 2025 return
    expect(p.conflictNote).toContain("next to another year")
  })

  it("a company name with a year is NOT evidence: 'Trend 2025 LLC - PnL 2024', asked for 2025 → refused", () => {
    const files = [f("a", "Trend 2025 LLC - PnL 2024 (client-confirmed).xlsx")]
    expect(pick(files, 2025, { companyName: "Trend 2025 LLC" }).file).toBeNull()
    // ...and the same file is still correctly found for its real year.
    expect(pick(files, 2024, { companyName: "Trend 2025 LLC" }).file?.id).toBe("a")
  })

  it("the ORGANIZER's real filename shape: a year-in-company-name proves nothing", () => {
    // lib/form-to-drive.ts emits `Tax_Data_{Company with _ for spaces}.pdf`.
    // This carries NO evidence of its own year — only the folder can prove it.
    const organizer: DriveCandidate = { id: "o", name: "Tax_Data_Trend_2025_LLC.pdf", mimeType: "application/pdf" }
    const ORG = { namePattern: /tax.?data|tax.?organizer/i, typeMatches: (c: DriveCandidate) => /pdf/i.test(c.mimeType || "") || /\.pdf$/i.test(c.name) }
    // In the Tax root: unprovable → refused (was: the company's "2025" proved it).
    expect(pickFileForYear([organizer], 2025, { ...ORG, companyName: "Trend 2025 LLC" }).file).toBeNull()
    // In the 2025 folder: proven by location.
    expect(pickFileForYear([organizer], 2025, { ...ORG, companyName: "Trend 2025 LLC", yearFolderFileIds: new Set(["o"]) }).file?.id).toBe("o")
  })

  it("a fiscal span proves nothing for either year", () => {
    const files = [f("a", "Acme - FY2024-2025 PnL.xlsx")]
    expect(pick(files, 2025).file).toBeNull()
    expect(pick(files, 2024).file).toBeNull()
  })

  it("exposes the unreadable files themselves, so a caller can stop calling the chosen one 'not used'", () => {
    // Found in sandbox QA: naming the revision-dated file by id attached it, and
    // the very same run warned that it "was NOT used". A self-contradicting
    // warning is how real warnings stop being read.
    const p = pick([f("clean", "Acme - PnL 2025.xlsx"), f("revised", "Acme - PnL 2025 (revised 2026-01-30).xlsx")], 2025)
    expect(p.conflicted.map(c => c.id)).toEqual(["revised"])
    expect(p.conflicted.filter(c => c.id !== "revised")).toEqual([]) // nothing left to warn about
  })

  it("a stray unreadable file does NOT block a clean winner (having the right file must never be worse)", () => {
    const p = pick([f("clean", "Acme - PnL 2025.xlsx"), f("stray", "Acme - PnL 2024 (revised 2025).xlsx")], 2025)
    expect(p.file?.id).toBe("clean")
    expect(p.ambiguityNote).toBeNull()                     // not a "which is it" — nothing to stop for
    expect(p.conflictNote).toContain("revised 2025")       // reported, not hidden
  })

  it("NEVER attaches another year's P&L: only a 2024 file present, 2025 requested → none", () => {
    const files = [f("a", "Dynamiq SR LLC - PnL + Balance Sheet 2024 (client-confirmed).xlsx")]
    expect(pick(files, 2025).file).toBeNull()
  })

  it("picks the requested year when both years sit in the same folder", () => {
    const files = [
      f("a", "Dynamiq SR LLC - PnL + Balance Sheet 2024 (client-confirmed).xlsx"),
      f("b", "Dynamiq SR LLC - PnL + Balance Sheet 2025 (client-confirmed).xlsx"),
    ]
    expect(pick(files, 2025).file?.id).toBe("b")
    expect(pick(files, 2024).file?.id).toBe("a")
  })
})

describe("pickFileForYear — proof by location, so we don't refuse legitimate files", () => {
  it("a year-less name inside the year subfolder is proven by where it sits", () => {
    const inYear = f("inyear", "Dynamiq SR LLC - P&L final.xlsx")
    const p = pick([inYear], 2025, { yearFolderFileIds: new Set(["inyear"]) })
    expect(p.file?.id).toBe("inyear")
    expect(p.ambiguityNote).toBeNull()
  })

  it("the same year-less name loose in the Tax root proves nothing → refused", () => {
    expect(pick([f("loose", "Dynamiq SR LLC - P&L final.xlsx")], 2025).file).toBeNull()
  })

  it("location does NOT override an explicit wrong year in the name", () => {
    const misfiled = f("x", "Acme - PnL 2024.xlsx")
    expect(pick([misfiled], 2025, { yearFolderFileIds: new Set(["x"]) }).file).toBeNull()
  })
})

describe("pickFileForYear — ranking and ambiguity", () => {
  it("prefers the client-confirmed archive over another same-year workbook", () => {
    const files = [f("draft", "Acme - PnL 2025.xlsx"), f("confirmed", "Acme - PnL + Balance Sheet 2025 (client-confirmed).xlsx")]
    const p = pick(files, 2025)
    expect(p.file?.id).toBe("confirmed")
    expect(p.ambiguityNote).toContain("2 files provably belong to 2025")
    expect(p.ambiguityNote).toContain("id confirmed") // the id is printed — naming the file is the way out
  })

  it("a company name containing 'old' is not read as a superseded draft", () => {
    // "Gold Coast" / "Holdings" matched a bare /old/ and outranked the archive.
    const files = [
      f("confirmed", "Gold Coast LLC - PnL + Balance Sheet 2025 (client-confirmed).xlsx"),
      f("hand", "Gold Coast LLC - P&L final.xlsx"),
    ]
    const p = pickFileForYear(files, 2025, { ...PNL, companyName: "Gold Coast LLC", yearFolderFileIds: new Set(["confirmed", "hand"]) })
    expect(p.file?.id).toBe("confirmed")
  })

  it("prefers a file inside the year subfolder over a loose one in the Tax root", () => {
    const p = pick([f("inroot", "Acme - PnL 2025.xlsx"), f("inyear", "Acme - PnL 2025.xlsx")], 2025, {
      yearFolderFileIds: new Set(["inyear"]),
    })
    expect(p.file?.id).toBe("inyear")
  })

  it("ranks a DRAFT below the final even when Drive lists it first", () => {
    // Drive orders by name, so " DRAFT.xlsx" sorts before ".xlsx" — the old rank tied and took Drive's order.
    const p = pick([f("draft", "Acme - PnL 2025 DRAFT.xlsx"), f("final", "Acme - PnL 2025.xlsx")], 2025)
    expect(p.file?.id).toBe("final")
    expect(p.ambiguityNote).toContain("2 files provably belong to 2025")
  })

  it("client-confirmed still wins even when its own name carries a 'copy' word", () => {
    const p = pick([f("c", "Acme - PnL 2025 copy (client-confirmed).xlsx"), f("d", "Acme - PnL 2025.xlsx")], 2025)
    expect(p.file?.id).toBe("c") // the draft penalty must never outvote the archive
  })

  it("surfaces ambiguity instead of silently resolving it", () => {
    const p = pick([f("a", "Acme - PnL 2025.xlsx"), f("b", "Acme - profit loss 2025.xlsx")], 2025)
    expect(p.candidates).toHaveLength(2)
    expect(p.ambiguityNote).toContain("Also:")
  })

  it("a single unambiguous match carries no note", () => {
    const p = pick([f("a", "Acme - PnL 2025.xlsx")], 2025)
    expect(p.file?.id).toBe("a")
    expect(p.ambiguityNote).toBeNull()
  })

  it("an empty folder yields no notes at all", () => {
    const p = pick([], 2025)
    expect(p.ambiguityNote).toBeNull()
    expect(p.conflictNote).toBeNull()
  })
})

describe("pickFileForYear — the company name is not evidence of the KIND of file either", () => {
  it("a client called 'PNL Consulting LLC' does not have every spreadsheet read as a P&L", () => {
    // The name pattern used to be tested against the raw name, so /pnl/ matched
    // via the company — and an unrelated upload was emailed as the P&L.
    const upload = f("u", "PNL Consulting LLC - transactions 2025.xlsx")
    const p = pickFileForYear([upload], 2025, { ...PNL, companyName: "PNL Consulting LLC", yearFolderFileIds: new Set(["u"]) })
    expect(p.file).toBeNull()
  })

  it("...but that client's real P&L is still found", () => {
    const real = f("r", "PNL Consulting LLC - PnL 2025.xlsx")
    expect(pickFileForYear([real], 2025, { ...PNL, companyName: "PNL Consulting LLC" }).file?.id).toBe("r")
  })

  it("matchesCategory rejects a statement for a client called 'Relay Ltd'", () => {
    const STMT = { namePattern: /wise|mercury|relay|statement|bank/i, typeMatches: (c: DriveCandidate) => /\.(pdf|csv)$/i.test(c.name) }
    expect(matchesCategory({ id: "x", name: "Relay Ltd - invoice 2025.pdf" }, { ...STMT, companyName: "Relay Ltd" })).toBe(false)
    expect(matchesCategory({ id: "y", name: "Relay Ltd - Mercury statement 2025.pdf" }, { ...STMT, companyName: "Relay Ltd" })).toBe(true)
  })
})

describe("pickFileForYear — type and pattern matching", () => {
  it("accepts a real .xlsx whose Drive mimeType is unhelpful", () => {
    const octet: DriveCandidate = { id: "a", name: "Acme - PnL 2025.xlsx", mimeType: "application/octet-stream" }
    expect(pick([octet], 2025).file?.id).toBe("a") // mime OR extension — either alone suffices
  })

  it("ignores non-spreadsheets and non-P&L files that happen to name the year", () => {
    const files: DriveCandidate[] = [
      { id: "pdf", name: "Acme - PnL 2025.pdf", mimeType: "application/pdf" },
      { id: "stmt", name: "Mercury statement 2025.xlsx", mimeType: xlsx },
    ]
    expect(pick(files, 2025).file).toBeNull()
  })

  it("handles an empty folder", () => {
    const p = pick([], 2025)
    expect(p.file).toBeNull()
    expect(p.candidates).toEqual([])
    expect(p.ambiguityNote).toBeNull()
  })
})

describe("pickFileForYear — telling two candidates apart", () => {
  it("describes WHERE each candidate lives and when it changed — two files can share a name exactly", () => {
    // The legacy Tax-root copy and its year-folder replacement are byte-identical
    // in name. Asking a human to choose between two identical lines is asking
    // them to guess — and the wrong guess files superseded numbers.
    const inYear: DriveCandidate = { id: "new", name: "Dynamiq - PnL 2024 (client-confirmed).xlsx", mimeType: xlsx, modifiedTime: "2026-07-17T10:00:00Z" }
    const inRoot: DriveCandidate = { id: "old", name: "Dynamiq - PnL 2024 (client-confirmed).xlsx", mimeType: xlsx, modifiedTime: "2026-03-01T10:00:00Z" }
    const p = pick([inRoot, inYear], 2024, { yearFolderFileIds: new Set(["new"]) })
    expect(p.file?.id).toBe("new")
    expect(p.ambiguityNote).toContain("in the year folder")
    expect(p.ambiguityNote).toContain("loose in the Tax root")
    expect(p.ambiguityNote).toContain("2026-07-17")
    expect(p.ambiguityNote).toContain("2026-03-01")
  })
})

describe("matchesCategory — a company named after the category keeps its own P&L", () => {
  it("a client literally called 'Profit Loss' still has its P&L found", () => {
    // Stripping EVERY occurrence would erase the document's own token and report
    // a real workbook missing. The category test strips only the first.
    const file = f("a", "Profit Loss - Profit Loss 2025.xlsx")
    expect(matchesCategory(file, { ...PNL, companyName: "Profit Loss" })).toBe(true)
    expect(pickFileForYear([file], 2025, { ...PNL, companyName: "Profit Loss" }).file?.id).toBe("a")
  })
})

describe("isSupersededRootCopy — the legacy twin left in the Tax root", () => {
  const root = (name: string, modifiedTime?: string): DriveCandidate => ({ id: "r", name, modifiedTime })

  it("drops the root twin when the year folder's copy is newer", () => {
    const yearCopies = new Map([["Acme - PnL 2024 (client-confirmed).xlsx", "2026-07-17T10:00:00Z"]])
    expect(isSupersededRootCopy(root("Acme - PnL 2024 (client-confirmed).xlsx", "2026-03-01T10:00:00Z"), yearCopies)).toBe(true)
  })

  it("KEEPS a root twin that is NEWER — it may be the corrected one", () => {
    // Other paths still write to the Tax root, so "in the root" does not mean
    // "stale". Keeping it makes the pick ambiguous, which stops the send —
    // far better than silently dropping a correction.
    const yearCopies = new Map([["Acme - PnL 2024.xlsx", "2026-03-01T10:00:00Z"]])
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx", "2026-07-17T10:00:00Z"), yearCopies)).toBe(false)
  })

  it("treats the dateless legacy twin as superseded — that is the one this removes", () => {
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx"), new Map([["Acme - PnL 2024.xlsx", ""]]))).toBe(true)
  })

  it("KEEPS the twin when only one side has a date — 'I can't compare' must not become 'drop one'", () => {
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx"), new Map([["Acme - PnL 2024.xlsx", "2026-07-17T10:00:00Z"]]))).toBe(false)
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx", "2026-07-17T10:00:00Z"), new Map([["Acme - PnL 2024.xlsx", ""]]))).toBe(false)
  })

  it("drops the twin when the dates are equal — same artifact, filed where it belongs", () => {
    const same = "2026-07-17T10:00:00Z"
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx", same), new Map([["Acme - PnL 2024.xlsx", same]]))).toBe(true)
  })

  it("leaves a root file with no namesake in the year folder alone", () => {
    expect(isSupersededRootCopy(root("Acme - PnL 2024.xlsx", "2026-03-01T10:00:00Z"), new Map())).toBe(false)
  })

  it("matches on the exact name only — a near-name is a different document", () => {
    const yearCopies = new Map([["Acme - PnL 2024.xlsx", "2026-07-17T10:00:00Z"]])
    expect(isSupersededRootCopy(root("Acme - PnL 2024 (1).xlsx", "2026-03-01T10:00:00Z"), yearCopies)).toBe(false)
  })
})

describe("decideSendGate — the rules that stop a wrong filing", () => {
  const base = { pnlMissing: false, ambiguous: [], pnlConflicts: [], missing: [], sendIncomplete: false, isDryRun: false, foundCount: 3 }

  it("lets a clean package through", () => {
    expect(decideSendGate(base)).toEqual({ allow: true })
  })

  it("a missing P&L is a hard stop that NO flag bypasses", () => {
    const stopped = { allow: false, reason: "no_pnl" }
    expect(decideSendGate({ ...base, pnlMissing: true })).toEqual(stopped)
    expect(decideSendGate({ ...base, pnlMissing: true, sendIncomplete: true })).toEqual(stopped)
    // ...and it stops the preview too, so nobody reviews a package that can't be sent.
    expect(decideSendGate({ ...base, pnlMissing: true, isDryRun: true })).toEqual(stopped)
  })

  it("an unresolved ambiguity stops the send, and send_incomplete cannot skip past it", () => {
    // The ambiguity check must come BEFORE the optional-docs gate, or the flag
    // meant for a missing organizer would wave a wrong-year P&L through.
    expect(decideSendGate({ ...base, ambiguous: ["two P&Ls"] })).toEqual({ allow: false, reason: "ambiguous" })
    expect(decideSendGate({ ...base, ambiguous: ["two P&Ls"], sendIncomplete: true })).toEqual({ allow: false, reason: "ambiguous" })
    expect(decideSendGate({ ...base, ambiguous: ["two P&Ls"], missing: ["organizer"], sendIncomplete: true }))
      .toEqual({ allow: false, reason: "ambiguous" })
  })

  it("a preview of an ambiguous package is allowed — that is how the operator gets the ids to resolve it", () => {
    expect(decideSendGate({ ...base, ambiguous: ["two P&Ls"], isDryRun: true })).toEqual({ allow: true })
  })

  it("an unreadable P&L sitting next to the picked one STOPS the send — it may be the correction", () => {
    // The whole point: printing "a file mentioning 2025 was ignored" under a
    // successful send is a footnote nobody reads. It blocks instead.
    expect(decideSendGate({ ...base, pnlConflicts: ["PnL 2024 (revised 2025)"] })).toEqual({ allow: false, reason: "pnl_conflict" })
    expect(decideSendGate({ ...base, pnlConflicts: ["x"], sendIncomplete: true })).toEqual({ allow: false, reason: "pnl_conflict" })
    // ...but the preview still renders, so the operator can see the ids and choose.
    expect(decideSendGate({ ...base, pnlConflicts: ["x"], isDryRun: true })).toEqual({ allow: true })
  })

  it("missing optional documents stop the send until send_incomplete says otherwise", () => {
    expect(decideSendGate({ ...base, missing: ["organizer"] })).toEqual({ allow: false, reason: "missing_docs" })
    expect(decideSendGate({ ...base, missing: ["organizer"], sendIncomplete: true })).toEqual({ allow: true })
  })

  it("refuses an empty package", () => {
    expect(decideSendGate({ ...base, foundCount: 0 })).toEqual({ allow: false, reason: "no_documents" })
    // ...even when the operator waved the missing docs through.
    expect(decideSendGate({ ...base, foundCount: 0, missing: ["organizer"], sendIncomplete: true }))
      .toEqual({ allow: false, reason: "no_documents" })
  })
})

describe("proveYear / belongsToYear — supporting documents", () => {
  it("proves by name, by folder, and refuses the rest", () => {
    expect(proveYear(f("a", "Wise statement 2025.pdf"), 2025)).toBe("name")
    expect(proveYear(f("b", "Wise statement.pdf"), 2025, { yearFolderFileIds: new Set(["b"]) })).toBe("folder")
    expect(proveYear(f("c", "Wise statement.pdf"), 2025)).toBeNull()
    expect(proveYear(f("d", "Wise statement 2024.pdf"), 2025)).toBeNull()
    expect(proveYear(f("e", "Wise 2024-2025 statement.pdf"), 2025)).toBe("conflict")
  })

  it("belongsToYear keeps this year's statements and drops last year's", () => {
    expect(belongsToYear(f("a", "Mercury statement 2025.pdf"), 2025)).toBe(true)
    expect(belongsToYear(f("b", "Mercury statement 2024.pdf"), 2025)).toBe(false)
    expect(belongsToYear(f("c", "Mercury 2024-2025 statement.pdf"), 2025)).toBe(false) // conflicted is not proof
  })
})
