import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }))

import { backupOwner, type BackupIO, type OwnerSnap, type BackupConfig, type RefRow } from "@/lib/crm-store/backup"
import type { DriveTaggedItem } from "@/lib/google-drive"

// Change Name (Track S4): what the one-way Drive backup does when a company's folders are moved into "Previous names" and a fresh
// standard set is created. The fake Drive enforces the REAL database rule UNIQUE(provider, direction, external_id): one CRM folder per
// Drive folder. Production runs FRESH mode (patches by CRM id, adopts nothing); the older adopt-existing-folders mode is tested too.
const FRESH: BackupConfig = { mainDriveId: "MAIN", companiesRoot: "C", peopleRoot: "CONTACTS", fresh: true }
const ADOPT: BackupConfig = { mainDriveId: "MAIN", companiesRoot: "C", peopleRoot: "CONTACTS" }
type Snap = Omit<OwnerSnap, "backupRefs" | "importRefs">

const NAMES: Record<string, string> = { company: "1. Company", tax: "3. Tax", banking: "4. Banking", correspondence: "5. Correspondence" }
const MOVED = Object.keys(NAMES)

const base = (over: Partial<Snap> = {}): Snap => ({
  id: "o1", kind: "company", state: "Wyoming", accountFolderId: null, accountFolderTakenByOther: false, firstBackupAt: null,
  folders: [
    { id: "root", parent_id: null, name: "Acme LLC", trashed_at: null, kind: "root" },
    { id: "company", parent_id: "root", name: "1. Company", trashed_at: null, kind: "company" },
    { id: "contacts", parent_id: "root", name: "2. Contacts", trashed_at: null, kind: "contacts" },
    { id: "tax", parent_id: "root", name: "3. Tax", trashed_at: null, kind: "tax" },
    { id: "banking", parent_id: "root", name: "4. Banking", trashed_at: null, kind: "banking" },
    { id: "correspondence", parent_id: "root", name: "5. Correspondence", trashed_at: null, kind: "correspondence" },
    { id: "y25", parent_id: "tax", name: "2025", trashed_at: null, kind: "tax_year" },
  ],
  files: [
    { id: "f-oa", folder_id: "company", name: "Operating Agreement.pdf", state: "live", sha256: "a".repeat(64), bucket: "crm-store", path: "o1/a", size: 4, mime: "application/pdf" },
    { id: "f-welcome", folder_id: "correspondence", name: "Welcome.pdf", state: "live", sha256: "b".repeat(64), bucket: "crm-store", path: "o1/b", size: 4, mime: "application/pdf" },
    { id: "f-ret", folder_id: "y25", name: "Form 1120 2025.pdf", state: "live", sha256: "c".repeat(64), bucket: "crm-store", path: "o1/c", size: 4, mime: "application/pdf" },
  ],
  ...over,
})

/** The same change store_apply_name_change makes to the tree (ids are what the function would create). */
function applyChange(s: Snap, a: { newName: string; archiveRoot?: string; archiveChild: string; fresh: Record<string, string> }): Snap {
  const root = s.folders.find((f) => f.parent_id === null)!
  const folders = s.folders.map((f) =>
    f.id === root.id ? { ...f, name: a.newName } : f.parent_id === root.id && f.kind && MOVED.includes(f.kind) ? { ...f, parent_id: a.archiveChild } : f)
  const hasArchiveRoot = folders.find((f) => f.name === "Previous names" && f.parent_id === root.id)
  const archiveRoot = hasArchiveRoot?.id ?? a.archiveRoot!
  if (!hasArchiveRoot) folders.push({ id: archiveRoot, parent_id: root.id, name: "Previous names", trashed_at: null, kind: "custom" })
  folders.push({ id: a.archiveChild, parent_id: archiveRoot, name: root.name, trashed_at: null, kind: "custom" })
  for (const k of MOVED) folders.push({ id: a.fresh[k], parent_id: root.id, name: NAMES[k], trashed_at: null, kind: k })
  return { ...s, folders }
}

