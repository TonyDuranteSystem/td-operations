import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { unzipSync, strFromU8 } from "fflate"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock("@/lib/crm-store/writer", () => ({
  createUploadIntent: vi.fn(async (p: { fileName: string }) => ({ intentId: `i-${p.fileName}`, bucket: "crm-store-staging", stagingPath: `s/${p.fileName}`, expiresAt: "x" })),
}))

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createUploadIntent } from "@/lib/crm-store/writer"
import {
  trashFile, trashFolder, restoreBatch, trashList, removeFromView, startFolderUpload, splitUploadPath,
  purgeExpiredStore, folderZipListing, streamZip, safeZipPaths, assertZipFits, StoreZipTooLargeError, FOLDER_UPLOAD_MAX_FILES,
  ZIP_MAX_BYTES, type PurgeIO, type ZipEntry,
} from "@/lib/crm-store/folders"
import { StoreAccessDeniedError } from "@/lib/crm-store/visibility"

const admin = { id: "staff-1", app_metadata: { role: "admin" } }
const client = { id: "c-1", app_metadata: { role: "client" } }
const noRole = { id: "x", app_metadata: {} }
const rpc = () => vi.mocked(supabaseAdmin.rpc)
beforeEach(() => { rpc().mockReset(); vi.mocked(createUploadIntent).mockClear() })

function streamOf(text: string, chunks = 2): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  const size = Math.ceil(bytes.length / chunks)
  let i = 0
  return new ReadableStream({ pull(c) { if (i >= bytes.length) { c.close(); return } c.enqueue(bytes.slice(i, i + size)); i += size } })
}
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const r = s.getReader()
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value) }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

describe("staff gate", () => {
  const calls: Array<[string, (a: never) => Promise<unknown>]> = [
    ["trashFile", (a) => trashFile(a, "f")],
    ["trashFolder", (a) => trashFolder(a, "d")],
    ["restoreBatch", (a) => restoreBatch(a, "b")],
    ["trashList", (a) => trashList(a)],
    ["removeFromView", (a) => removeFromView(a, { fileId: "f", linkKind: "service_case", recordId: "r" })],
    ["startFolderUpload", (a) => startFolderUpload(a, { ownerId: "o", parentFolderId: "p", files: [{ relativePath: "a.pdf" }] })],
    ["staff zip listing", (a) => folderZipListing("d", { staff: a })],
  ]
  it.each(calls)("%s refuses clients, users with no role and no user", async (_n, call) => {
    for (const who of [client, noRole, null]) await expect(call(who as never)).rejects.toBeInstanceOf(StoreAccessDeniedError)
    expect(rpc()).not.toHaveBeenCalled()
  })
  it("passes the staff member as the actor", async () => {
    rpc().mockResolvedValueOnce({ data: "batch-1", error: null } as never)
    expect(await trashFolder(admin as never, "d", "cleanup")).toBe("batch-1")
    expect(rpc().mock.calls[0]).toEqual(["store_trash_folder", { p_folder_id: "d", p_actor: "staff-1", p_reason: "cleanup" }])
  })
})

describe("folder upload", () => {
  it("splits paths and refuses empty / dot parts", () => {
    expect(splitUploadPath("Receipts/2025/ scan 1.pdf ")).toEqual({ folders: ["Receipts", "2025"], fileName: "scan 1.pdf" })
    expect(splitUploadPath("a\\b.pdf")).toEqual({ folders: [], fileName: "a\\b.pdf" })          // a backslash is a legal name character
    expect(splitUploadPath("/top.pdf")).toEqual({ folders: [], fileName: "top.pdf" })
    expect(() => splitUploadPath("a/../b.pdf")).toThrow(/invalid path part/)
    expect(() => splitUploadPath("a/ /b.pdf")).toThrow(/empty part/)
    expect(() => splitUploadPath(" / ")).toThrow(/empty/)
    expect(() => splitUploadPath("bad\u0007name.pdf")).toThrow(/control characters/)
    expect(() => splitUploadPath(`${"x".repeat(256)}`)).toThrow(/255/)
  })
  it("one bad file never stops the others; each distinct folder is created once", async () => {
    rpc().mockImplementation((async (fn: string, args: { p_path: string[] }) =>
      ({ data: fn === "store_ensure_folder_path" ? `folder:${args.p_path.join("/")}` : null, error: null })) as never)
    const report = await startFolderUpload(admin as never, { ownerId: "o", parentFolderId: "root", files: [
      { relativePath: "2025/Bank/a.pdf" }, { relativePath: "2025/bank/b.pdf" }, { relativePath: "../evil.pdf" }, { relativePath: "top.pdf" },
    ] })
    expect(report.map((r) => r.status)).toEqual(["ready", "ready", "refused", "ready"])
    expect(report[2]).toMatchObject({ status: "refused", reason: expect.stringMatching(/invalid path part/) })
    const ensure = rpc().mock.calls.filter((c) => (c[0] as string) === "store_ensure_folder_path")
    expect(ensure).toHaveLength(2)                                     // "2025/Bank" = "2025/bank", plus the top level
    for (const c of ensure) expect(c[1]).toMatchObject({ p_owner: "o", p_parent: "root" })   // owner checked by the database
    expect(report[3]).toMatchObject({ status: "ready", folderId: "folder:" })
    expect(vi.mocked(createUploadIntent)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createUploadIntent).mock.calls[0][0]).toMatchObject({ ownerId: "o", actor: "staff-1", actorRole: "admin" })
  })
  it("refuses an oversized folder upload up front", async () => {
    const files = Array.from({ length: FOLDER_UPLOAD_MAX_FILES + 1 }, (_, i) => ({ relativePath: `f${i}.pdf` }))
    await expect(startFolderUpload(admin as never, { ownerId: "o", parentFolderId: "p", files })).rejects.toThrow(/at most/)
    expect(rpc()).not.toHaveBeenCalled()
  })
})

