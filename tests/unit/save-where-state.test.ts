/** The decisions behind the save-where window (what the window shows, when Save works) — pure, so they are tested without a browser. */
import { describe, it, expect } from "vitest"
import { answersKey, canSave, needsRepropose, tidyPath, proposalIsCurrent, showsWorking, type WindowState } from "@/lib/crm-store/save-where-state"

const acme = { accountId: "a1", name: "Acme LLC" }
const base = (over: Partial<WindowState> = {}): WindowState => ({
  purpose: "irs_tax_return", company: acme, name: "2025 Tax Return.pdf", loading: false,
  proposalKey: answersKey("irs_tax_return", acme, "2025 Tax Return.pdf"), requestedKey: null, proposalState: "proposed", picked: null, busy: false, ...over,
})

describe("answersKey", () => {
  it("only a tax return depends on the file name (its year)", () => {
    expect(answersKey("irs_tax_return", acme, "a.pdf")).not.toBe(answersKey("irs_tax_return", acme, "b.pdf"))
    expect(answersKey("irs_ein_request", acme, "a.pdf")).toBe(answersKey("irs_ein_request", acme, "b.pdf"))
    expect(answersKey("irs_ein_request", acme, "a.pdf")).not.toBe(answersKey("irs_ein_request", { accountId: "a2", name: "X" }, "a.pdf"))
    expect(answersKey("irs_tax_return", "business", "a.pdf")).not.toBe(answersKey("irs_tax_return", null, "a.pdf"))
  })
})

describe("canSave — never a stale or loading proposal", () => {
  it("a current proposal can be saved", () => { expect(canSave(base())).toBe(true) })
  it("while the proposal is loading, Save is off", () => { expect(canSave(base({ loading: true }))).toBe(false) })
  it("the name was edited (2025 → 2019): the proposal is out of date, Save is off at once", () => {
    const s = base({ name: "2019 Tax Return.pdf" })
    expect(proposalIsCurrent(s)).toBe(false); expect(canSave(s)).toBe(false); expect(showsWorking(s)).toBe(true)
  })
  it("another company: out of date; no purpose: nothing to save", () => {
    expect(canSave(base({ company: { accountId: "a2", name: "B" } }))).toBe(false)
    expect(canSave(base({ purpose: null }))).toBe(false)
  })
  it("'choose' and 'refused' proposals cannot be saved; a place staff chose can, even when the proposal is out of date", () => {
    expect(canSave(base({ proposalState: "choose" }))).toBe(false)
    expect(canSave(base({ proposalState: "refused" }))).toBe(false)
    expect(canSave(base({ proposalState: "refused", picked: { path: "Business › Fax" } }))).toBe(true)
    expect(canSave(base({ name: "2019.pdf", picked: { path: "Business › Fax" } }))).toBe(true)
  })
  it("an empty name or a send in progress: Save is off", () => {
    expect(canSave(base({ name: "  " }))).toBe(false)
    expect(canSave(base({ busy: true }))).toBe(false)
  })
})

describe("needsRepropose — a tax return's year follows the file name, once", () => {
  it("name edited → ask again", () => { expect(needsRepropose(base({ name: "2019 Tax Return.pdf" }))).toBe(true) })
  it("current proposal, or a request for these answers already on its way → do not ask twice", () => {
    expect(needsRepropose(base())).toBe(false)
    expect(needsRepropose(base({ name: "2019 Tax Return.pdf", requestedKey: answersKey("irs_tax_return", acme, "2019 Tax Return.pdf") }))).toBe(false)
  })
  it("not for other purposes, nor when staff chose the place", () => {
    expect(needsRepropose(base({ purpose: "irs_ein_request", name: "x", proposalKey: null }))).toBe(false)
    expect(needsRepropose(base({ name: "2019.pdf", picked: { path: "x" } }))).toBe(false)
  })
})

describe("tidyPath", () => {
  it("shows a repeated name once", () => {
    expect(tidyPath("Business › Business › Fax")).toBe("Business › Fax")
    expect(tidyPath("Acme › 3. Tax › 2025")).toBe("Acme › 3. Tax › 2025")
    expect(tidyPath("A › B › A")).toBe("A › B › A")
  })
})

describe("a hand-picked place is KEPT when the fax or company changes", () => {
  it("the place stays valid for Save (only the visible 'Use the proposal' button drops it)", () => {
    // the proposal was made for other answers, the hand-picked place still counts
    const s = base({ company: { accountId: "a2", name: "B" }, picked: { path: "Business › Fax" } })
    expect(canSave(s)).toBe(true)
    expect(showsWorking(s)).toBe(false)
  })
})
