import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }))

import { backupOwner, backupConfig, usesPrivateArea, type BackupIO, type OwnerSnap, type BackupConfig } from "@/lib/crm-store/backup"
import type { DriveTaggedItem } from "@/lib/google-drive"

// Simple mode (Antonio 2026-10-13): one Drive, no private area. People → their existing Drive contact folder or the
// "Contacts" folder; trashed copies → "_Trashed in CRM"; unfiled → "_Unfiled".
const CFG: BackupConfig = { mainDriveId: "MAIN", companiesRoot: "C", peopleRoot: "CONTACTS" }
type Snap = Omit<OwnerSnap, "backupRefs" | "importRefs">

function world(snap: Snap) {
  const items = new Map<string, DriveTaggedItem>()
  const refs = new Map<string, { external_id: string; backed_up_sha256: string | null; drive_path: Record<string, unknown>; status: string }>()
  const places = new Map<string, string>()
  let n = 0
  let leased = false
  const add = (it: DriveTaggedItem) => { items.set(it.id, it); return it }
  const io: BackupIO = {
    claim: async () => (leased ? { claimed: false } : ((leased = true), { claimed: true, token: "t", upTo: 7, fullCheckDue: false })),
    finish: async () => { leased = false },
    noteError: async () => undefined,
    load: async () => ({ ...snap, backupRefs: new Map(refs), importRefs: new Map() }),
    currentOwner: async () => "o1",
    recordRef: async (_k, id, ext, sha, path, status = "ok") => { refs.set(id, { external_id: ext, backed_up_sha256: sha, drive_path: { ...(refs.get(id)?.drive_path ?? {}), ...path }, status }) },
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
  return { io, items, refs, places, add }
}

const personSnap = (over: Partial<Snap> = {}): Snap => ({
  id: "o1", kind: "person", state: null, accountFolderId: null, accountFolderTakenByOther: false,
  folders: [
    { id: "root", parent_id: null, name: "Mario Rossi", trashed_at: null },
    { id: "pers", parent_id: "root", name: "Personal documents", trashed_at: null },
  ],
  files: [{ id: "f1", folder_id: "pers", name: "Passport.pdf", state: "live", sha256: "a".repeat(64), bucket: "crm-store", path: "o1/p", size: 4, mime: "application/pdf" }],
  ...over,
})
const go = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) => backupOwner("o1", { io: w.io, config: CFG, force: true, ...extra })

