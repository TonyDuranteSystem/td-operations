import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  assertDriveWriteAllowed,
  isProductionDatabase,
  DriveWriteRefusedError,
  PRODUCTION_SHARED_DRIVE_ID,
} from "@/lib/google-drive-guard"

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
