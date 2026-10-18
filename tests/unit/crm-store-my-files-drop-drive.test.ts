import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { generateKeyPairSync, createHash } from "crypto"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import {
  DROP_DRIVE_MAX_BYTES, DROP_MAX_BYTES, driveCallerKey, driveCopyName, driveFileRefusal, dropDrivePullRefusal, md5Of, type DriveFileFacts,
} from "@/lib/crm-store/my-files-drop-rules"
import {
  DRIVE_WALK_MAX_LOOKUPS, fetchDriveBytes, inspectDriveFile, walkToRoot, type DriveMetaLike, type DriveReader,
} from "@/lib/crm-store/my-files-drop-drive"
import { saveToMyFilesDrop } from "@/lib/crm-store/my-files-drop"

const ROOT = "ROOTFOLDERID0000001"
const FOLDER = "application/vnd.google-apps.folder"
const caller = { method: "static", email: "antonio.durante@tonydurante.us" }

function meta(over: Partial<DriveMetaLike> & { id: string }): DriveMetaLike {
  return { name: "plan.md", mimeType: "text/markdown", size: 5, md5: md5Of(Buffer.from("hello")), ownedByMe: true, trashed: false, parents: [ROOT], driveId: null, version: "1", modifiedTime: "2026-10-17T00:00:00Z", ...over }
}
function reader(files: DriveMetaLike[], bytes: Record<string, Buffer | Error> = {}): DriveReader & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async meta(id) { calls.push(`meta:${id}`); const f = files.find((x) => x.id === id); if (!f) throw Object.assign(new Error("404"), { code: "unavailable" }); return { ...f } },
    async bytes(id) { calls.push(`bytes:${id}`); const b = bytes[id]; if (!b) throw Object.assign(new Error("x"), { code: "failed" }); if (b instanceof Error) throw b; return b },
  }
}
const folder = (id: string, parent: string | null, over: Partial<DriveMetaLike> = {}) => meta({ id, name: id, mimeType: FOLDER, size: null, md5: null, parents: parent ? [parent] : [], ...over })

describe("walkToRoot — the folder boundary", () => {
  it("is in when the file is directly under the root or several folders down", async () => {
    expect(await walkToRoot(reader([]), meta({ id: "FILEAAAAAAAA1" }), ROOT)).toBe("in")
    const r = reader([folder("FOLDERAAAAAAA1", "FOLDERBBBBBBB1"), folder("FOLDERBBBBBBB1", ROOT)])
    expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", parents: ["FOLDERAAAAAAA1"] }), ROOT)).toBe("in")
  })
  it("is out for a file elsewhere, with no parent, with two parents, in a shared drive, or the root itself", async () => {
    const r = reader([folder("OTHERFOLDER0001", "TOPOFDRIVE00001"), folder("TOPOFDRIVE00001", null)])
    expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", parents: ["OTHERFOLDER0001"] }), ROOT)).toBe("out")
    expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", parents: [] }), ROOT)).toBe("out")
    expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", parents: [ROOT, "OTHERFOLDER0001"] }), ROOT)).toBe("out")
    expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", driveId: "SHARED1" }), ROOT)).toBe("out")
    expect(await walkToRoot(r, meta({ id: ROOT, mimeType: FOLDER }), ROOT)).toBe("out")
  })
  it("is out when an ancestor is trashed, is not a folder, sits in a shared drive, or has two parents", async () => {
    for (const bad of [{ trashed: true }, { mimeType: "text/plain" }, { driveId: "S" }, { parents: [ROOT, "X"] }]) {
      const r = reader([folder("FOLDERAAAAAAA1", "FOLDERBBBBBBB1", bad), folder("FOLDERBBBBBBB1", ROOT)])
      expect(await walkToRoot(r, meta({ id: "FILEAAAAAAAA1", parents: ["FOLDERAAAAAAA1"] }), ROOT), JSON.stringify(bad)).toBe("out")
    }
  })
  it("an ancestor he cannot see counts as outside (same as not found), while a Drive failure is an error", async () => {
    expect(await walkToRoot(reader([]), meta({ id: "FILEAAAAAAAA1", parents: ["HIDDENFOLDER0001"] }), ROOT)).toBe("out")
    const flaky: DriveReader = { meta: async () => { throw Object.assign(new Error("x"), { code: "failed" }) }, bytes: async () => Buffer.alloc(0) }
    expect(await walkToRoot(flaky, meta({ id: "FILEAAAAAAAA1", parents: ["HIDDENFOLDER0001"] }), ROOT)).toBe("error")
  })
  it("stops on a loop and on too deep a chain, and reports an error as error", async () => {
    const loop = reader([folder("LOOPAAAAAAAAA1", "LOOPBBBBBBBBB1"), folder("LOOPBBBBBBBBB1", "LOOPAAAAAAAAA1")])
    expect(await walkToRoot(loop, meta({ id: "FILEAAAAAAAA1", parents: ["LOOPAAAAAAAAA1"] }), ROOT)).toBe("out")
    const deep: DriveMetaLike[] = []
    for (let i = 0; i < 40; i++) deep.push(folder(`DEEPFOLDER${String(i).padStart(5, "0")}`, i === 39 ? ROOT : `DEEPFOLDER${String(i + 1).padStart(5, "0")}`))
    expect(await walkToRoot(reader(deep), meta({ id: "FILEAAAAAAAA1", parents: ["DEEPFOLDER00000"] }), ROOT)).toBe("out")
    expect(DRIVE_WALK_MAX_LOOKUPS).toBeGreaterThanOrEqual(25)
    const boom: DriveReader = { meta: async () => { throw new Error("net") }, bytes: async () => Buffer.alloc(0) }
    expect(await walkToRoot(boom, meta({ id: "FILEAAAAAAAA1", parents: ["SOMEFOLDER00001"] }), ROOT)).toBe("error")
  })
})

