import { describe, it, expect } from "vitest"
import {
  parseSaveChoice, decideDestination, validateDestination, saveToDestination, saveCallerKey, resolveProposal, noStorageSentenceFor, verifyProposalStillHolds, PROPOSAL_CHANGED_SENTENCE,
  type DestinationFacts, type DestinationDeps, type FileDeps, type OwnerRow, type SaveChoiceSave, type ResolveDeps,
} from "@/lib/crm-store/save-destination"
import { NO_STORAGE_REASON_SENTENCE } from "@/lib/crm-store/no-storage"
import { proposeFaxPlace } from "@/lib/crm-store/save-where"

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const OWNER = U(1), FOLDER = U(2)

const okFacts = (over: Partial<DestinationFacts> = {}): DestinationFacts => ({
  owner: { id: OWNER, kind: "company", studyOnly: false, accountId: "acc-1", contactId: null },
  folder: { id: FOLDER, ownerId: OWNER, kind: "tax", trashed: false },
  companyState: "store", noStorageSentence: null, accessOk: true, newFolderName: null, fileName: "2025 Tax Return.pdf", ...over,
})

describe("parseSaveChoice", () => {
  it("nothing sent = the older callers (no choice); don't_save is understood", () => {
    expect(parseSaveChoice(undefined)).toEqual({ ok: true, choice: null })
    expect(parseSaveChoice({ mode: "dont_save" })).toEqual({ ok: true, choice: { mode: "dont_save" } })
  })
  it("a full save choice is typed; a malformed one is a plain error", () => {
    const r = parseSaveChoice({ mode: "save", purpose: "irs_tax_return", ownerId: OWNER, folderId: FOLDER, newFolderName: " 2025 ", fileName: "a.pdf" })
    expect(r).toMatchObject({ ok: true, choice: { mode: "save", purpose: "irs_tax_return", ownerId: OWNER, folderId: FOLDER, newFolderName: " 2025 ", fileName: "a.pdf" } })
    for (const bad of ["x", { mode: "maybe" }, { mode: "save", purpose: "guess", ownerId: OWNER, folderId: FOLDER, fileName: "a" }, { mode: "save", purpose: "third_party", ownerId: "not-a-uuid", folderId: FOLDER, fileName: "a" }, { mode: "save", purpose: "third_party", ownerId: OWNER, folderId: FOLDER, fileName: "  " }]) {
      const p = parseSaveChoice(bad)
      expect(p.ok, JSON.stringify(bad)).toBe(false)
      expect(p.error).toBeTruthy()
    }
  })
})

describe("parseSaveChoice — proposalOf", () => {
  it("is null when the place came from Change place, typed when it came from the proposal, an error when malformed", () => {
    const base = { mode: "save", purpose: "irs_tax_return", ownerId: OWNER, folderId: FOLDER, fileName: "a.pdf" }
    expect(parseSaveChoice(base)).toMatchObject({ ok: true, choice: { proposalOf: null } })
    expect(parseSaveChoice({ ...base, proposalOf: { accountId: U(5), business: false } })).toMatchObject({ choice: { proposalOf: { accountId: U(5), business: false } } })
    expect(parseSaveChoice({ ...base, proposalOf: { business: true } })).toMatchObject({ choice: { proposalOf: { accountId: null, business: true } } })
    expect(parseSaveChoice({ ...base, proposalOf: { accountId: "nope" } }).ok).toBe(false)
  })
})