describe("purge", () => {
  function io(over: Partial<PurgeIO> = {}): PurgeIO & { removed: string[] } {
    const removed: string[] = []
    return {
      removed,
      listDue: async () => ["f1", "f2", "f3"],
      purgeFile: async (id) => id === "f2" ? { status: "already_purged" } : { status: "purged", objects: [{ bucket: "crm-store", path: `${id}/v1` }, { bucket: "crm-store", path: `${id}/v2` }] },
      removeObjects: async (_b, paths) => { removed.push(...paths) },
      pendingObjects: async () => [],
      ...over,
    }
  }
  it("tombstones first, then removes every version's bytes; skips what is no longer due", async () => {
    const x = io()
    const t = await purgeExpiredStore(new Date("2027-01-01"), x)
    expect(t).toEqual({ examined: 3, purged: 2, skipped: 1, objectsRemoved: 4, retried: 0, errors: 0, failures: [] })
    expect(x.removed).toEqual(["f1/v1", "f1/v2", "f3/v1", "f3/v2"])
  })
  it("a failed removal is counted and retried from the pending list on the next run", async () => {
    const x = io({ removeObjects: async () => { throw new Error("boom") } })
    const t = await purgeExpiredStore(new Date(), x)
    expect(t.errors).toBe(2)
    expect(t.failures[0]).toMatchObject({ fileId: "f1", bucket: "crm-store", message: "boom" })
    const y = io({ listDue: async () => [], pendingObjects: async () => [{ bucket: "crm-store", path: "f1/v1" }] })
    expect(await purgeExpiredStore(new Date(), y)).toMatchObject({ retried: 1, errors: 0 })
    expect(y.removed).toEqual(["f1/v1"])
  })
})

