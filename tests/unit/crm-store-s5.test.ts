import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }))

import { backupOwner, backupConfig, backupEnabled, stateFolderName, type BackupIO, type OwnerSnap, type BackupConfig } from "@/lib/crm-store/backup"
import type { DriveTaggedItem } from "@/lib/google-drive"

const CFG: BackupConfig = { mainDriveId: "MAIN", companiesRoot: "C", privateDriveId: "PRIV", restrictedRoot: "R", protectedRoot: "P" }
type Snap = Omit<OwnerSnap, "backupRefs" | "importRefs">

/** An in-memory Drive + store for one owner. */
function world(snap: Snap) {
  const items = new Map<string, DriveTaggedItem & { drive?: string }>()
  const refs = new Map<string, { external_id: string; backed_up_sha256: string | null; drive_path: Record<string, unknown>; status: string }>()
  const imports = new Map<string, { external_id: string; backed_up_sha256: string | null; drive_path: Record<string, unknown>; status: string }>()
  const places = new Map<string, string>()
  const owners = new Map<string, string>()
  let n = 0
  const calls: string[] = []
  const finished: Array<{ outcome: string; error?: string }> = []
  let leased = false
  const add = (it: DriveTaggedItem) => { items.set(it.id, it); return it }
  const io: BackupIO = {
    claim: async () => (leased ? { claimed: false } : ((leased = true), { claimed: true, token: "t", upTo: 7, fullCheckDue: false })),
    finish: async (_o, _t, outcome, _u, error) => { leased = false; finished.push({ outcome, error }) },
    noteError: async () => undefined,
    load: async () => ({ ...snap, backupRefs: new Map(refs), importRefs: new Map(imports) }),
    currentOwner: async (id) => owners.get(id) ?? "o1",
    recordRef: async (_k, id, ext, sha, path, status = "ok") => { refs.set(id, { external_id: ext, backed_up_sha256: sha, drive_path: { ...(refs.get(id)?.drive_path ?? {}), ...path }, status }) },
    place: async (key) => (places.has(key) ? { driveId: places.get(key) } : { claim: `claim:${key}` }),
    placeSet: async (key, _t, id) => { places.set(key, id); return true },
    placeReset: async (key) => places.delete(key),
    open: async (_b, p) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(p)); c.close() } }),
    find: async (k, v) => Array.from(items.values()).filter((i) => i.appProperties?.[k] === v && !i.trashed),
    get: async (id) => items.get(id) ?? null,
    childFolders: async (id) => Array.from(items.values()).filter((i) => (i.parents ?? []).includes(id) && !i.trashed && !i.size),
    createFolder: async (parent, name, tags) => { calls.push(`mkdir ${name}`); return add({ id: `d${++n}`, name, parents: [parent], appProperties: tags }) },
    patch: async (id, p) => {
      calls.push(`patch ${items.get(id)!.name}`)
      const it = items.get(id)!
      if (p.name) it.name = p.name
      if (p.newParentId) it.parents = [p.newParentId]
      return it
    },
    upload: async (p) => {
      calls.push(`${p.mode} ${p.name}`)
      if (p.mode === "update") { const it = items.get(p.fileId!)!; it.appProperties = p.appProperties; return it }
      return add({ id: `d${++n}`, name: p.name, parents: [p.parentId!], appProperties: p.appProperties, size: "4" })
    },
    trash: async (id) => { calls.push(`trash ${items.get(id)!.name}`); items.get(id)!.trashed = true },
  }
  return { io, items, refs, imports, places, owners, calls, finished, snap, add }
}

const baseSnap = (over: Partial<Snap> = {}): Snap => ({
  id: "o1", kind: "company", state: "Wyoming", accountFolderId: null, accountFolderTakenByOther: false,
  folders: [
    { id: "root", parent_id: null, name: "ACME LLC", trashed_at: null },
    { id: "co", parent_id: "root", name: "1. Company", trashed_at: null },
    { id: "tax", parent_id: "root", name: "3. Tax", trashed_at: null },
  ],
  files: [
    { id: "f1", folder_id: "co", name: "OA.pdf", state: "live", sha256: "a".repeat(64), bucket: "crm-store", path: "o1/x", size: 4, mime: "application/pdf" },
    { id: "f2", folder_id: "tax", name: "1065.pdf", state: "live", sha256: "b".repeat(64), bucket: "crm-store", path: "o1/y", size: 4, mime: "application/pdf" },
  ],
  ...over,
})
const go = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) => backupOwner("o1", { io: w.io, config: CFG, force: true, ...extra })

