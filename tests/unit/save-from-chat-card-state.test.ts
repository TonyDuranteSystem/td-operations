import { describe, it, expect } from "vitest"
import { blockersFor, initialForm, candidateOf, normDigits, crossItemBlockers, trustedLetterDateOfBirth } from "@/lib/crm-store/save-from-chat-card-state"
import type { CardCandidate, CardItem } from "@/lib/crm-store/save-from-chat-rules"

const field = (value: string | null, status: "ok" | "unsure" | "missing" = "ok") => ({ value, status, evidence: value ? `…${value}…` : null, note: status === "ok" ? null : "check", others: [] as string[] })
const cand = (over: Partial<CardCandidate> = {}): CardCandidate => ({ contactId: "c1", name: "Jane Sample", namedInLetter: true, existingItin: null, existingIssueDate: null, alreadySaved: null, waiting: [], ...over })
const item = (over: Partial<CardItem> = {}): CardItem => ({
  index: 0, name: "scan.pdf", size: 1000, mimeType: "application/pdf", previewUrl: "/p", readable: true, unsupportedReason: null, readError: null,
  recognized: true, noticeKind: "CP565", itin: field("900-70-1234"), noticeDate: field("2025-10-07"), dateOfBirth: field("1990-03-03"), nameOnLetter: "JANE SAMPLE",
  problems: [], rawText: "x", candidates: [cand(), cand({ contactId: "c2", name: "John Example", namedInLetter: false })], proposedContactId: "c1", ownerReason: "The letter names Jane Sample.",
  proposedFileName: "ITIN Letter - Jane Sample.pdf", proposedPlace: "Jane Sample › ITIN", ...over,
})

describe("initialForm", () => {
  it("a recognised, readable file starts ticked with the proposed person, name and read values — and the client choice is HIDDEN", () => {
    const f = initialForm(item())
    expect(f).toMatchObject({ include: true, contactId: "c1", fileName: "ITIN Letter - Jane Sample.pdf", itin: "900-70-1234", issueDate: "2025-10-07", client: "hidden", replaceItin: false, itinChecked: false, dateChecked: false, ownerChecked: false, holderChecked: false })
  })
  it("a file that is not recognised, unreadable or already saved FOR THE PROPOSED PERSON starts un-ticked", () => {
    expect(initialForm(item({ recognized: false })).include).toBe(false)
    expect(initialForm(item({ readable: false })).include).toBe(false)
    const saved = { fileId: "f", name: "n", state: "live" }
    expect(initialForm(item({ candidates: [cand({ alreadySaved: saved }), cand({ contactId: "c2", name: "John Example", namedInLetter: false })] })).include).toBe(false)
    // saved for somebody ELSE only: the proposed person has no copy yet, so it is ticked
    expect(initialForm(item({ candidates: [cand(), cand({ contactId: "c2", name: "John Example", namedInLetter: false, alreadySaved: saved })] })).include).toBe(true)
  })
  it("no proposed owner → nothing chosen; missing values → empty fields (never today's date)", () => {
    const f = initialForm(item({ proposedContactId: null, itin: field(null, "missing"), noticeDate: field(null, "missing") }))
    expect(f.contactId).toBe("")
    expect(f.itin).toBe("")
    expect(f.issueDate).toBe("")
  })
})