describe("zip", () => {
  const entries: ZipEntry[] = [
    { file_id: "1", zip_path: "2025/a.txt", bucket: "b", object_path: "p1", size_bytes: 11 },
    { file_id: "2", zip_path: "b.txt", bucket: "b", object_path: "p2", size_bytes: 6 },
    { file_id: "3", zip_path: "gone.pdf", bucket: "b", object_path: "p3", size_bytes: 3 },
  ]
  it("streams every entry in order and notes a file it could not read instead of failing", async () => {
    const open = async (_b: string, path: string) => {
      if (path === "p3") throw new Error("missing")
      return streamOf(path === "p1" ? "hello world" : "second")
    }
    const files = unzipSync(await collect(streamZip(entries, open)))
    expect(Object.keys(files).sort()).toEqual(["2025/a.txt", "b.txt", "gone.pdf - could not be included.txt"])
    expect(strFromU8(files["2025/a.txt"])).toBe("hello world")
    expect(strFromU8(files["b.txt"])).toBe("second")
  })
  it("fails loudly when a stored file comes back with a different size", async () => {
    const bad = [{ ...entries[0], size_bytes: 99 }]
    await expect(collect(streamZip(bad, async () => streamOf("hello world")))).rejects.toThrow(/came back 11 bytes, saved 99/)
  })
  it("reads the next piece only when the downloader asks (no read-ahead)", async () => {
    let reads = 0
    const open = async () => new ReadableStream<Uint8Array>({ pull(c) { reads++; if (reads > 50) { c.close(); return } c.enqueue(new Uint8Array(1)) } })
    const s = streamZip([{ ...entries[1], size_bytes: 50 }], open)
    const r = s.getReader()
    await r.read()
    await new Promise((res) => setTimeout(res, 20))
    expect(reads).toBeLessThan(10)
    await r.cancel()
  })
  it("opens the next few files AHEAD (at most 8 at once) but keeps them in order, and an unreadable one still becomes a note", async () => {
    const many: ZipEntry[] = Array.from({ length: 30 }, (_, i) => ({ file_id: String(i), zip_path: `f${String(i).padStart(2, "0")}.txt`, bucket: "b", object_path: `p${i}`, size_bytes: String(i).length }))
    let inFlight = 0, maxInFlight = 0
    const open = async (_b: string, path: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5 + (Number(path.slice(1)) * 7) % 11)) // uneven: later files can finish first
      inFlight--
      if (path === "p13") throw new Error("missing")
      return streamOf(path.slice(1), 1)
    }
    const files = unzipSync(await collect(streamZip(many, open)))
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(8)
    expect(Object.keys(files)).toContain("f13.txt - could not be included.txt")
    for (let i = 0; i < 30; i++) if (i !== 13) expect(strFromU8(files[`f${String(i).padStart(2, "0")}.txt`])).toBe(String(i))
    // order inside the zip = the listing order
    const order = Object.keys(files).filter((k) => !k.includes("could not"))
    expect(order).toEqual([...order].sort())
  })
  it("a download that stops lets go of the files opened ahead", async () => {
    const cancelled: string[] = []
    const open = async (_b: string, path: string) => new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(1)) },
      cancel() { cancelled.push(path) },
    })
    const s = streamZip(Array.from({ length: 5 }, (_, i) => ({ ...entries[1], file_id: String(i), zip_path: `x${i}.bin`, object_path: `q${i}`, size_bytes: 1000 })), open)
    const r = s.getReader()
    await r.read()
    await r.cancel()
    await new Promise((res) => setTimeout(res, 10))
    expect(cancelled.length).toBeGreaterThanOrEqual(4) // the one being read + the ones opened ahead
  })
  it("refuses a zip that is too big to finish, before streaming anything", () => {
    expect(() => assertZipFits([{ ...entries[0], size_bytes: ZIP_MAX_BYTES + 1 }])).toThrow(StoreZipTooLargeError)
    expect(() => streamZip([{ ...entries[0], size_bytes: ZIP_MAX_BYTES + 1 }])).toThrow(/too large/)
  })
  it("makes paths safe on every OS and unique (file vs folder, case, Windows characters)", () => {
    const out = safeZipPaths([
      { ...entries[0], zip_path: "Tax" }, { ...entries[0], zip_path: "Tax/x.pdf" },
      { ...entries[0], zip_path: "a:b?.pdf" }, { ...entries[0], zip_path: "A:B?.PDF" }, { ...entries[0], zip_path: "../..hidden." },
    ]).map((e) => e.zip_path)
    expect(out).toEqual(["Tax (2)", "Tax/x.pdf", "a_b_.pdf", "A_B_ (2).PDF", "_/..hidden"])
  })
  it("portal zips go through the per-file privacy listing; ambiguous viewers are refused", async () => {
    rpc().mockResolvedValueOnce({ data: [], error: null } as never)
    await folderZipListing("d", { viewer: { contactId: "c1" } })
    expect(rpc().mock.calls[0]).toEqual(["store_folder_zip_listing", { p_folder_id: "d", p_contact_id: "c1", p_teammate_id: null, p_staff: false }])
    await expect(folderZipListing("d", { viewer: { contactId: "c", teammateId: "t" } as never })).rejects.toThrow(/exactly one/)
  })
})

describe("slice-4 migration shape", () => {
  const sql = readFileSync(join(process.cwd(), "scripts/migrations/20260925-2000-crm-store-s4-trash.sql"), "utf8")
  it("revokes every new function from the web roles", () => {
    const fns = Array.from(sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)).map((m) => m[1])
    expect(fns.length).toBeGreaterThanOrEqual(12)
    for (const fn of fns) expect(sql, `${fn} must be revoked`).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(`))
  })
  it("never deletes a file, folder or version row (purge keeps the tombstone)", () => {
    expect(sql).not.toMatch(/DELETE FROM public\.(store_files|store_folders|store_file_versions|store_events)/)
  })
  it("does not touch Google Drive or its references (slice 5)", () => {
    expect(sql).not.toMatch(/store_external_refs|googleapis/i)
  })
})