describe("inspectDriveFile — order of checks and what is said", () => {
  it("says the SAME thing for a missing file and for a file outside the tree (nothing about an outside file leaks)", async () => {
    const r = reader([meta({ id: "OUTSIDEFILE0001", parents: ["ELSEWHERE000001"], mimeType: FOLDER }), folder("ELSEWHERE000001", null)])
    const a = await inspectDriveFile(r, "OUTSIDEFILE0001", ROOT)
    const b = await inspectDriveFile(r, "MISSINGFILE0001", ROOT)
    expect(a.ok).toBe(false); expect(b.ok).toBe(false)
    expect((a as { error: string }).error).toBe((b as { error: string }).error)
  })
  it("inside the tree: folder, shortcut, Google-native, trashed, not owned, no checksum, empty, too big are each refused in words", async () => {
    const cases: Array<[Partial<DriveMetaLike>, RegExp]> = [
      [{ mimeType: FOLDER }, /folder/], [{ mimeType: "application/vnd.google-apps.shortcut" }, /shortcut/],
      [{ mimeType: "application/vnd.google-apps.document" }, /Google Doc/], [{ trashed: true }, /trash/], [{ ownedByMe: false }, /not owned/],
      [{ md5: null }, /checksum/], [{ size: 0 }, /empty/], [{ size: DROP_DRIVE_MAX_BYTES + 1 }, /limit for a copy from Drive/],
    ]
    for (const [over, re] of cases) {
      const r = await inspectDriveFile(reader([meta({ id: "FILEAAAAAAAA1", ...over })]), "FILEAAAAAAAA1", ROOT)
      expect(r.ok, JSON.stringify(over)).toBe(false)
      expect((r as { error: string }).error).toMatch(re)
    }
  })
  it("accepts a normal owned file inside the tree", async () => {
    expect((await inspectDriveFile(reader([meta({ id: "FILEAAAAAAAA1" })]), "FILEAAAAAAAA1", ROOT)).ok).toBe(true)
  })
  it("a Drive error is a fixed sentence — Google's own text is never passed on", async () => {
    const boom: DriveReader = { meta: async () => { throw Object.assign(new Error("secret internal detail"), { code: "failed" }) }, bytes: async () => Buffer.alloc(0) }
    const r = await inspectDriveFile(boom, "FILEAAAAAAAA1", ROOT)
    expect((r as { error: string }).error).not.toMatch(/secret/)
  })
})

describe("fetchDriveBytes — the bytes must be the file that was inspected", () => {
  const good = Buffer.from("hello")
  const base = () => meta({ id: "FILEAAAAAAAA1" })
  it("returns the bytes when size, checksum, parents and version are unchanged", async () => {
    const m = base()
    const r = await fetchDriveBytes(reader([m], { FILEAAAAAAAA1: good }), m, ROOT)
    expect(r.ok).toBe(true)
  })
  it("refuses a checksum mismatch (edited or damaged during the download)", async () => {
    const m = base()
    const r = await fetchDriveBytes(reader([m], { FILEAAAAAAAA1: Buffer.from("HELLO") }), m, ROOT)
    expect((r as { error: string }).error).toMatch(/changed/)
  })
  it("refuses a length mismatch", async () => {
    const m = base()
    expect((await fetchDriveBytes(reader([m], { FILEAAAAAAAA1: Buffer.from("hello!") }), m, ROOT)).ok).toBe(false)
  })
  it("refuses when the file was edited, trashed or MOVED OUT of the tree after the first look", async () => {
    const m = base()
    for (const after of [{ md5: "0".repeat(32) }, { trashed: true }, { parents: ["ELSEWHERE000001"] }, { name: "other.md" }]) {
      const r = reader([{ ...m, ...after }, folder("ELSEWHERE000001", null)], { FILEAAAAAAAA1: good })
      expect((await fetchDriveBytes(r, m, ROOT)).ok, JSON.stringify(after)).toBe(false)
    }
  })
  it("too_big from the reader gives the size sentence; other failures a fixed sentence", async () => {
    const m = base()
    const big = await fetchDriveBytes(reader([m], { FILEAAAAAAAA1: Object.assign(new Error("x"), { code: "too_big" }) }), m, ROOT)
    expect((big as { error: string }).error).toMatch(/larger than/)
    const bad = await fetchDriveBytes(reader([m], { FILEAAAAAAAA1: Object.assign(new Error("secret"), { code: "failed" }) }), m, ROOT)
    expect((bad as { error: string }).error).not.toMatch(/secret/)
  })
})