describe("blockersFor — when a file may NOT be saved yet", () => {
  it("a clear read of a named person has no blockers", () => {
    const it = item()
    expect(blockersFor(it, initialForm(it))).toEqual([])
  })
  it("an un-ticked file has none (it is not being saved)", () => {
    const it = item()
    expect(blockersFor(it, { ...initialForm(it), include: false, contactId: "" })).toEqual([])
  })
  it("no person chosen", () => {
    const it = item({ proposedContactId: null })
    expect(blockersFor(it, initialForm(it)).join(" ")).toMatch(/Choose whose letter/)
  })
  it("a person the letter does not name needs the tick", () => {
    const it = item()
    const f = { ...initialForm(it), contactId: "c2" }
    expect(blockersFor(it, f).join(" ")).toMatch(/does not name John Example/)
    expect(blockersFor(it, { ...f, ownerChecked: true })).toEqual([])
  })
  it("an open ITIN case waiting for the letter blocks it, and a check that could not be made blocks it too", () => {
    const waiting = [{ sdId: "s", serviceType: "ITIN", stage: "ITIN Approved", who: "Jane Sample", asks: "the approval letter", how: "Upload it in the workspace." }]
    const a = item({ candidates: [cand({ waiting })] })
    expect(blockersFor(a, initialForm(a)).join(" ")).toMatch(/Jane Sample's ITIN case is at "ITIN Approved"/)
    const b = item({ candidates: [cand({ waiting: null })] })
    expect(blockersFor(b, initialForm(b)).join(" ")).toMatch(/Could not check/)
  })
  it("an ITIN that is not valid, or a date without an ITIN, or a bad date", () => {
    const it = item()
    const f = initialForm(it)
    expect(blockersFor(it, { ...f, itin: "800-70-1234" }).join(" ")).toMatch(/ITIN is not valid/)
    expect(blockersFor(it, { ...f, itin: "", issueDate: "2025-10-07" }).join(" ")).toMatch(/together with its date/)
    expect(blockersFor(it, { ...f, issueDate: "2025-02-30" }).join(" ")).toMatch(/not a real date/)
    expect(blockersFor(it, { ...f, issueDate: "1990-01-01" }).join(" ")).toMatch(/before 1996/)
  })
  it("a date of birth the reader was UNSURE of never blocks the date staff typed from the scan (it may BE the notice date); a clearly read one still does", () => {
    const unsure = item({ dateOfBirth: field("2025-10-07", "unsure"), noticeDate: field("2030-03-03", "unsure") })
    const f = { ...initialForm(unsure), issueDate: "2025-10-07", dateChecked: true }
    expect(blockersFor(unsure, f)).toEqual([])
    expect(trustedLetterDateOfBirth(unsure)).toBeNull()
    const clear = item({ dateOfBirth: field("2025-10-07", "ok"), noticeDate: field("2025-10-08") })
    expect(blockersFor(clear, { ...initialForm(clear), issueDate: "2025-10-07" }).join(" ")).toMatch(/date of birth/)
    expect(trustedLetterDateOfBirth(clear)).toBe("2025-10-07")
    expect(trustedLetterDateOfBirth(item({ dateOfBirth: null }))).toBeNull()
    expect(trustedLetterDateOfBirth(item({ dateOfBirth: field(null, "missing") }))).toBeNull()
  })
  it("an UNSURE value must be ticked 'checked' — or edited — before it can be saved; an empty field is fine", () => {
    const it = item({ noticeDate: field("2025-10-01", "unsure"), itin: field("900-70-1234", "unsure") })
    const f = initialForm(it)
    const msgs = blockersFor(it, f).join(" ")
    expect(msgs).toMatch(/checked the ITIN against the scan/)
    expect(msgs).toMatch(/checked the notice date against the scan/)
    expect(blockersFor(it, { ...f, itinChecked: true, dateChecked: true })).toEqual([])
    // a different value is no longer "the unsure one" (only the tick — never an edit — counts as having looked at the unsure value)
    expect(blockersFor(it, { ...f, itinChecked: true, issueDate: "2025-10-07" })).toEqual([])
    // clearing the unsure date and saving without it is allowed
    expect(blockersFor(it, { ...f, itinChecked: true, issueDate: "" })).toEqual([])
  })
  it("the date of birth printed on the letter can never be the notice date (the CRM's own date of birth is often empty)", () => {
    const it = item({ dateOfBirth: field("1998-05-05"), noticeDate: field("2025-10-07") })
    expect(blockersFor(it, { ...initialForm(it), issueDate: "1998-05-05" }).join(" ")).toMatch(/date of birth/)
    expect(blockersFor(it, { ...initialForm(it), issueDate: "1997-01-01" }).join(" ")).toMatch(/before the date of birth/)
  })
  it("editing an unsure value and putting it back does NOT count as checked — only the tick does", () => {
    const it = item({ itin: field("900-70-1234", "unsure") })
    const f = initialForm(it)
    const edited = { ...f, itin: "900-70-1239" }
    expect(blockersFor(it, edited)).toEqual([]) // a different value is no longer "the unsure one"
    const reverted = { ...edited, itin: "900-70-1234" } // itinChecked was never ticked
    expect(blockersFor(it, reverted).join(" ")).toMatch(/checked the ITIN against the scan/)
    expect(blockersFor(it, { ...reverted, itinChecked: true })).toEqual([])
  })
  it("a file name carrying a tax number", () => {
    const it = item()
    expect(blockersFor(it, { ...initialForm(it), fileName: "JANE---900-70-1234-itin.pdf" }).join(" ")).toMatch(/file name must not contain/)
  })
})

describe("crossItemBlockers — several files at once", () => {
  const a = item({ index: 0 })
  const b = item({ index: 1 })
  const forms = (fa: Record<string, unknown>, fb: Record<string, unknown>) => ({ 0: { ...initialForm(a), ...fa }, 1: { ...initialForm(b), ...fb } })
  it("two ticked files for the SAME person with DIFFERENT ITINs are refused", () => {
    const msgs = crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "901-54-5678" }))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatch(/Jane Sample/)
  })
  it("the same ITIN twice, different people, an un-ticked file or an empty ITIN are fine", () => {
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "900 70 1234" }))).toEqual([])
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "901-54-5678", contactId: "c2" }))).toEqual([])
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "901-54-5678", include: false }))).toEqual([])
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "" }))).toEqual([])
  })
})

describe("crossItemBlockers — the same ITIN for two different people", () => {
  const a = item({ index: 0 })
  const b = item({ index: 1 })
  const forms = (fa: Record<string, unknown>, fb: Record<string, unknown>) => ({ 0: { ...initialForm(a), ...fa }, 1: { ...initialForm(b), ...fb } })
  it("one ITIN set for two different people is refused (one of the two letters is on the wrong person)", () => {
    const msgs = crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "900 70 1234", contactId: "c2" }))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatch(/Two different people .* same ITIN/)
  })
  it("fine when un-ticked, when one ITIN is empty, or when it is the same person (a retyped copy of the same letter)", () => {
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "900-70-1234", contactId: "c2", include: false }))).toEqual([])
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "", contactId: "c2" }))).toEqual([])
    expect(crossItemBlockers([a, b], forms({ itin: "900-70-1234" }, { itin: "900-70-1234" }))).toEqual([])
  })
})

describe("helpers", () => {
  it("candidateOf finds the chosen person; normDigits strips everything but digits", () => {
    const it = item()
    expect(candidateOf(it, { ...initialForm(it), contactId: "c2" })?.name).toBe("John Example")
    expect(candidateOf(it, { ...initialForm(it), contactId: "nope" })).toBeUndefined()
    expect(normDigits("900-70 1234")).toBe("900701234")
  })
})