describe("decideDestination — a place that is not allowed is refused with ONE plain sentence", () => {
  it("a good place is allowed", () => { expect(decideDestination(okFacts())).toEqual({ ok: true, unlinked: false }) })
  it("a place that does not exist / that staff may not open", () => {
    expect(decideDestination(okFacts({ owner: null })).ok).toBe(false)
    expect(decideDestination(okFacts({ accessOk: false })).ok).toBe(false)
  })
  it("WRONG OWNER: the folder belongs to another owner", () => {
    const d = decideDestination(okFacts({ folder: { id: FOLDER, ownerId: U(9), kind: "tax", trashed: false } }))
    expect(d.ok).toBe(false); expect(d.error).toMatch(/not in the place you chose/)
  })
  it("no folder at all", () => { expect(decideDestination(okFacts({ folder: null })).ok).toBe(false) })
  it("TRASHED folder", () => {
    const d = decideDestination(okFacts({ folder: { id: FOLDER, ownerId: OWNER, kind: "tax", trashed: true } }))
    expect(d.error).toMatch(/trash/)
  })
  it("STUDY-ONLY / Drive-only / closed company: the plain sentence from the no-storage rules", () => {
    expect(decideDestination(okFacts({ owner: { id: OWNER, kind: "company", studyOnly: true, accountId: "a", contactId: null }, noStorageSentence: NO_STORAGE_REASON_SENTENCE.frozen })).error).toBe(NO_STORAGE_REASON_SENTENCE.frozen)
    expect(decideDestination(okFacts({ owner: { id: OWNER, kind: "company", studyOnly: true, accountId: "a", contactId: null }, noStorageSentence: NO_STORAGE_REASON_SENTENCE.archived })).error).toBe(NO_STORAGE_REASON_SENTENCE.archived)
    expect(decideDestination(okFacts({ companyState: "drive", noStorageSentence: NO_STORAGE_REASON_SENTENCE.no_folder })).ok).toBe(false)
  })
  it("a company mid-move that has no live storage yet is told it is MOVING (never the old-folder sentence)", () => {
    const d = decideDestination(okFacts({ owner: { id: OWNER, kind: "company", studyOnly: true, accountId: "a", contactId: null }, companyState: "moving", noStorageSentence: NO_STORAGE_REASON_SENTENCE.frozen }))
    expect(d.error).toBe(NO_STORAGE_REASON_SENTENCE.moving)
    expect(d.error).not.toMatch(/Drive/)
  })
  it("MOVING company", () => { expect(decideDestination(okFacts({ companyState: "moving" })).error).toBe(NO_STORAGE_REASON_SENTENCE.moving) })
  it("the top folder of a client takes no file; '2. Contacts' neither", () => {
    expect(decideDestination(okFacts({ folder: { id: FOLDER, ownerId: OWNER, kind: "root", trashed: false } })).error).toMatch(/Open one of the folders first/)
    expect(decideDestination(okFacts({ folder: { id: FOLDER, ownerId: OWNER, kind: "contacts", trashed: false } })).ok).toBe(false)
  })
  it("a new folder: the top of Business is fine as its parent; a bad name is refused; a name that already exists is simply used (a retry)", () => {
    const biz = { owner: { id: OWNER, kind: "business", studyOnly: false, accountId: null, contactId: null }, companyState: null, folder: { id: FOLDER, ownerId: OWNER, kind: "root", trashed: false } }
    expect(decideDestination(okFacts({ ...biz, newFolderName: "Fax" })).ok).toBe(true)
    expect(decideDestination(okFacts({ ...biz, newFolderName: "a/b" })).ok).toBe(false)
  })
  it("a person's identity paper never goes into a company's or person's storage; Business and My files take it", () => {
    expect(decideDestination(okFacts({ fileName: "Passport.pdf" })).error).toMatch(/person's own paper/)
    expect(decideDestination(okFacts({ owner: { id: OWNER, kind: "person", studyOnly: false, accountId: null, contactId: "c" }, companyState: null, fileName: "W-7.pdf" })).ok).toBe(false)
    expect(decideDestination(okFacts({ owner: { id: OWNER, kind: "business", studyOnly: false, accountId: null, contactId: null }, companyState: null, fileName: "Passport.pdf" })).ok).toBe(true)
  })
  it("renaming a passport to something harmless does not get past the check (the uploaded name counts too)", () => {
    expect(decideDestination(okFacts({ fileName: "doc.pdf", uploadName: "Passport.pdf" })).ok).toBe(false)
    expect(decideDestination(okFacts({ fileName: "doc.pdf", uploadName: "SS-4.pdf" }))).toEqual({ ok: true, unlinked: true })
  })
  it("an SS-4 / 1040 is allowed in a company's storage but kept OFF the company's Documents tab (unlinked)", () => {
    expect(decideDestination(okFacts({ fileName: "SS-4 Acme.pdf" }))).toEqual({ ok: true, unlinked: true })
    expect(decideDestination(okFacts({ owner: { id: OWNER, kind: "business", studyOnly: false, accountId: null, contactId: null }, companyState: null, fileName: "SS-4.pdf" }))).toEqual({ ok: true, unlinked: false })
  })
})

const deps = (state: { owner?: OwnerRow | null; folder?: { id: string; owner_id: string; kind: string; trashed_at: string | null } | null; companyState?: "store" | "moving" | "drive"; access?: boolean; }): DestinationDeps => ({
  readOwner: async () => state.owner === undefined ? { id: OWNER, kind: "company", study_only: false, account_id: "acc-1", contact_id: null, service_delivery_id: null } : state.owner,
  readFolder: async () => state.folder === undefined ? { id: FOLDER, owner_id: OWNER, kind: "tax", trashed_at: null } : state.folder,
  companyState: async () => state.companyState ?? "store",
  noStorageSentence: async () => NO_STORAGE_REASON_SENTENCE.frozen,
  access: async () => state.access ?? true,
})
const choice: SaveChoiceSave = { mode: "save", purpose: "irs_tax_return", ownerId: OWNER, folderId: FOLDER, newFolderName: null, fileName: "2025 Tax Return", proposalOf: null }

describe("validateDestination — reads the live facts, then decides", () => {
  it("keeps the extension of the uploaded file when the typed name has none", async () => {
    const v = await validateDestination(choice, deps({}), "signed.pdf")
    expect(v.decision.ok).toBe(true); expect(v.finalName).toBe("2025 Tax Return.pdf")
  })
  it("a study-only company that is mid-move is read for its move too: the MOVING sentence", async () => {
    const v = await validateDestination(choice, deps({ owner: { id: OWNER, kind: "company", study_only: true, account_id: "acc-1", contact_id: null, service_delivery_id: null }, companyState: "moving" }), "a.pdf")
    expect(v.decision.error).toBe(NO_STORAGE_REASON_SENTENCE.moving)
  })
  it("wrong owner / trashed / study-only / moving / no access are each refused", async () => {
    expect((await validateDestination(choice, deps({ folder: { id: FOLDER, owner_id: U(9), kind: "tax", trashed_at: null } }), "a.pdf")).decision.ok).toBe(false)
    expect((await validateDestination(choice, deps({ folder: { id: FOLDER, owner_id: OWNER, kind: "tax", trashed_at: "2026-01-01" } }), "a.pdf")).decision.ok).toBe(false)
    const study = await validateDestination(choice, deps({ owner: { id: OWNER, kind: "company", study_only: true, account_id: "acc-1", contact_id: null, service_delivery_id: null } }), "a.pdf")
    expect(study.decision.error).toBe(NO_STORAGE_REASON_SENTENCE.frozen)
    expect((await validateDestination(choice, deps({ companyState: "moving" }), "a.pdf")).decision.error).toBe(NO_STORAGE_REASON_SENTENCE.moving)
    expect((await validateDestination(choice, deps({ access: false }), "a.pdf")).decision.ok).toBe(false)
    expect((await validateDestination(choice, deps({ owner: null }), "a.pdf")).decision.ok).toBe(false)
  })
  it("a read error is an error (never a yes)", async () => {
    const d = deps({}); d.readFolder = async () => { throw new Error("db down") }
    await expect(validateDestination(choice, d, "a.pdf")).rejects.toThrow("db down")
  })
  it("a name with only an extension is refused", async () => {
    const v = await validateDestination({ ...choice, fileName: ".pdf" }, deps({}), "a.pdf")
    expect(v.decision.ok).toBe(false)
  })
})

function fileDeps(log: string[] = []) {
  const files = new Map<string, { fileId: string; name: string }>()
  const rows: Array<Record<string, unknown>> = []
  const d: FileDeps = {
    ensureFolder: async (p, n) => { log.push(`folder:${p}:${n}`); return U(77) },
    save: async (p) => {
      log.push(`save:${p.documentType}:${p.folderId}:${p.name}`)
      const have = files.get(p.callerKey)
      if (have) return { fileId: have.fileId, status: "unchanged", name: have.name }
      const f = { fileId: U(100 + files.size), name: p.name }; files.set(p.callerKey, f)
      return { fileId: f.fileId, status: "created", name: p.name }
    },
    upsertRow: async (fileId, row) => { const ex = rows.find((r) => r.fileId === fileId); if (ex) return { id: String(ex.id) }; const r = { ...row, fileId, id: `row-${rows.length + 1}` }; rows.push(r); return { id: String(r.id) } },
    trash: async (id) => { log.push(`trash:${id}`) },
    rowLinks: async (o) => ({ account: o.account_id, contact: o.contact_id }),
    pathOf: async () => "Acme › 3. Tax › 2025",
    documentTypeLabel: async (s) => (s === "irs_fax" ? "IRS Fax" : "Other document"),
  }
  return { d, rows, files, log }
}
const company: OwnerRow = { id: OWNER, kind: "company", study_only: false, account_id: "acc-1", contact_id: null, service_delivery_id: null }
const input = { bytes: Buffer.from("%PDF"), mimeType: "application/pdf", sha256: "h1", actor: null, unlinked: false, finalName: "2025 Tax Return.pdf" }

describe("saveToDestination — files through the storage writer", () => {
  it("a company: type IRS Fax, hidden from the client, listed against the company", async () => {
    const f = fileDeps()
    const r = await saveToDestination(choice, company, input, f.d)
    expect(r).toMatchObject({ documentType: "irs_fax", accountId: "acc-1", write: "created", path: "Acme › 3. Tax › 2025" })
    expect(f.rows[0]).toMatchObject({ account_id: "acc-1", portal_visible: false, document_type_name: "IRS Fax" })
  })
  it("the SAME file twice = ONE file and ONE row", async () => {
    const f = fileDeps()
    const a = await saveToDestination(choice, company, input, f.d)
    const b = await saveToDestination(choice, company, input, f.d)
    expect(b.write).toBe("unchanged"); expect(b.fileId).toBe(a.fileId); expect(b.documentRowId).toBe(a.documentRowId)
    expect(f.files.size).toBe(1); expect(f.rows).toHaveLength(1)
  })
  it("a DIFFERENT file with the same name is a different file (the writer adds its '(2)')", async () => {
    const f = fileDeps()
    await saveToDestination(choice, company, input, f.d)
    await saveToDestination(choice, company, { ...input, sha256: "h2" }, f.d)
    expect(f.files.size).toBe(2)
    expect(saveCallerKey(OWNER, FOLDER, "A.pdf", "x")).not.toBe(saveCallerKey(OWNER, FOLDER, "A.pdf", "y"))
  })
  it("a new folder is made first (Business › Fax); the firm's own areas get NO CRM row and no type", async () => {
    const f = fileDeps()
    const biz: OwnerRow = { id: OWNER, kind: "business", study_only: false, account_id: null, contact_id: null, service_delivery_id: null }
    const r = await saveToDestination({ ...choice, purpose: "third_party", newFolderName: "Fax" }, biz, input, f.d)
    expect(f.log[0]).toBe(`folder:${FOLDER}:Fax`)
    expect(f.log[1]).toBe(`save:null:${U(77)}:2025 Tax Return.pdf`)
    expect(r.documentRowId).toBeNull(); expect(f.rows).toHaveLength(0)
  })
  it("an SS-4 / 1040: listed against NO company", async () => {
    const f = fileDeps()
    await saveToDestination(choice, company, { ...input, unlinked: true }, f.d)
    expect(f.rows[0]).toMatchObject({ account_id: null, contact_id: null })
  })
  it("saved but not listed → the new file is trashed again and the error is raised", async () => {
    const f = fileDeps(); f.d.upsertRow = async () => { throw new Error("list failed") }
    await expect(saveToDestination(choice, company, input, f.d)).rejects.toThrow("list failed")
    expect(f.log.some((l) => l.startsWith("trash:"))).toBe(true)
  })
})

const rdeps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  liveOwnerOfAccount: async () => OWNER, companyState: async () => "store", noStorageSentenceForAccount: async () => NO_STORAGE_REASON_SENTENCE.archived,
  folderOfKind: async (_o, k) => (k === "tax" ? U(20) : U(21)), businessOwnerId: async () => U(30), topFolder: async () => U(31),
  childFolderId: async () => null, pathOf: async (f) => (f === U(20) ? "Acme › 3. Tax" : f === U(21) ? "Acme › 1. Company" : "Business"), ...over,
})
const acme = { kind: "company" as const, accountId: "acc-1", name: "Acme" }