describe("simple backup mode — everything in the one client Drive", () => {
  it("needs only the main Drive, the Companies folder and the Contacts folder; the private-area settings are optional", () => {
    const c = backupConfig({ GOOGLE_SHARED_DRIVE_ID: "m", STORE_BACKUP_COMPANIES_ROOT: "c", STORE_BACKUP_PEOPLE_ROOT: "p" })
    expect(c).toMatchObject({ mainDriveId: "m", companiesRoot: "c", peopleRoot: "p" })
    expect(usesPrivateArea(c)).toBe(false)
    expect(() => backupConfig({ GOOGLE_SHARED_DRIVE_ID: "m", STORE_BACKUP_COMPANIES_ROOT: "c" })).toThrow(/must all be set/)
    expect(() => backupConfig({ GOOGLE_SHARED_DRIVE_ID: "m", STORE_BACKUP_COMPANIES_ROOT: "same", STORE_BACKUP_PEOPLE_ROOT: "same" })).toThrow(/two different folders/)
    expect(() => backupConfig({ GOOGLE_SHARED_DRIVE_ID: "m", STORE_BACKUP_COMPANIES_ROOT: "c", STORE_BACKUP_PEOPLE_ROOT: "p", STORE_BACKUP_PRIVATE_DRIVE_ID: "x" })).toThrow(/together/)
  })

  it("a person with no Drive folder gets one inside the Contacts folder, with the passport inside it", async () => {
    const w = world(personSnap())
    expect(await go(w)).toMatchObject({ status: "done", uploaded: 1 })
    const root = Array.from(w.items.values()).find((i) => i.name === "Mario Rossi")!
    expect(root.parents).toEqual(["CONTACTS"])
    const sub = Array.from(w.items.values()).find((i) => i.name === "Personal documents")!
    expect(sub.parents).toEqual([root.id])
    expect(Array.from(w.items.values()).find((i) => i.name === "Passport.pdf")!.parents).toEqual([sub.id])
    // nothing was made under the Companies folder or in any private area
    expect(Array.from(w.items.values()).some((i) => i.parents?.includes("C"))).toBe(false)
  })

  it("a person with an existing Drive contact folder: the copy goes INTO it (adopted — never renamed or moved)", async () => {
    const w = world(personSnap({ accountFolderId: "mario" }))
    w.add({ id: "mario", name: "Mario Rossi", parents: ["somewhere"] })
    await go(w)
    expect(w.items.get("mario")).toMatchObject({ name: "Mario Rossi", parents: ["somewhere"] })
    const sub = Array.from(w.items.values()).find((i) => i.name === "Personal documents")!
    expect(sub.parents).toEqual(["mario"])
    expect(Array.from(w.items.values()).find((i) => i.name === "Passport.pdf")!.parents).toEqual([sub.id])
  })

  it("two people sharing one folder do not both adopt it: the second goes to the Contacts folder", async () => {
    const w = world(personSnap({ accountFolderId: "shared", accountFolderTakenByOther: true }))
    w.add({ id: "shared", name: "2. Contacts", parents: ["acme"] })
    await go(w)
    expect(Array.from(w.items.values()).find((i) => i.name === "Mario Rossi")!.parents).toEqual(["CONTACTS"])
  })

  it("a company's '2. Contacts' view is never mirrored or adopted (a person already adopted that Drive folder) — the rest of the company backs up", async () => {
    const snap: Snap = {
      id: "o1", kind: "company", state: null, accountFolderId: "acme", accountFolderTakenByOther: false,
      folders: [
        { id: "root", parent_id: null, name: "Acme LLC", trashed_at: null, kind: "root" },
        { id: "comp", parent_id: "root", name: "1. Company", trashed_at: null, kind: "company" },
        { id: "cont", parent_id: "root", name: "2. Contacts", trashed_at: null, kind: "contacts" },
      ],
      files: [{ id: "f1", folder_id: "comp", name: "Articles.pdf", state: "live", sha256: "a".repeat(64), bucket: "crm-store", path: "o1/a", size: 4, mime: "application/pdf" }],
    }
    const w = world(snap)
    w.add({ id: "acme", name: "Acme LLC", parents: ["C"] })
    w.add({ id: "d-comp", name: "1. Company", parents: ["acme"] })
    w.add({ id: "d-cont", name: "2. Contacts", parents: ["acme"] })
    expect(await go(w)).toMatchObject({ status: "done" })
    expect(w.refs.get("comp")?.external_id).toBe("d-comp")
    expect(w.refs.has("cont")).toBe(false)
    expect(Array.from(w.items.values()).filter((i) => i.name === "2. Contacts")).toHaveLength(1)
  })

  it("a file trashed in the CRM moves its copy to one '_Trashed in CRM' folder under Companies — in the same Drive", async () => {
    const w2 = world(personSnap())
    await go(w2)
    const loadOrig = w2.io.load
    w2.io.load = async (id) => { const s = await loadOrig(id); return { ...s, files: s.files.map((f) => ({ ...f, state: "trashed" as const })) } }
    await go(w2)
    const trashRoot = Array.from(w2.items.values()).find((i) => i.name === "_Trashed in CRM")!
    expect(trashRoot.parents).toEqual(["C"])
    const perOwner = Array.from(w2.items.values()).find((i) => i.name === "Mario Rossi" && i.parents?.includes(trashRoot.id))!
    expect(perOwner).toBeTruthy()
    expect(Array.from(w2.items.values()).find((i) => i.name === "Passport.pdf")!.parents).toEqual([perOwner.id])
  })

  it("an unfiled storage goes to '_Unfiled' under Companies", async () => {
    const w = world(personSnap({ kind: "unfiled" }))
    await go(w)
    const unfiled = Array.from(w.items.values()).find((i) => i.name === "_Unfiled")!
    expect(unfiled.parents).toEqual(["C"])
    expect(Array.from(w.items.values()).find((i) => i.name === "Mario Rossi")!.parents).toEqual([unfiled.id])
  })
})
