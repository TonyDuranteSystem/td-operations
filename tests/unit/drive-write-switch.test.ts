/**
 * Stop Drive S2 (dev job 264bb882): THE Drive write switch.
 *
 * Nothing but the one-way storage backup may write to Google Drive. Every write verb of the Drive client refuses unless the call runs
 * inside `runAsStoreBackup` (an explicit, scoped context — not a global flag); reads are never affected. These tests run the REAL Drive
 * client against a fake network (`fetch`) and prove, per verb: refused outside the backup (and not one request leaves the process),
 * allowed inside it (the write really goes out).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest"

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue("fake-key"),
  SignJWT: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.setProtectedHeader = vi.fn().mockReturnThis()
    this.setIssuer = vi.fn().mockReturnThis()
    this.setAudience = vi.fn().mockReturnThis()
    this.setIssuedAt = vi.fn().mockReturnThis()
    this.setExpirationTime = vi.fn().mockReturnThis()
    this.sign = vi.fn().mockResolvedValue("fake-jwt")
  }),
}))
// the cutover guard reads the database; it is not what is tested here (inside the backup it returns before any lookup)
vi.mock("@/lib/crm-store/switched-drive-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm-store/switched-drive-guard")>()),
  lockedFolderIdsCached: vi.fn().mockResolvedValue(new Set<string>()),
}))

import * as drive from "@/lib/google-drive"
import {
  runAsStoreBackup, inStoreBackupScope, assertDriveWriteScope, driveWriteFetch, isWriteMethod, DriveWritesStoppedError,
  DRIVE_WRITES_STOPPED_SENTENCE, setDriveRefusalReporter, forgetReportedRefusals,
} from "@/lib/google-drive-write-scope"

const ENV_KEYS = ["SANDBOX_MODE", "GOOGLE_DRIVE_LIVE", "NEXT_PUBLIC_SUPABASE_URL", "GOOGLE_SA_KEY"] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
})
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})

type Call = { url: string; method: string }
let calls: Call[]
let reported: string[]

function installFakeNetwork() {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ url: u, method })
    if (u.includes("oauth2")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 })
    const body = { id: "x1", name: "n", parents: ["p1"], mimeType: "application/pdf", files: [{ id: "y1", name: "other", mimeType: "application/vnd.google-apps.folder" }] }
    // resumable sessions: the init call answers with a session URL, the PUT with the finished file
    return new Response(JSON.stringify(body), { status: 200, headers: { location: "https://upload.example/session", "content-type": "application/json" } })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const driveCalls = () => calls.filter((c) => !c.url.includes("oauth2"))
const writeCalls = () => driveCalls().filter((c) => isWriteMethod(c.method))

beforeEach(() => {
  calls = []
  reported = []
  // a PRODUCTION-shaped environment with live Drive: the strictest path (no test-drive guard, no sandbox mock)
  delete process.env.SANDBOX_MODE
  delete process.env.GOOGLE_DRIVE_LIVE
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ydzipybqeebtpcvsbtvs.supabase.co"
  process.env.GOOGLE_SA_KEY = Buffer.from(JSON.stringify({ client_email: "t@t.iam.gserviceaccount.com", private_key: "fake", token_uri: "https://oauth2.googleapis.com/token" })).toString("base64")
  forgetReportedRefusals()
  setDriveRefusalReporter((verb) => { reported.push(verb) })
  installFakeNetwork()
})
afterEach(() => {
  setDriveRefusalReporter(null)
  vi.unstubAllGlobals()
})

const bytes = (n: number) => Buffer.alloc(n, 1)
const oneChunkStream = (n: number) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(n).fill(1)); c.close() } })

// every Drive write verb the client exports, each with a call that would really write
const VERBS: Array<[string, () => Promise<unknown>]> = [
  ["uploadFile", () => drive.uploadFile("parent", "n.txt", "x")],
  ["updateFileContent", () => drive.updateFileContent("file", "x")],
  ["renameFile", () => drive.renameFile("file", "new name")],
  ["createFolder", () => drive.createFolder("parent", "folder")],
  ["moveFile", () => drive.moveFile("file", "new-parent")],
  ["createFolderMyDrive", () => drive.createFolderMyDrive("parent", "folder")],
  ["uploadFileMyDrive", () => drive.uploadFileMyDrive("parent", "n.txt", "x")],
  ["ensureDrivePath", () => drive.ensureDrivePath("root", ["a", "b"])],
  ["uploadBinaryToDrive (small file, multipart)", () => drive.uploadBinaryToDrive("a.pdf", bytes(100), "application/pdf", "parent")],
  ["uploadBinaryToDrive (large file, resumable)", () => drive.uploadBinaryToDrive("big.png", bytes(6 * 1024 * 1024), "image/png", "parent")],
  ["updateBinaryFile", () => drive.updateBinaryFile("file", bytes(100), "application/pdf")],
  ["uploadBinaryToDriveUpsert", () => drive.uploadBinaryToDriveUpsert("a.pdf", bytes(100), "application/pdf", "parent", new Map())],
  ["trashFile", () => drive.trashFile("file")],
  ["findOrCreateYearFolder", () => drive.findOrCreateYearFolder("tax-folder", 2025)],
  ["createTaggedFolder", () => drive.createTaggedFolder("parent", "folder", { k: "v" })],
  ["patchTaggedItem", () => drive.patchTaggedItem("file", { name: "renamed", appProperties: { k: "v" } })],
  ["uploadStreamToDrive (create)", () => drive.uploadStreamToDrive({ mode: "create", parentId: "parent", name: "s.bin", mimeType: "application/octet-stream", size: 5, stream: oneChunkStream(5), appProperties: { k: "v" } })],
  ["uploadStreamToDrive (update)", () => drive.uploadStreamToDrive({ mode: "update", fileId: "file", name: "s.bin", mimeType: "application/octet-stream", size: 5, stream: oneChunkStream(5), appProperties: { k: "v" } })],
]

describe("every Drive write verb is REFUSED outside the backup", () => {
  it.each(VERBS)("%s", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(DriveWritesStoppedError)
    // not one request left the process — not even the sign-in
    expect(calls).toEqual([])
  })

  it("the refusal carries the plain sentence (no file names, no codes) and the verb is told to the alarm path exactly once per cause", async () => {
    await expect(drive.createFolder("p", "a")).rejects.toThrow(DRIVE_WRITES_STOPPED_SENTENCE)
    await expect(drive.createFolder("p", "b")).rejects.toBeInstanceOf(DriveWritesStoppedError)
    await expect(drive.createFolder("p", "c")).rejects.toBeInstanceOf(DriveWritesStoppedError)
    expect(reported).toEqual(["createFolder"]) // throttled: ONE alarm per cause, not one per attempt
    await expect(drive.trashFile("f")).rejects.toBeInstanceOf(DriveWritesStoppedError)
    expect(reported).toEqual(["createFolder", "trashFile"]) // a different cause alarms again
  })

  it("the sentence is plain: no technical words, no mention of a Drive folder id", () => {
    expect(DRIVE_WRITES_STOPPED_SENTENCE).toMatch(/^[A-Z].*\.$/)
    expect(DRIVE_WRITES_STOPPED_SENTENCE).not.toMatch(/folder id|api|http|fetch|\.ts/i)
  })

  it("the refusal also holds in the SANDBOX (mocked Drive): a sandbox test sees exactly what production does", async () => {
    process.env.SANDBOX_MODE = "1"
    delete process.env.GOOGLE_DRIVE_LIVE
    expect(drive.driveIsMocked()).toBe(true)
    for (const [, run] of VERBS) await expect(run()).rejects.toBeInstanceOf(DriveWritesStoppedError)
    expect(calls).toEqual([])
  })
})

describe("every Drive write verb is ALLOWED inside the backup scope", () => {
  it.each(VERBS)("%s", async (_name, run) => {
    await expect(runAsStoreBackup(run)).resolves.toBeDefined()
    expect(writeCalls().length).toBeGreaterThan(0)
    expect(reported).toEqual([]) // an allowed write raises no alarm
  })

  it("in the sandbox (mocked Drive) the backup scope still works — the mock answers, no write is made", async () => {
    process.env.SANDBOX_MODE = "1"
    delete process.env.GOOGLE_DRIVE_LIVE
    for (const [, run] of VERBS) await expect(runAsStoreBackup(run)).resolves.toBeDefined()
    expect(writeCalls()).toEqual([]) // (a verb may still READ to decide what to do; nothing is written)
  })
})

describe("the scope is an explicit context, not a global flag", () => {
  it("is on only inside runAsStoreBackup and off again after it, even if the work throws", async () => {
    expect(inStoreBackupScope()).toBe(false)
    await runAsStoreBackup(async () => { expect(inStoreBackupScope()).toBe(true) })
    expect(inStoreBackupScope()).toBe(false)
    await expect(runAsStoreBackup(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(inStoreBackupScope()).toBe(false)
  })

  it("one request being the backup never opens the door for another request running at the same time", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const backup = runAsStoreBackup(async () => { await gate; return drive.createFolder("parent", "from-backup") })
    // while the backup is paused mid-flight, an unrelated call (a staff click) is still refused
    await expect(drive.createFolder("parent", "from-a-staff-click")).rejects.toBeInstanceOf(DriveWritesStoppedError)
    release()
    await expect(backup).resolves.toBeDefined()
    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0].method).toBe("POST")
  })

  it("the scope follows the backup's own async work (awaits, timers, parallel branches)", async () => {
    await runAsStoreBackup(async () => {
      await Promise.all([drive.createFolder("p", "a"), new Promise<void>((r) => setTimeout(r, 5)).then(() => drive.createFolder("p", "b"))])
    })
    expect(writeCalls()).toHaveLength(2)
  })

  it("assertDriveWriteScope throws a DriveWritesStoppedError that names the verb", () => {
    try { assertDriveWriteScope("trashFile"); throw new Error("did not throw") } catch (e) {
      expect(e).toBeInstanceOf(DriveWritesStoppedError)
      expect((e as DriveWritesStoppedError).verb).toBe("trashFile")
    }
  })
})

describe("the raw network door is a second line of defence", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE", "post"])("a %s request is refused outside the backup and never sent", async (method) => {
    const sender = vi.fn(async () => new Response("{}"))
    await expect(driveWriteFetch("https://www.googleapis.com/drive/v3/files/x", { method }, sender as unknown as typeof fetch)).rejects.toBeInstanceOf(DriveWritesStoppedError)
    expect(sender).not.toHaveBeenCalled()
  })

  it.each([undefined, "GET", "HEAD"])("a read (%s) is never affected", async (method) => {
    const sender = vi.fn(async () => new Response("{}"))
    await driveWriteFetch("https://www.googleapis.com/drive/v3/files/x", method ? { method } : undefined, sender as unknown as typeof fetch)
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it("inside the backup a write request goes out", async () => {
    const sender = vi.fn(async () => new Response("{}"))
    await runAsStoreBackup(() => driveWriteFetch("https://www.googleapis.com/drive/v3/files/x", { method: "PATCH" }, sender as unknown as typeof fetch))
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it("isWriteMethod: only GET and HEAD are reads", () => {
    expect(["GET", "HEAD", undefined, null, "get"].map((m) => isWriteMethod(m as string | undefined | null))).toEqual([false, false, false, false, false])
    expect(["POST", "PUT", "PATCH", "DELETE", "post"].every((m) => isWriteMethod(m))).toBe(true)
  })
})

describe("READS are never affected (the archive, the by-hand copy tools, the Drive preview of raw records)", () => {
  it("searching, listing, reading metadata and downloading work outside the backup and send no write", async () => {
    await drive.searchFiles("name contains 'a'")
    await drive.listFolder("folder")
    await drive.listFolderAnyDrive("folder")
    await drive.getFileMetadata("file")
    await drive.getDriveFileChecksum("file")
    await drive.downloadFileBinary("file").catch(() => undefined) // the fake answer is JSON, not a file: only the request matters here
    await drive.getDriveItemAnyDrive("file")
    await drive.listFolderPageAnyDrive("folder")
    expect(driveCalls().length).toBeGreaterThan(0)
    expect(writeCalls()).toEqual([])
    expect(reported).toEqual([])
  })
})