describe("configuration", () => {
  it("is off unless the kill switch is on; five settings and three different roots are required", async () => {
    expect(backupEnabled({})).toBe(false)
    expect(backupEnabled({ STORE_BACKUP_ENABLED: "1" })).toBe(true)
    expect(() => backupConfig({})).toThrow(/must all be set/)
    expect(() => backupConfig({ GOOGLE_SHARED_DRIVE_ID: "m", STORE_BACKUP_COMPANIES_ROOT: "x", STORE_BACKUP_PRIVATE_DRIVE_ID: "p",
                               STORE_BACKUP_RESTRICTED_ROOT: "x", STORE_BACKUP_PROTECTED_ROOT: "y" })).toThrow(/three different/)
    const w = world(baseSnap())
    expect((await backupOwner("o1", { io: w.io, config: CFG })).status).toBe("disabled")
    expect(w.calls).toEqual([])
  })
  it("maps state codes to the folder names Drive uses", () => {
    expect(stateFolderName("NM")).toBe("New Mexico")
    expect(stateFolderName(" wyoming ")).toBe("Wyoming")
    expect(stateFolderName("Delaware")).toBe("Delaware")
    expect(stateFolderName(null)).toBeNull()
  })
})

describe("backup engine", () => {
  it("builds state / company / folders, uploads every live file; a re-run makes no Drive call at all", async () => {
    const w = world(baseSnap())
    expect(await go(w)).toMatchObject({ status: "done", uploaded: 2 })
    const state = Array.from(w.items.values()).find((i) => i.name === "Wyoming")!
    expect(state.parents).toEqual(["C"])
    expect(Array.from(w.items.values()).find((i) => i.name === "ACME LLC")!.parents).toEqual([state.id])
    w.calls.length = 0
    expect(await go(w)).toMatchObject({ uploaded: 0, updated: 0, moved: 0, recreated: 0 })
    expect(w.calls).toEqual([])
    expect(w.finished.every((f) => f.outcome === "ok")).toBe(true)
  })
  it("adopts an existing state folder and the account's existing folder — never renames or moves them (#62)", async () => {
    const w = world(baseSnap({ accountFolderId: "legacy" }))
    w.add({ id: "wy", name: "Wyoming", parents: ["C"] })
    w.add({ id: "legacy", name: "ACME LLC - Mario Rossi", parents: ["wy"] })
    w.add({ id: "legacyCo", name: "1. Company", parents: ["legacy"] })
    w.add({ id: "orig", name: "Original.pdf", parents: ["legacyCo"], size: "9" })
    await go(w)
    expect(w.items.get("legacy")).toMatchObject({ name: "ACME LLC - Mario Rossi", parents: ["wy"] })
    expect(w.refs.get("root")!.drive_path.adopted).toBe(true)
    expect(w.refs.get("co")).toMatchObject({ external_id: "legacyCo" })
    expect(w.items.get(w.refs.get("f1")!.external_id)!.parents).toEqual(["legacyCo"])
    expect(w.items.get("orig")).toMatchObject({ name: "Original.pdf", parents: ["legacyCo"] })
    expect(w.calls.some((c) => c.startsWith("patch ACME") || c.startsWith("patch 1. Company"))).toBe(false)
    expect(w.calls.filter((c) => c === "mkdir Wyoming")).toHaveLength(0)
  })
  it("an account folder already used by another client is not adopted a second time", async () => {
    const w = world(baseSnap({ accountFolderId: "shared", accountFolderTakenByOther: true }))
    w.add({ id: "shared", name: "Shared", parents: ["C"] })
    await go(w)
    expect(w.refs.get("root")!.external_id).not.toBe("shared")
  })
  it("an imported original that still holds the same bytes is the copy — nothing is added or changed", async () => {
    const w = world(baseSnap())
    w.add({ id: "imp", name: "OA.pdf", parents: ["somewhere"], size: "4" })
    w.imports.set("f1", { external_id: "imp", backed_up_sha256: "a".repeat(64), drive_path: {}, status: "ok" })
    const r = await go(w)
    expect(r.uploaded).toBe(1)          // only f2
    expect(w.refs.has("f1")).toBe(false)
    expect(w.items.get("imp")).toMatchObject({ name: "OA.pdf", parents: ["somewhere"] })
  })
  it("new bytes replace the content of OUR copy; a rename or move patches it", async () => {
    const w = world(baseSnap())
    await go(w)
    const id = w.refs.get("f1")!.external_id
    w.snap.files[0] = { ...w.snap.files[0], sha256: "c".repeat(64), name: "OA signed.pdf", folder_id: "tax" }
    expect(await go(w)).toMatchObject({ updated: 1, moved: 1, uploaded: 0 })
    expect(w.refs.get("f1")!.external_id).toBe(id)
    expect(w.items.get(id)!.name).toBe("OA signed.pdf")
  })
  it("trash → protected area (in the private Drive), restore → back, purge → removed", async () => {
    const w = world(baseSnap())
    await go(w)
    const id = w.refs.get("f2")!.external_id
    w.snap.files[1] = { ...w.snap.files[1], state: "trashed" }
    await go(w)
    const prot = w.items.get(w.items.get(id)!.parents![0])!
    expect(prot.parents).toEqual(["P"])
    expect(w.items.get(id)!.trashed).toBeFalsy()
    w.snap.files[1] = { ...w.snap.files[1], state: "live" }
    expect((await go(w)).protectedMoves).toBe(1)
    w.snap.files[1] = { ...w.snap.files[1], state: "purged" }
    expect((await go(w)).removed).toBe(1)
    expect(w.refs.get("f2")!.status).toBe("purged")
  })
  it("recreates a copy deleted by hand, adopts its own copy after a crash, never runs twice at once", async () => {
    const w = world(baseSnap())
    await go(w)
    w.items.get(w.refs.get("f1")!.external_id)!.trashed = true
    expect((await go(w, { fullCheck: true })).recreated).toBe(1)
    w.snap.files.push({ id: "f3", folder_id: "co", name: "New.pdf", state: "live", sha256: "d".repeat(64), bucket: "crm-store", path: "o1/z", size: 4, mime: null })
    const realRecord = w.io.recordRef
    w.io.recordRef = async (...a) => { if (a[1] === "f3") throw new Error("crash"); return realRecord(...a) }
    const crashed = await go(w)
    expect(crashed).toMatchObject({ status: "failed" })
    expect(crashed.fileErrors).toHaveLength(1)
    w.io.recordRef = realRecord
    expect((await go(w)).uploaded).toBe(0)
    expect(Array.from(w.items.values()).filter((i) => i.appProperties?.crm_file_id === "f3")).toHaveLength(1)
    await w.io.claim("o1")
    expect((await go(w)).status).toBe("busy")
  })
  it("one failing file does not stop the others", async () => {
    const w = world(baseSnap())
    const realOpen = w.io.open
    w.io.open = async (b, p) => { if (p === "o1/x") throw new Error("object missing"); return realOpen(b, p) }
    const r = await go(w)
    expect(r.status).toBe("failed")
    expect(r.fileErrors.map((e) => e.fileId)).toEqual(["f1"])
    expect(w.refs.has("f2")).toBe(true)
  })
  it("a file moved to another client meanwhile is left to that client's run", async () => {
    const w = world(baseSnap())
    w.owners.set("f1", "o2")
    const r = await go(w)
    expect(r.skippedRehomed).toBe(1)
    expect(w.refs.has("f1")).toBe(false)
  })
  it("stops cleanly before the time limit (deferred, not a failure)", async () => {
    const w = world(baseSnap())
    const r = await go(w, { deadlineAt: Date.now() })
    expect(r.status).toBe("deferred")
    expect(w.finished.at(-1)!.outcome).toBe("deferred")
  })
  it("people and Unfiled go to the private restricted area, never the companies tree (#63)", async () => {
    for (const kind of ["person", "unfiled"] as const) {
      const w = world(baseSnap({ kind, state: null }))
      await go(w)
      const root = Array.from(w.items.values()).find((i) => i.name === "ACME LLC")!
      const place = w.items.get(root.parents![0])!
      expect(place.parents).toEqual(["R"])
      expect(Array.from(w.items.values()).some((i) => i.parents?.includes("C"))).toBe(false)
    }
  })
  it("a company with no state and no folder goes to a clearly named holding place, not a made-up state", async () => {
    const w = world(baseSnap({ state: null }))
    await go(w)
    expect(Array.from(w.items.values()).find((i) => i.name.startsWith("_Unplaced"))!.parents).toEqual(["C"])
  })
})

describe("slice-5 migration shape", () => {
  const sql = readFileSync(join(process.cwd(), "scripts/migrations/20260926-0900-crm-store-s5-backup.sql"), "utf8")
  it("revokes every new function from the web roles and never deletes store rows", () => {
    const fns = Array.from(sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)).map((m) => m[1])
    expect(fns.length).toBeGreaterThanOrEqual(10)
    for (const fn of fns) expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(`))
    expect(sql).not.toMatch(/DELETE FROM public\.(store_files|store_folders|store_file_versions|store_events|store_external_refs)/)
  })
  it("the backup writes only its own 'backup' rows — import rows are never modified", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.store_backup_record_ref"), sql.indexOf("FUNCTION public.store_backup_mark_switched"))
    expect(fn).toMatch(/'backup'/)
    expect(fn).not.toMatch(/direction = 'import'/)
  })
})