function world(initial: Snap, cfgFresh: boolean) {
  const state = { snap: initial }
  const items = new Map<string, DriveTaggedItem>()
  const refs = new Map<string, RefRow>()
  const places = new Map<string, string>()
  let n = 0
  let leased = false
  const add = (it: DriveTaggedItem) => { items.set(it.id, it); return it }
  const io: BackupIO = {
    claim: async () => (leased ? { claimed: false } : ((leased = true), { claimed: true, token: "t", upTo: 7, fullCheckDue: false })),
    finish: async () => { leased = false },
    noteError: async () => undefined,
    load: async () => ({ ...state.snap, backupRefs: new Map(refs), importRefs: new Map() }),
    currentOwner: async () => "o1",
    // THE REAL RULE: UNIQUE (provider, direction, external_id) — a Drive folder/file belongs to ONE CRM object
    recordRef: async (kind, id, ext, sha, path, status = "ok") => {
      for (const [other, r] of Array.from(refs.entries())) if (other !== id && r.external_id === ext) throw new Error(`duplicate key value violates unique constraint "store_external_refs_provider_direction_external_id_key" (${kind} ${id} vs ${other})`)
      refs.set(id, { external_id: ext, backed_up_sha256: sha, drive_path: { ...(refs.get(id)?.drive_path ?? {}), ...path }, status })
    },
    place: async (key) => (places.has(key) ? { driveId: places.get(key) } : { claim: `claim:${key}` }),
    placeSet: async (key, _t, id) => { places.set(key, id); return true },
    placeReset: async (key) => places.delete(key),
    open: async (_b, p) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(p)); c.close() } }),
    find: async (k, v) => Array.from(items.values()).filter((i) => i.appProperties?.[k] === v && !i.trashed),
    get: async (id) => items.get(id) ?? null,
    childFolders: async (id) => Array.from(items.values()).filter((i) => (i.parents ?? []).includes(id) && !i.trashed && !i.size),
    createFolder: async (parent, name, tags) => add({ id: `d${++n}`, name, parents: [parent], appProperties: tags }),
    patch: async (id, p) => { const it = items.get(id)!; if (p.name) it.name = p.name; if (p.newParentId) it.parents = [p.newParentId]; return it },
    upload: async (p) => add({ id: `d${++n}`, name: p.name, parents: [p.parentId!], appProperties: p.appProperties, size: "4" }),
    trash: async (id) => { items.get(id)!.trashed = true },
  }
  const run = (extra: Record<string, unknown> = {}) => backupOwner("o1", { io, config: cfgFresh ? FRESH : ADOPT, force: true, ...extra })
  /** the Drive path of a CRM object, by name, from the Companies root down */
  const pathOf = (crmId: string): string => {
    const names: string[] = []
    let cur: DriveTaggedItem | undefined = items.get(refs.get(crmId)!.external_id)
    while (cur && cur.id !== "C") { names.unshift(cur.name); cur = items.get((cur.parents ?? [])[0]) }
    return names.join(" / ")
  }
  return { state, io, items, refs, run, pathOf, add }
}

const FRESH_IDS = { company: "n-company", banking: "n-banking", tax: "n-tax", correspondence: "n-corr" }
const CHANGE = { newName: "Beta LLC", archiveRoot: "prev", archiveChild: "prev-acme", fresh: FRESH_IDS }