describe("resolveProposal — the proposal as real ids", () => {
  it("tax return: the year's folder if it exists, else the Tax folder + the year to make", async () => {
    const p = proposeFaxPlace({ purpose: "irs_tax_return", company: acme, fileName: "2025 Tax Return.pdf", now: new Date("2026-10-20") })
    const made = await resolveProposal(p, rdeps())
    expect(made).toMatchObject({ state: "proposed", ownerId: OWNER, folderId: U(20), newFolderName: "2025", path: "Acme › 3. Tax › 2025", documentType: "irs_fax" })
    const have = await resolveProposal(p, rdeps({ childFolderId: async () => U(40), pathOf: async () => "Acme › 3. Tax › 2025" }))
    expect(have).toMatchObject({ folderId: U(40), newFolderName: null })
  })
  it("EIN request → the company folder; third party → Business › Fax (made if missing)", async () => {
    expect(await resolveProposal(proposeFaxPlace({ purpose: "irs_ein_request", company: acme, fileName: "x.pdf" }), rdeps())).toMatchObject({ folderId: U(21), newFolderName: null })
    expect(await resolveProposal(proposeFaxPlace({ purpose: "third_party", company: null, fileName: "x.pdf" }), rdeps())).toMatchObject({ ownerId: U(30), folderId: U(31), newFolderName: "Fax", documentType: null })
  })
  it("a company with no storage / being moved → refused with the plain sentence (nothing proposed)", async () => {
    const p = proposeFaxPlace({ purpose: "irs_tax_return", company: acme, fileName: "2025.pdf" })
    expect(await resolveProposal(p, rdeps({ liveOwnerOfAccount: async () => null }))).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE.archived })
    expect(await resolveProposal(p, rdeps({ companyState: async () => "moving" }))).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE.moving })
  })
  it("'choose' passes straight through", async () => {
    expect((await resolveProposal(proposeFaxPlace({ purpose: "something_else", company: null, fileName: "x" }), rdeps())).state).toBe("choose")
  })
})

