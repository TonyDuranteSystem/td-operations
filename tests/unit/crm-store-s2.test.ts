import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }))

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  assertDriveWriteAllowed,
  isProductionDatabase,
  DriveWriteRefusedError,
  PRODUCTION_SHARED_DRIVE_ID,
} from "@/lib/google-drive-guard"
import { saveBytesToStore, sha256Hex, StoreFrozenFileError, registerNow, cleanupStore, createUploadIntent } from "@/lib/crm-store/writer"

const PROD_ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://ydzipybqeebtpcvsbtvs.supabase.co" }
const SANDBOX_ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://xjcxlmlpeywtwkhstjlw.supabase.co", GOOGLE_SHARED_DRIVE_ID: "TEST_DRIVE" }

describe("production-Drive guard", () => {
  const lookup = (map: Record<string, string | null>) => async (id: string) => map[id] ?? null

  it("allows everything against the production database (and never looks anything up)", async () => {
    const spy = vi.fn()
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["x"] }, spy, PROD_ENV)).resolves.toBeUndefined()
    await expect(assertDriveWriteAllowed({ kind: "my_drive" }, spy, PROD_ENV)).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })
  it("refuses outside production when no test drive is set, or it is the production drive", async () => {
    const env1 = { NEXT_PUBLIC_SUPABASE_URL: SANDBOX_ENV.NEXT_PUBLIC_SUPABASE_URL }
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["a"] }, lookup({ a: "TEST_DRIVE" }), env1)).rejects.toBeInstanceOf(DriveWriteRefusedError)
    const env2 = { ...env1, GOOGLE_SHARED_DRIVE_ID: PRODUCTION_SHARED_DRIVE_ID }
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["a"] }, lookup({ a: PRODUCTION_SHARED_DRIVE_ID }), env2)).rejects.toBeInstanceOf(DriveWriteRefusedError)
  })
  it("refuses a sandbox write into a REAL client folder even with the test drive set", async () => {
    await expect(
      assertDriveWriteAllowed({ kind: "shared", ids: ["real-client-folder"] }, lookup({ "real-client-folder": PRODUCTION_SHARED_DRIVE_ID }), SANDBOX_ENV),
    ).rejects.toBeInstanceOf(DriveWriteRefusedError)
  })
  it("refuses My Drive and unknown targets outside production", async () => {
    await expect(assertDriveWriteAllowed({ kind: "my_drive" }, lookup({}), SANDBOX_ENV)).rejects.toBeInstanceOf(DriveWriteRefusedError)
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["unknown"] }, lookup({}), SANDBOX_ENV)).rejects.toBeInstanceOf(DriveWriteRefusedError)
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: [] }, lookup({}), SANDBOX_ENV)).rejects.toBeInstanceOf(DriveWriteRefusedError)
  })
  it("allows a sandbox write when every target is inside the test drive", async () => {
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["f", "p"] }, lookup({ f: "TEST_DRIVE", p: "TEST_DRIVE" }), SANDBOX_ENV)).resolves.toBeUndefined()
    await expect(assertDriveWriteAllowed({ kind: "shared", ids: ["f", "p"] }, lookup({ f: "TEST_DRIVE", p: PRODUCTION_SHARED_DRIVE_ID }), SANDBOX_ENV)).rejects.toBeInstanceOf(DriveWriteRefusedError)
  })
  it("detects production by the Supabase database, not by Vercel", () => {
    expect(isProductionDatabase(PROD_ENV)).toBe(true)
    expect(isProductionDatabase({ ...SANDBOX_ENV, VERCEL_ENV: "production" })).toBe(false)
    // a custom-domain URL in production is still recognised through the declared ref
    expect(isProductionDatabase({ NEXT_PUBLIC_SUPABASE_URL: "https://db.example.com", EXPECTED_SUPABASE_REF: "ydzipybqeebtpcvsbtvs" })).toBe(true)
  })
  it("every Drive write request in google-drive.ts sits in a function that calls the guard first", () => {
    const src = readFileSync(join(process.cwd(), "lib/google-drive.ts"), "utf8")
    const fnStarts = Array.from(src.matchAll(/\n(?:export )?async function (\w+)\(/g)).map(m => ({ name: m[1], at: m.index! }))
    const writeCalls = Array.from(src.matchAll(/method: "(POST|PATCH|PUT|DELETE)"/g)).map(m => m.index!)
    expect(writeCalls.length).toBeGreaterThan(5)
    // helpers that only perform the network call for an already-guarded caller
    const lowLevel = new Set(["getAccessToken", "driveUpload", "uploadBinaryToDriveResumable"])
    for (const at of writeCalls) {
      const fn = fnStarts.filter(f => f.at < at).pop()!
      if (lowLevel.has(fn.name)) continue
      const body = src.slice(fn.at, at)
      expect(body.includes("await guardDriveWrite("), `${fn.name} must call guardDriveWrite before its ${src.slice(at, at + 20)}`).toBe(true)
    }
  })
  it("no other file in app/ or lib/ writes to the Drive API", () => {
    const { execSync } = require("child_process") as typeof import("child_process")
    const out = execSync("grep -rlE \"googleapis.com/(upload/)?drive\" app lib || true", { encoding: "utf8" })
    const files = out.split("\n").filter(Boolean).filter(f => f !== "lib/google-drive.ts")
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      // only read-only uses are allowed elsewhere (sync-drive: readonly scope; docai: files.get)
      expect(/googleapis\.com\/upload\/drive/.test(src), `${f} uploads to Drive outside the guarded module`).toBe(false)
    }
  })
})