describe("backup around a name change — FRESH mode (production)", () => {
  async function started() {
    const w = world(base(), true)
    expect(await w.run()).toMatchObject({ status: "done" })
    w.state.snap = { ...w.state.snap, firstBackupAt: "2026-10-16T00:00:00Z" }     // the first fresh backup has finished
    return w
  }

  it("before the change: the whole tree is mirrored (sanity)", async () => {
    const w = await started()
    expect(w.pathOf("tax")).toBe("Wyoming / Acme LLC / 3. Tax")
    expect(w.pathOf("y25")).toBe("Wyoming / Acme LLC / 3. Tax / 2025")
    expect(w.pathOf("f-ret")).toBe("Wyoming / Acme LLC / 3. Tax / 2025 / Form 1120 2025.pdf")
  })

  it("after the change: the four Drive folders are MOVED (same Drive ids), the root is renamed, new ones made, no file re-uploaded, no failure", async () => {
    const w = await started()
    const driveIdBefore = Object.fromEntries(["root", "company", "tax", "banking", "correspondence", "y25"].map((k) => [k, w.refs.get(k)!.external_id]))
    w.state.snap = applyChange(w.state.snap, CHANGE)
    const rep = await w.run()
    expect(rep).toMatchObject({ status: "done", uploaded: 0, updated: 0, recreated: 0, removed: 0 })
    expect(rep.fileErrors).toEqual([])
    // same Drive folders, new places
    for (const k of Object.keys(driveIdBefore)) expect(w.refs.get(k)!.external_id).toBe(driveIdBefore[k])
    expect(w.pathOf("root")).toBe("Wyoming / Beta LLC")
    expect(w.pathOf("tax")).toBe("Wyoming / Beta LLC / Previous names / Acme LLC / 3. Tax")
    expect(w.pathOf("y25")).toBe("Wyoming / Beta LLC / Previous names / Acme LLC / 3. Tax / 2025")
    // the files travel with their folders: nothing was uploaded again
    expect(w.pathOf("f-ret")).toBe("Wyoming / Beta LLC / Previous names / Acme LLC / 3. Tax / 2025 / Form 1120 2025.pdf")
    expect(w.pathOf("f-oa")).toBe("Wyoming / Beta LLC / Previous names / Acme LLC / 1. Company / Operating Agreement.pdf")
    // the fresh standard folders are NEW Drive folders under the renamed root
    expect(w.pathOf("n-tax")).toBe("Wyoming / Beta LLC / 3. Tax")
    expect(w.pathOf("n-company")).toBe("Wyoming / Beta LLC / 1. Company")
    expect(new Set(Array.from(w.refs.values()).map((r) => r.external_id)).size).toBe(w.refs.size)   // one CRM object per Drive id
  })

  it("a file saved into the fresh folder after the change goes into the fresh Drive folder", async () => {
    const w = await started()
    w.state.snap = applyChange(w.state.snap, CHANGE)
    await w.run()
    w.state.snap = { ...w.state.snap, files: [...w.state.snap.files, { id: "f-new", folder_id: "n-tax", name: "New Tax Letter.pdf", state: "live", sha256: "d".repeat(64), bucket: "crm-store", path: "o1/d", size: 4, mime: "application/pdf" }] }
    expect(await w.run()).toMatchObject({ status: "done", uploaded: 1 })
    expect(w.pathOf("f-new")).toBe("Wyoming / Beta LLC / 3. Tax / New Tax Letter.pdf")
  })

  it("after an UNDO: the old Drive folders move back and the root gets its name back; the unused new Drive folders stay (empty), nothing is trashed or failed", async () => {
    const w = await started()
    const original = w.state.snap
    w.state.snap = applyChange(original, CHANGE)
    await w.run()
    w.state.snap = original                                                        // the undo removed the archive + the fresh folders and moved the four back
    const rep = await w.run()
    expect(rep).toMatchObject({ status: "done", uploaded: 0, updated: 0, recreated: 0, removed: 0 })
    expect(w.pathOf("root")).toBe("Wyoming / Acme LLC")
    expect(w.pathOf("tax")).toBe("Wyoming / Acme LLC / 3. Tax")
    expect(w.pathOf("f-ret")).toBe("Wyoming / Acme LLC / 3. Tax / 2025 / Form 1120 2025.pdf")
    // the Drive folders made for the (deleted) new set are left alone — harmless empty folders in the backup
    expect(w.items.get(w.refs.get("n-tax")!.external_id)!.trashed).toBeFalsy()
  })

  it("undo, then apply again with new ids: new Drive folders, no clash with the leftovers", async () => {
    const w = await started()
    const original = w.state.snap
    w.state.snap = applyChange(original, CHANGE)
    await w.run()
    w.state.snap = original
    await w.run()
    w.state.snap = applyChange(original, { newName: "Gamma LLC", archiveRoot: "prev2", archiveChild: "prev2-acme", fresh: { company: "m-company", banking: "m-banking", tax: "m-tax", correspondence: "m-corr" } })
    expect(await w.run()).toMatchObject({ status: "done", recreated: 0 })
    expect(w.pathOf("root")).toBe("Wyoming / Gamma LLC")
    expect(w.pathOf("m-tax")).toBe("Wyoming / Gamma LLC / 3. Tax")
    expect(w.pathOf("tax")).toBe("Wyoming / Gamma LLC / Previous names / Acme LLC / 3. Tax")
  })

  it("A -> B -> C: the second change archives the first change's fresh set under its own old name", async () => {
    const w = await started()
    w.state.snap = applyChange(w.state.snap, CHANGE)
    await w.run()
    w.state.snap = applyChange(w.state.snap, { newName: "Gamma LLC", archiveChild: "prev-beta", fresh: { company: "m-company", banking: "m-banking", tax: "m-tax", correspondence: "m-corr" } })
    expect(await w.run()).toMatchObject({ status: "done" })
    expect(w.pathOf("tax")).toBe("Wyoming / Gamma LLC / Previous names / Acme LLC / 3. Tax")
    expect(w.pathOf("n-tax")).toBe("Wyoming / Gamma LLC / Previous names / Beta LLC / 3. Tax")
    expect(w.pathOf("m-tax")).toBe("Wyoming / Gamma LLC / 3. Tax")
  })
})