describe("every refusal shows ITS OWN sentence — Drive wording only for a company that stays in its old folder", () => {
  const sentence = (state: "store" | "moving" | "drive", reason: keyof typeof NO_STORAGE_REASON_SENTENCE) =>
    noStorageSentenceFor("acc-1", { companyState: async () => state, decisionSentence: async () => NO_STORAGE_REASON_SENTENCE[reason] })
  it("moving → the moving sentence, whatever the other facts say", async () => {
    for (const r of ["frozen", "archived", "no_folder", "no_company"] as const) expect(await sentence("moving", r)).toBe(NO_STORAGE_REASON_SENTENCE.moving)
  })
  it("not moving → the true reason from no-storage: archived / no folder / no company / frozen", async () => {
    for (const r of ["frozen", "archived", "no_folder", "no_company"] as const) expect(await sentence("drive", r)).toBe(NO_STORAGE_REASON_SENTENCE[r])
  })
  it("only the 'frozen' sentence mentions Google Drive", () => {
    for (const [reason, text] of Object.entries(NO_STORAGE_REASON_SENTENCE)) {
      if (reason === "frozen") expect(text).toMatch(/Drive/)
      else expect(text, reason).not.toMatch(/Drive/i)
    }
  })
  it("resolveProposal: a mid-move company with no live storage → the MOVING sentence (checked before 'no storage')", async () => {
    const p = proposeFaxPlace({ purpose: "irs_tax_return", company: acme, fileName: "2025.pdf" })
    const r = await resolveProposal(p, rdeps({ liveOwnerOfAccount: async () => null, companyState: async () => "moving", noStorageSentenceForAccount: async () => NO_STORAGE_REASON_SENTENCE.frozen }))
    expect(r).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE.moving })
  })
  it("resolveProposal: each no-storage reason keeps its own sentence", async () => {
    const p = proposeFaxPlace({ purpose: "irs_ein_request", company: acme, fileName: "x.pdf" })
    for (const reason of ["archived", "no_folder", "frozen", "no_company"] as const) {
      const r = await resolveProposal(p, rdeps({ liveOwnerOfAccount: async () => null, noStorageSentenceForAccount: async () => NO_STORAGE_REASON_SENTENCE[reason] }))
      expect(r).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE[reason] })
    }
  })
})