// ── writer orchestration (Supabase mocked) ──
function storageMock(opts: { infoSize?: number } = {}) {
  return {
    upload: vi.fn(async () => ({ error: null })),
    remove: vi.fn(async () => ({ error: null })),
    info: vi.fn(async () => ({ data: { size: opts.infoSize }, error: null })),
    move: vi.fn(async () => ({ error: null })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://example.test/obj" }, error: null })),
  }
}
const input = { ownerId: "o1", folderId: "f1", name: "Summary.pdf", bytes: Buffer.from("hello"), callerKey: "k1", actor: "u1", contentChanged: true }

describe("saveBytesToStore", () => {
  beforeEach(() => vi.clearAllMocks())
  it("uploads to an id-based path, registers with the real SHA-256 and size, keeps the bytes on 'created'", async () => {
    const st = storageMock({ infoSize: 5 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: { status: "created", file_id: "file1", version_id: "v1", name: "Summary.pdf" }, error: null } as never)
    const r = await saveBytesToStore(input)
    expect(r.status).toBe("created")
    const [path] = st.upload.mock.calls[0] as unknown as [string]
    expect(path.startsWith("o1/")).toBe(true)
    expect(path).not.toContain("Summary")
    const args = (vi.mocked(supabaseAdmin.rpc).mock.calls[0][1] as { p: Record<string, unknown> }).p
    expect(args.sha256).toBe(sha256Hex(Buffer.from("hello")))
    expect(args.size).toBe(5)
    expect(args.caller_key).toBe("k1")
    expect(args.content_changed).toBe(true)
    expect(st.remove).not.toHaveBeenCalled()
  })
  it("removes the just-uploaded bytes when the content is unchanged", async () => {
    const st = storageMock({ infoSize: 5 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: { status: "unchanged", file_id: "file1", version_id: "v1", name: "Summary.pdf" }, error: null } as never)
      .mockResolvedValueOnce({ data: false, error: null } as never)
    expect((await saveBytesToStore(input)).status).toBe("unchanged")
    expect(st.remove).toHaveBeenCalledTimes(1)
  })
  it("throws a frozen-file error (never a silent 'done') and removes the bytes", async () => {
    const st = storageMock({ infoSize: 5 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: { status: "frozen", file_id: "file1", version_id: "v1", name: "1065 2025.pdf" }, error: null } as never)
      .mockResolvedValueOnce({ data: false, error: null } as never)
    await expect(saveBytesToStore(input)).rejects.toBeInstanceOf(StoreFrozenFileError)
    expect(st.remove).toHaveBeenCalledTimes(1)
  })
  it("removes the bytes when registration fails, or when Storage reports a different size", async () => {
    const st = storageMock({ infoSize: 5 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never)
      .mockResolvedValueOnce({ data: false, error: null } as never)
    await expect(saveBytesToStore(input)).rejects.toThrow(/boom/)
    expect(st.remove).toHaveBeenCalledTimes(1)
    const st2 = storageMock({ infoSize: 999 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st2 as never)
    vi.mocked(supabaseAdmin.rpc).mockResolvedValueOnce({ data: false, error: null } as never)
    await expect(saveBytesToStore(input)).rejects.toThrow(/stored size/)
    expect(st2.remove).toHaveBeenCalledTimes(1)
  })
})

describe("registerNow", () => {
  beforeEach(() => vi.clearAllMocks())
  const slot = { owner_id: "o1", folder_id: "f1", file_name: "Passport.pdf", mime_type: "application/pdf", caller_key: null, staging_path: "u1/i1/x", dest_path: "o1/dest" }
  it("refuses an invalid / busy slot without touching storage", async () => {
    const st = { ...storageMock({ infoSize: 5 }), exists: vi.fn() }
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: null, error: { message: "store: this upload slot is unknown, already registered, busy or not yours" } } as never)
    await expect(registerNow({ intentId: "i1", actor: "u1" })).rejects.toThrow(/busy or not yours/)
    expect(st.move).not.toHaveBeenCalled()
  })
  it("streams the hash, moves staging → store at the slot's fixed destination, registers and finalises", async () => {
    const st = { ...storageMock({ infoSize: 5 }), exists: vi.fn(async () => ({ data: true, error: null })) }
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: slot, error: null } as never)                                   // claim
      .mockResolvedValueOnce({ data: { status: "created", file_id: "file9", version_id: "v9", name: "Passport.pdf" }, error: null } as never) // write
      .mockResolvedValueOnce({ data: null, error: null } as never)                                   // finalise
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from("hello")) as never)
    const r = await registerNow({ intentId: "i1", actor: "u1", links: [{ kind: "service_case", recordId: "sd1", stage: "Filed with State" }] })
    expect(r.status).toBe("created")
    expect(st.move).toHaveBeenCalledWith("u1/i1/x", "o1/dest", { destinationBucket: "crm-store" })
    const p = (vi.mocked(supabaseAdmin.rpc).mock.calls[1][1] as { p: Record<string, unknown> }).p
    expect(p.sha256).toBe(sha256Hex(Buffer.from("hello")))
    expect(p.path).toBe("o1/dest")
    expect(p.links).toEqual([{ kind: "service_case", record_id: "sd1", stage: "Filed with State", tax_year: null }])
    expect(vi.mocked(supabaseAdmin.rpc).mock.calls[2][0]).toBe("store_finalize_intent")
    fetchSpy.mockRestore()
  })
  it("a retry after a killed attempt resumes from the store (object already moved), without moving again", async () => {
    const st = { ...storageMock({ infoSize: 5 }), exists: vi.fn(async () => ({ data: false, error: null })) }
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: slot, error: null } as never)
      .mockResolvedValueOnce({ data: { status: "created", file_id: "file9", version_id: "v9", name: "Passport.pdf" }, error: null } as never)
      .mockResolvedValueOnce({ data: null, error: null } as never)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from("hello")) as never)
    expect((await registerNow({ intentId: "i1", actor: "u1" })).status).toBe("created")
    expect(st.move).not.toHaveBeenCalled()
    expect(vi.mocked(supabaseAdmin.storage.from).mock.calls.some(c => c[0] === "crm-store")).toBe(true)
    fetchSpy.mockRestore()
  })
})