describe("rules for a Drive copy", () => {
  it("the Drive cap is its own, and the inline cap did not move", () => {
    expect(DROP_MAX_BYTES).toBe(3 * 1024 * 1024)
    expect(DROP_DRIVE_MAX_BYTES).toBeGreaterThan(DROP_MAX_BYTES)
  })
  it("driveCopyName keeps the Drive name by default and the same ending when a name is given", () => {
    expect(driveCopyName(undefined, "a.docx")).toEqual({ ok: true, name: "a.docx" })
    expect(driveCopyName("New.docx", "a.docx")).toEqual({ ok: true, name: "New.docx" })
    expect(driveCopyName("New.pdf", "a.docx").ok).toBe(false)
    expect(driveCopyName(5, "a.docx").ok).toBe(false)
  })
  it("the default key is known before the download, depends on the Drive id and checksum, and a user key cannot use the internal prefix", () => {
    const a = driveCallerKey(undefined, [], "a.md", "IDAAAAAAAAAA1", "md5a")
    const b = driveCallerKey(undefined, [], "a.md", "IDAAAAAAAAAA1", "md5b")
    const c = driveCallerKey(undefined, [], "a.md", "IDAAAAAAAAAA1", "md5a")
    expect(a).toEqual(c)
    expect((a as { key: string }).key).not.toBe((b as { key: string }).key)
    expect(driveCallerKey("auto:x", [], "a.md", "IDAAAAAAAAAA1", "md5a").ok).toBe(false)
    expect(driveCallerKey("mine-1", [], "a.md", "IDAAAAAAAAAA1", "md5a").ok).toBe(true)
  })
  it("pull attempts are limited per hour", () => {
    expect(dropDrivePullRefusal(0)).toBeNull()
    expect(dropDrivePullRefusal(40)).toMatch(/Too many/)
  })
  it("driveFileRefusal accepts a plain owned file", () => {
    const f: DriveFileFacts = { name: "a.md", mimeType: "text/markdown", size: 10, md5: "x", ownedByMe: true, trashed: false, driveId: null }
    expect(driveFileRefusal(f)).toBeNull()
  })
})

describe("saveToMyFilesDrop — Drive input is refused early, before any database or Drive call", () => {
  beforeEach(() => { process.env.MY_FILES_DROP_ENABLED = "1" })
  afterEach(() => { delete process.env.MY_FILES_DROP_ENABLED; delete process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID })
  it("is off while no Drive folder is set", async () => {
    const r = await saveToMyFilesDrop({ drive_file_id: "FILEAAAAAAAA1" }, caller, reader([]))
    expect(r.ok).toBe(false); expect((r as { error: string }).error).toMatch(/not switched on/)
  })
  it("refuses links, paths and odd ids, and a mix of sources — and never calls Drive for them", async () => {
    process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID = ROOT
    const rd = reader([])
    for (const id of ["https://drive.google.com/file/d/ABCDEFGHIJKL/view", "../../etc/passwd1", "ABC", "a b c d e f g h i j k", "FILE.ID.WITH.DOTS", 12345]) {
      const r = await saveToMyFilesDrop({ drive_file_id: id }, caller, rd)
      expect(r.ok, String(id)).toBe(false)
    }
    expect((await saveToMyFilesDrop({ drive_file_id: "FILEAAAAAAAA1", text: "x", name: "a.md" }, caller, rd)).ok).toBe(false)
    expect((await saveToMyFilesDrop({ drive_file_id: "FILEAAAAAAAA1", content_base64: "eA==" }, caller, rd)).ok).toBe(false)
    expect(rd.calls).toEqual([])
  })
  it("a file outside the folder is refused before anything is downloaded", async () => {
    process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID = ROOT
    const rd = reader([meta({ id: "FILEAAAAAAAA1", parents: ["ELSEWHERE000001"] }), folder("ELSEWHERE000001", null)], { FILEAAAAAAAA1: Buffer.from("hello") })
    const r = await saveToMyFilesDrop({ drive_file_id: "FILEAAAAAAAA1" }, caller, rd)
    expect(r.ok).toBe(false)
    expect(rd.calls.some((c) => c.startsWith("bytes:"))).toBe(false)
  })
  it("text input with no name is still refused", async () => {
    expect((await saveToMyFilesDrop({ text: "hi" }, caller)).ok).toBe(false)
  })
})