describe("verifyProposalStillHolds — a stale proposal is refused", () => {
  const fromProposal = (over: Partial<SaveChoiceSave> = {}): SaveChoiceSave => ({
    mode: "save", purpose: "irs_tax_return", ownerId: OWNER, folderId: U(20), newFolderName: "2025", fileName: "2025 Tax Return.pdf",
    proposalOf: { accountId: "acc-1", business: false }, ...over,
  })
  it("the place the rules give now = the place sent → fine", async () => {
    expect((await verifyProposalStillHolds(fromProposal(), rdeps())).ok).toBe(true)
  })
  it("the name was edited to 2019 but the 2025 place was sent → refused", async () => {
    const r = await verifyProposalStillHolds(fromProposal({ fileName: "2019 Tax Return.pdf" }), rdeps())
    expect(r).toEqual({ ok: false, error: PROPOSAL_CHANGED_SENTENCE })
  })
  it("the company changed (other owner) → refused; the place is no longer proposable → refused", async () => {
    expect((await verifyProposalStillHolds(fromProposal(), rdeps({ liveOwnerOfAccount: async () => U(9) }))).ok).toBe(false)
    expect((await verifyProposalStillHolds(fromProposal(), rdeps({ companyState: async () => "moving" }))).ok).toBe(false)
    expect((await verifyProposalStillHolds(fromProposal({ proposalOf: { accountId: null, business: false } }), rdeps())).ok).toBe(false)
  })
  it("the year folder was made since the proposal (a retry): the same place → fine", async () => {
    const r = await verifyProposalStillHolds(fromProposal(), rdeps({ childFolderId: async () => U(40) }))
    expect(r.ok).toBe(true)
  })
  it("a place staff picked themselves (Change place) is not re-derived", async () => {
    expect((await verifyProposalStillHolds(fromProposal({ proposalOf: null, fileName: "2019 anything" }), rdeps())).ok).toBe(true)
  })
  it("a lookup error is a refusal, never a yes", async () => {
    expect((await verifyProposalStillHolds(fromProposal(), rdeps({ liveOwnerOfAccount: async () => { throw new Error("db") } }))).ok).toBe(false)
  })
})
