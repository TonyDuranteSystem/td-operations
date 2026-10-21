/**
 * The sandbox script t60 (scripts/crm-store/qa-cutover/t60-save-where-fax.ts) proves the same chain against the real database;
 * CI cannot reach a database, so its key checks run here against a small IN-MEMORY storage that implements the same dependencies:
 * proposal → real place → check → file (what the Fax send route does around the send).
 */
import { describe, it, expect } from "vitest"
import {
  resolveProposal, validateDestination, saveToDestination, saveCallerKey,
  type DestinationDeps, type FileDeps, type OwnerRow, type ResolveDeps, type SaveChoiceSave,
} from "@/lib/crm-store/save-destination"
import { proposeFaxPlace, type FaxPurpose, type PlaceOwnerRef } from "@/lib/crm-store/save-where"
import { NO_STORAGE_REASON_SENTENCE } from "@/lib/crm-store/no-storage"

interface F { id: string; owner: string; parent: string | null; kind: string; name: string; trashed: boolean }
function memory() {
  let n = 0
  const id = (p: string) => `${p}-${++n}`
  const owners = new Map<string, OwnerRow>()
  const folders = new Map<string, F>()
  const files = new Map<string, { id: string; name: string; folder: string; type: string | null; key: string }>()
  const rows: Array<Record<string, unknown>> = []
  const states = new Map<string, "store" | "moving" | "drive">()
  const addOwner = (kind: string, account: string | null, studyOnly = false) => {
    const o: OwnerRow = { id: id("owner"), kind, study_only: studyOnly, account_id: account, contact_id: null, service_delivery_id: null }
    owners.set(o.id, o)
    const root: F = { id: id("root"), owner: o.id, parent: null, kind: "root", name: kind === "business" ? "Business" : `Co ${account}`, trashed: false }
    folders.set(root.id, root)
    return { owner: o, root }
  }
  const addFolder = (owner: string, parent: string, kind: string, name: string) => { const f: F = { id: id("f"), owner, parent, kind, name, trashed: false }; folders.set(f.id, f); return f }
  const company = (acc: string) => {
    const { owner, root } = addOwner("company", acc)
    const tax = addFolder(owner.id, root.id, "tax", "3. Tax"), own = addFolder(owner.id, root.id, "company", "1. Company")
    return { owner, root, tax, own }
  }
  const byParent = (p: string) => Array.from(folders.values()).filter((f) => f.parent === p && !f.trashed)
  const path = (fid: string): string => { const f = folders.get(fid)!; return f.parent ? `${path(f.parent)} › ${f.name}` : f.name }
  const login = { access: true }

  const rdeps: ResolveDeps = {
    liveOwnerOfAccount: async (a) => Array.from(owners.values()).find((o) => o.account_id === a && !o.study_only)?.id ?? null,
    companyState: async (a) => states.get(a) ?? "store",
    noStorageSentenceForAccount: async () => NO_STORAGE_REASON_SENTENCE.no_folder,
    folderOfKind: async (o, k) => Array.from(folders.values()).find((f) => f.owner === o && f.kind === k)!.id,
    businessOwnerId: async () => Array.from(owners.values()).find((o) => o.kind === "business")!.id,
    topFolder: async (o) => Array.from(folders.values()).find((f) => f.owner === o && f.parent === null)!.id,
    childFolderId: async (p, name) => byParent(p).find((f) => f.name.toLowerCase() === name.toLowerCase())?.id ?? null,
    pathOf: async (fid) => path(fid),
  }
  const ddeps: DestinationDeps = {
    readOwner: async (o) => owners.get(o) ?? null,
    readFolder: async (f) => { const x = folders.get(f); return x ? { id: x.id, owner_id: x.owner, kind: x.kind, trashed_at: x.trashed ? "t" : null } : null },
    companyState: async (a) => states.get(a) ?? "store",
    noStorageSentence: async () => NO_STORAGE_REASON_SENTENCE.frozen,
    access: async () => login.access,
  }
  const fdeps: FileDeps = {
    ensureFolder: async (parent, name) => byParent(parent).find((f) => f.name.toLowerCase() === name.toLowerCase())?.id
      ?? addFolder(folders.get(parent)!.owner, parent, /^\d{4}$/.test(name) && folders.get(parent)!.kind === "tax" ? "tax_year" : "custom", name).id,
    save: async (p) => {
      const have = files.get(p.callerKey)
      if (have) return { fileId: have.id, status: "unchanged", name: have.name }
      const clash = Array.from(files.values()).filter((f) => f.folder === p.folderId && f.name.replace(/ \(\d+\)(?=\.[^.]*$)/, "") === p.name).length
      const name = clash ? p.name.replace(/(\.[^.]*)$/, ` (${clash + 1})$1`) : p.name
      const f = { id: id("file"), name, folder: p.folderId, type: p.documentType, key: p.callerKey }
      files.set(p.callerKey, f)
      return { fileId: f.id, status: "created", name }
    },
    upsertRow: async (fileId, row) => { const ex = rows.find((r) => r.fileId === fileId); if (ex) return { id: String(ex.id) }; const r = { ...row, fileId, id: id("row") }; rows.push(r); return { id: String(r.id) } },
    trash: async () => {},
    rowLinks: async (o) => ({ account: o.account_id, contact: o.contact_id }),
    pathOf: async (fid) => path(fid),
    documentTypeLabel: async (s) => (s === "irs_fax" ? "IRS Fax" : "Other document"),
  }
  return { owners, folders, files, rows, states, company, addOwner, addFolder, rdeps, ddeps, fdeps, login, byParent }
}