describe("the read-only token — its own scope, its own cache slot", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.GOOGLE_SA_KEY; vi.resetModules() })
  it("mints a drive.readonly token for the Drive reads and never hands it to a full-scope caller (or the reverse)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    process.env.GOOGLE_SA_KEY = Buffer.from(JSON.stringify({ client_email: "sa@x.iam", private_key: privateKey, token_uri: "https://oauth.test/token" })).toString("base64")
    const scopes: string[] = []
    const bearers: string[] = []
    let n = 0
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u === "https://oauth.test/token") {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion") as string
        const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString())
        scopes.push(payload.scope)
        return new Response(JSON.stringify({ access_token: `tok${++n}`, expires_in: 3600 }), { status: 200 })
      }
      bearers.push(String((init?.headers as Record<string, string>)?.Authorization))
      return new Response(JSON.stringify({ id: "FILEAAAAAAAA1", name: "n", mimeType: "text/plain", size: "1", md5Checksum: "m", ownedByMe: true, parents: ["P"] }), { status: 200 })
    }) as typeof fetch
    vi.resetModules()
    const g = await import("@/lib/google-drive")
    await g.readOwnerDropMeta("FILEAAAAAAAA1")
    await g.getOwnerDriveFile("FILEAAAAAAAA1", "me") // full-scope owner read, same subject
    await g.readOwnerDropMeta("FILEAAAAAAAA1") // must reuse the read-only token, not mint again or take the full one
    expect(scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive"])
    expect(bearers).toEqual(["Bearer tok1", "Bearer tok2", "Bearer tok1"])
  })
  it("the stream cap counts decoded bytes and cancels at once", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    process.env.GOOGLE_SA_KEY = Buffer.from(JSON.stringify({ client_email: "sa@x.iam", private_key: privateKey, token_uri: "https://oauth.test/token" })).toString("base64")
    let cancelled = false
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url) === "https://oauth.test/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
      sentHeaders = init?.headers as Record<string, string>
      const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(400)) }, cancel() { cancelled = true } })
      return new Response(body, { status: 200 })
    }) as typeof fetch
    vi.resetModules()
    const g = await import("@/lib/google-drive")
    await expect(g.downloadOwnerDropBytes("FILEAAAAAAAA1", 1000)).rejects.toMatchObject({ code: "too_big" })
    expect(cancelled).toBe(true)
    expect(sentHeaders["Accept-Encoding"]).toBe("identity")
    const ok = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); c.close() } })
    globalThis.fetch = (async (url: string) => String(url) === "https://oauth.test/token" ? new Response(JSON.stringify({ access_token: "t2", expires_in: 3600 }), { status: 200 }) : new Response(ok, { status: 200 })) as typeof fetch
    expect((await g.downloadOwnerDropBytes("FILEAAAAAAAA1", 1000)).length).toBe(10)
  })
  it("a rate-limit answer from Drive is a failure, not 'not found'", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    process.env.GOOGLE_SA_KEY = Buffer.from(JSON.stringify({ client_email: "sa@x.iam", private_key: privateKey, token_uri: "https://oauth.test/token" })).toString("base64")
    globalThis.fetch = (async (url: string) => String(url) === "https://oauth.test/token"
      ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), { status: 403 })) as typeof fetch
    vi.resetModules()
    const g = await import("@/lib/google-drive")
    await expect(g.readOwnerDropMeta("FILEAAAAAAAA1")).rejects.toMatchObject({ code: "failed" })
  })
  it("refuses ids that are not plain ids, with no network call", async () => {
    const g = await import("@/lib/google-drive")
    globalThis.fetch = (async () => { throw new Error("no network expected") }) as typeof fetch
    for (const id of ["a/b", "https://x", "short", "has.dot.in.it.here"]) await expect(g.readOwnerDropMeta(id)).rejects.toMatchObject({ code: "unavailable" })
    await expect(g.downloadOwnerDropBytes("../x", 10)).rejects.toMatchObject({ code: "unavailable" })
  })
})

describe("sanity", () => { it("md5Of matches node's md5", () => { expect(md5Of(Buffer.from("a"))).toBe(createHash("md5").update("a").digest("hex")) }) })