describe("a committed save is never destroyed by a lost reply", () => {
  beforeEach(() => vi.clearAllMocks())
  it("keeps the uploaded object when registration errors but a version already refers to it", async () => {
    const st = storageMock({ infoSize: 5 })
    vi.mocked(supabaseAdmin.storage.from).mockReturnValue(st as never)
    vi.mocked(supabaseAdmin.rpc)
      .mockResolvedValueOnce({ data: null, error: { message: "network reset" } } as never) // store_write reply lost
      .mockResolvedValueOnce({ data: true, error: null } as never)                          // store_object_referenced → yes
    await expect(saveBytesToStore(input)).rejects.toThrow(/network reset/)
    expect(st.remove).not.toHaveBeenCalled()
  })
})

describe("createUploadIntent", () => {
  beforeEach(() => vi.clearAllMocks())
  it("refuses anyone outside the explicit staff allow-list (incl. an empty role)", async () => {
    for (const role of [undefined, "", "client", "partner"]) {
      await expect(createUploadIntent({ ownerId: "o", folderId: "f", fileName: "a.pdf", actor: "u", actorRole: role })).rejects.toThrow(/only staff/)
    }
  })
})

describe("cleanupStore", () => {
  beforeEach(() => vi.clearAllMocks())
  it("does nothing when nothing is abandoned or orphaned", async () => {
    vi.mocked(supabaseAdmin.rpc).mockResolvedValue({ data: [], error: null } as never)
    expect(await cleanupStore()).toEqual({ slotsClosed: 0, orphansRemoved: 0 })
  })
})

describe("S2 migration (static)", () => {
  const sql = readFileSync(join(process.cwd(), "scripts/migrations/20260925-1100-crm-store-s2-writer.sql"), "utf8")
  it("lets a browser write only its own unconsumed staging slot, with the explicit staff allow-list", () => {
    expect(sql).toMatch(/FOR INSERT TO authenticated\s+WITH CHECK \(bucket_id = 'crm-store-staging' AND public\.store_staging_upload_allowed\(name\)\)/)
    expect(sql).toMatch(/IN \('admin', 'team'\)/)
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? []
    expect(policies.length).toBe(1)
    for (const pol of policies) expect(pol).not.toMatch(/bucket_id = 'crm-store'[^-]/)
    expect(sql).not.toMatch(/FOR (SELECT|UPDATE|DELETE|ALL)/)
  })
  it("never cascades", () => {
    expect(sql).not.toMatch(/ON DELETE CASCADE/i)
  })
})