describe("backup around a name change — ADOPT mode (the older mode: a company's existing Drive folder is adopted)", () => {
  async function started() {
    const w = world(base({ accountFolderId: "old-acme" }), false)
    w.add({ id: "old-acme", name: "Acme LLC", parents: ["C"] })
    for (const [id, name] of [["d-company", "1. Company"], ["d-tax", "3. Tax"], ["d-banking", "4. Banking"], ["d-corr", "5. Correspondence"]]) w.add({ id, name, parents: ["old-acme"] })
    w.add({ id: "d-y25", name: "2025", parents: ["d-tax"] })
    expect(await w.run()).toMatchObject({ status: "done" })
    return w
  }

  it("the existing Drive folders were adopted by name (so the name change below really starts from the adopted state)", async () => {
    const w = await started()
    expect(w.refs.get("tax")!.external_id).toBe("d-tax")
    expect(w.refs.get("tax")!.drive_path.adopted).toBe(true)
    expect(w.refs.get("root")!.external_id).toBe("old-acme")
  })

  it("after the change the fresh '3. Tax' must NOT adopt the Drive folder the archived Tax already owns (it would break UNIQUE(external_id) and stop the whole backup)", async () => {
    const w = await started()
    w.state.snap = applyChange(w.state.snap, CHANGE)
    const rep = await w.run()
    expect(rep.error).toBeUndefined()
    expect(rep.status).toBe("done")
    // the archived Tax keeps its adopted Drive folder (adopted folders are fixed: never moved or renamed)
    expect(w.refs.get("tax")!.external_id).toBe("d-tax")
    // the fresh set got its OWN new Drive folders
    for (const id of Object.values(FRESH_IDS)) expect(["d-company", "d-tax", "d-banking", "d-corr"]).not.toContain(w.refs.get(id)!.external_id)
    expect(new Set(Array.from(w.refs.values()).map((r) => r.external_id)).size).toBe(w.refs.size)
    // …and new files in the fresh Tax folder do not land in the archived (adopted) Drive Tax folder
    expect(w.items.get(w.refs.get("n-tax")!.external_id)!.id).not.toBe("d-tax")
  })
})