const bytes = (s: string) => Buffer.from(`%PDF ${s}`)
async function run(m: ReturnType<typeof memory>, purpose: FaxPurpose, co: PlaceOwnerRef | null, typed: string, upload: string, content = "x") {
  const p = await resolveProposal(proposeFaxPlace({ purpose, company: co, fileName: typed, now: new Date("2026-10-20") }), m.rdeps)
  if (p.state !== "proposed") return { proposal: p, out: null as null | { ok: boolean; error?: string; filed?: Awaited<ReturnType<typeof saveToDestination>> } }
  const choice: SaveChoiceSave = { mode: "save", purpose, ownerId: p.ownerId, folderId: p.folderId, newFolderName: p.newFolderName, fileName: typed, proposalOf: null }
  const v = await validateDestination(choice, m.ddeps, upload)
  if (!v.decision.ok) return { proposal: p, out: { ok: false, error: v.decision.error } }
  const filed = await saveToDestination(choice, v.owner!, { bytes: bytes(content), mimeType: "application/pdf", sha256: content, actor: null, unlinked: !!v.decision.unlinked, finalName: v.finalName }, m.fdeps)
  return { proposal: p, out: { ok: true, filed } }
}

describe("the save-where chain (the t60 checks, in memory)", () => {
  it("tax return: the year folder is made, the file is typed IRS Fax, listed and hidden; the same file again = one file", async () => {
    const m = memory(); const c = m.company("acme")
    const co = { kind: "company" as const, accountId: "acme", name: "Acme LLC" }
    const r1 = await run(m, "irs_tax_return", co, "2025 Tax Return - Acme", "signed.pdf")
    expect(r1.proposal).toMatchObject({ state: "proposed", ownerId: c.owner.id, folderId: c.tax.id, newFolderName: "2025" })
    expect(r1.out!.filed).toMatchObject({ documentType: "irs_fax", path: "Co acme › 3. Tax › 2025", write: "created" })
    expect(m.folders.get(r1.out!.filed!.folderId)).toMatchObject({ kind: "tax_year", name: "2025" })
    expect(m.rows[0]).toMatchObject({ account_id: "acme", portal_visible: false, document_type_name: "IRS Fax" })
    const again = await run(m, "irs_tax_return", co, "2025 Tax Return - Acme", "signed.pdf")
    expect(again.proposal).toMatchObject({ folderId: r1.out!.filed!.folderId, newFolderName: null })   // the year folder exists now
    expect(again.out!.filed!.fileId).toBe(r1.out!.filed!.fileId); expect(m.rows).toHaveLength(1); expect(m.files.size).toBe(1)
    const other = await run(m, "irs_tax_return", co, "2025 Tax Return - Acme", "signed.pdf", "different bytes")
    expect(other.out!.filed!.name).toMatch(/\(2\)/)
  })
  it("EIN request → the company's own folder; third party → Business › Fax (made on the spot, no CRM row)", async () => {
    const m = memory(); const c = m.company("acme"); m.addOwner("business", null)
    const ein = await run(m, "irs_ein_request", { kind: "company", accountId: "acme", name: "Acme" }, "EIN", "ein.pdf")
    expect(ein.out!.filed).toMatchObject({ folderId: c.own.id, documentType: "irs_fax" })
    const third = await run(m, "third_party", null, "Fax to Bank", "x.pdf")
    expect(third.out!.filed).toMatchObject({ path: "Business › Fax", documentType: null, documentRowId: null })
    const third2 = await run(m, "third_party", null, "Another", "y.pdf")
    expect(third2.proposal).toMatchObject({ newFolderName: null })
    expect(Array.from(m.folders.values()).filter((f) => f.name === "Fax")).toHaveLength(1)
  })
  it("nothing is guessed: something else / IRS with no company / Business for a tax return propose nothing", async () => {
    const m = memory(); m.company("acme"); m.addOwner("business", null)
    for (const [purpose, co] of [["something_else", { kind: "company", accountId: "acme", name: "A" }], ["irs_tax_return", null], ["irs_tax_return", { kind: "business" }]] as Array<[FaxPurpose, PlaceOwnerRef | null]>) {
      expect((await run(m, purpose, co, "Acme 2025 Tax Return", "x.pdf")).proposal.state).toBe("choose")
    }
  })
  it("no kind of document is restricted: a passport and an SS-4 are both filed for a company and listed against it (hidden from the client)", async () => {
    const m = memory(); m.company("acme")
    const co = { kind: "company" as const, accountId: "acme", name: "Acme" }
    expect((await run(m, "irs_ein_request", co, "EIN", "Passport_Rossi.pdf")).out).toMatchObject({ ok: true })
    const ss4 = await run(m, "irs_ein_request", co, "EIN request", "SS-4_Acme_Signed_for_IRS.pdf")
    expect(ss4.out!.ok).toBe(true)
    expect(m.rows).toHaveLength(2)
    expect(m.rows[1]).toMatchObject({ account_id: "acme", portal_visible: false })
  })
  it("refusals: no storage / mid-move (own sentence), wrong owner, trashed folder, study-only", async () => {
    const m = memory(); const c = m.company("acme")
    expect((await run(m, "irs_tax_return", { kind: "company", accountId: "ghost", name: "G" }, "2025", "x.pdf")).proposal).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE.no_folder })
    m.states.set("acme", "moving")
    expect((await run(m, "irs_tax_return", { kind: "company", accountId: "acme", name: "A" }, "2025", "x.pdf")).proposal).toMatchObject({ state: "refused", why: NO_STORAGE_REASON_SENTENCE.moving })
    m.states.delete("acme")
    const biz = m.addOwner("business", null)
    const wrong = await validateDestination({ mode: "save", purpose: "something_else", ownerId: c.owner.id, folderId: biz.root.id, newFolderName: null, fileName: "x", proposalOf: null }, m.ddeps, "x.pdf")
    expect(wrong.decision.error).toMatch(/not in the place you chose/)
    c.tax.trashed = true
    const trashed = await validateDestination({ mode: "save", purpose: "something_else", ownerId: c.owner.id, folderId: c.tax.id, newFolderName: null, fileName: "x", proposalOf: null }, m.ddeps, "x.pdf")
    expect(trashed.decision.error).toMatch(/trash/)
    c.owner.study_only = true
    const study = await validateDestination({ mode: "save", purpose: "something_else", ownerId: c.owner.id, folderId: c.own.id, newFolderName: null, fileName: "x", proposalOf: null }, m.ddeps, "x.pdf")
    expect(study.decision.ok).toBe(false)
  })
  it("Change place anywhere: another company's folder, a person's storage, a NEW folder under Business made only when saved; never a new folder under a client's top", async () => {
    const m = memory(); const c = m.company("acme"); const biz = m.addOwner("business", null)
    const before = m.folders.size
    const choice: SaveChoiceSave = { mode: "save", purpose: "something_else", ownerId: biz.owner.id, folderId: biz.root.id, newFolderName: "QA Chrome Test", fileName: "Note", proposalOf: null }
    const v = await validateDestination(choice, m.ddeps, "note.pdf")
    expect(v.decision.ok).toBe(true); expect(m.folders.size).toBe(before)   // checking creates nothing
    const f = await saveToDestination(choice, v.owner!, { bytes: bytes("n"), mimeType: "application/pdf", sha256: "n", actor: null, unlinked: false, finalName: v.finalName }, m.fdeps)
    expect(f.path).toBe("Business › QA Chrome Test"); expect(m.folders.size).toBe(before + 1)
    const top = await validateDestination({ ...choice, ownerId: c.owner.id, folderId: c.root.id }, m.ddeps, "note.pdf")
    expect(top.decision.error).toMatch(/top of a client's storage/)
    expect(saveCallerKey("o", "f", "A.pdf", "h")).toBe(saveCallerKey("o", "f", "a.pdf", "h"))
  })
})
