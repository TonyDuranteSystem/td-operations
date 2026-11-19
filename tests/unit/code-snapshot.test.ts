/**
 * Code snapshot (dev job ad26bd7f): the production code tools read ONE packed file instead of ~5,000 loose sources.
 * These tests prove (1) the packing script and the tool use the SAME rules, (2) packing leaves out secrets / binaries / big files,
 * (3) the tools answer the SAME from a snapshot as from the real files, and (4) a deployment with no snapshot says so.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest"
import { createRequire } from "node:module"
import fs from "fs"
import os from "os"
import path from "path"
import zlib from "zlib"
import {
  BLOCKED_PATH,
  SOURCE_ROOTS,
  TEXT_EXT,
  MAX_SEARCH_FILE_BYTES,
  SNAPSHOT_REL_PATH,
  SNAPSHOT_MISSING_MESSAGE,
  readCodebaseFile,
  searchCodebase,
  setCodeSnapshotForTests,
  loadSnapshotFile,
  type CodeSnapshot,
} from "@/lib/mcp/tools/codebase-read"

const requireCjs = createRequire(import.meta.url)
const builder = requireCjs("../../scripts/build-code-snapshot.js") as {
  BLOCKED_PATH: RegExp
  SOURCE_ROOTS: string[]
  TEXT_EXT: RegExp
  MAX_SEARCH_FILE_BYTES: number
  SNAPSHOT_REL_PATH: string
  MIN_PLAUSIBLE_FILES: number
  buildSnapshot: (root: string) => CodeSnapshot
  writeSnapshot: (root: string, outRel?: string) => { files: number; skipped: number; bytes: number; out: string }
}

const REPO = path.resolve(__dirname, "../..")

afterEach(() => {
  setCodeSnapshotForTests(undefined)
  delete process.env.VERCEL
})

describe("the packing script and the tool use the same rules", () => {
  it("same secret-path rule, folders, file types, size limit and file name", () => {
    expect(builder.BLOCKED_PATH.source).toBe(BLOCKED_PATH.source)
    expect(builder.BLOCKED_PATH.flags).toBe(BLOCKED_PATH.flags)
    expect(builder.SOURCE_ROOTS).toEqual(SOURCE_ROOTS)
    expect(builder.TEXT_EXT.source).toBe(TEXT_EXT.source)
    expect(builder.TEXT_EXT.flags).toBe(TEXT_EXT.flags)
    expect(builder.MAX_SEARCH_FILE_BYTES).toBe(MAX_SEARCH_FILE_BYTES)
    expect(builder.SNAPSHOT_REL_PATH).toBe(SNAPSHOT_REL_PATH)
  })
})

describe("packing a small fixture repo", () => {
  let root: string
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "snap-fixture-"))
    const put = (rel: string, data: string | Buffer) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), data)
    }
    put("lib/a.ts", "export const a = 1\nexport const needle = 'findme'\n")
    put("lib/b.ts", "export const b = 2\n")
    put("app/page.tsx", "export default function P() { return null }\n")
    put("components/c.tsx", "export const C = () => null\n")
    put("scripts/run.js", "console.log('hi')\n")
    put("middleware.ts", "export const m = 1\n")
    put("next.config.js", "module.exports = {}\n")
    put("lib/.env.local", "SECRET=1\n")
    put("lib/secrets/key.ts", "export const k = 'secret'\n")
    put("lib/node_modules/x/index.js", "x\n")
    put("lib/cert.pem", "-----BEGIN-----\n")
    put("lib/image.ts", Buffer.from([0x41, 0x00, 0x42]))
    put("lib/huge.ts", "x".repeat(MAX_SEARCH_FILE_BYTES + 10))
    put("lib/notes.bin", "not a text type\n")
    put("docs/outside.md", "outside the source folders\n")
  })

  it("keeps the source folders and leaves out secrets, dependencies, other folders and non-text files", () => {
    const snap = builder.buildSnapshot(root)
    const kept = Object.keys(snap.files).sort()
    expect(kept).toEqual([
      "app/page.tsx",
      "components/c.tsx",
      "lib/a.ts",
      "lib/b.ts",
      "middleware.ts",
      "next.config.js",
      "scripts/run.js",
    ])
    const everything = JSON.stringify(snap)
    expect(everything).not.toContain("SECRET=1")
    expect(everything).not.toContain("BEGIN")
    expect(everything).not.toContain("outside the source folders")
    expect(snap.list).not.toContain("lib/.env.local")
    expect(snap.list).not.toContain("lib/secrets/key.ts")
    expect(snap.list).not.toContain("lib/notes.bin")
  })

  it("records binary and oversized files as unreadable, without their content", () => {
    const snap = builder.buildSnapshot(root)
    expect(snap.skipped["lib/image.ts"]).toEqual({ size: 3, binary: true })
    expect(snap.skipped["lib/huge.ts"]).toEqual({ size: MAX_SEARCH_FILE_BYTES + 10, binary: false })
    expect(snap.files["lib/huge.ts"]).toBeUndefined()
  })

  it("refuses to write a snapshot that is implausibly small", () => {
    expect(() => builder.writeSnapshot(root)).toThrow(/only \d+ files/)
    expect(fs.existsSync(path.join(root, SNAPSHOT_REL_PATH))).toBe(false)
  })
})

describe("the tools served from a snapshot", () => {
  const snap: CodeSnapshot = {
    version: 1,
    builtAt: "2026-11-18T00:00:00.000Z",
    list: ["lib/a.ts", "lib/big.ts", "lib/img.ts", "lib/sub/b.ts", "middleware.ts"],
    files: {
      "lib/a.ts": "line one\nneedle here\nline three\n",
      "lib/sub/b.ts": "another needle\n",
      "middleware.ts": "export const m = 1\n",
      "lib/big.ts": "x".repeat(150 * 1024),
    },
    skipped: { "lib/img.ts": { size: 3, binary: true } },
  }

  it("reads a file with line numbers", async () => {
    setCodeSnapshotForTests(snap)
    const out = await readCodebaseFile("lib/a.ts")
    expect(out).toBe("# lib/a.ts\n\n1\tline one\n2\tneedle here\n3\tline three\n4\t")
  })

  it("answers not found, not a file, too large and binary the same way as the real files", async () => {
    setCodeSnapshotForTests(snap)
    expect(await readCodebaseFile("lib/missing.ts")).toContain("File not found")
    expect(await readCodebaseFile("lib/sub")).toContain("Not a file")
    expect(await readCodebaseFile("lib/big.ts")).toMatch(/File too large \(150KB > 100KB\)/)
    expect(await readCodebaseFile("lib/img.ts")).toContain("Binary file")
  })

  it("still refuses blocked paths and path escapes before looking anything up", async () => {
    setCodeSnapshotForTests(snap)
    expect(await readCodebaseFile(".env.local")).toContain("❌")
    expect(await readCodebaseFile("../outside.ts")).toContain("escapes")
  })

  it("searches the whole snapshot, a folder, and with an extension filter", async () => {
    setCodeSnapshotForTests(snap)
    const all = await searchCodebase("needle")
    expect(all).toContain("lib/a.ts:2: needle here")
    expect(all).toContain("lib/sub/b.ts:1: another needle")
    const scoped = await searchCodebase("needle", "lib/sub")
    expect(scoped).toBe("lib/sub/b.ts:1: another needle")
    expect(await searchCodebase("needle", undefined, "tsx")).toBe("(no matches)")
    expect(await searchCodebase("needle", "lib/a.ts")).toBe("lib/a.ts:2: needle here")
  })

  it("never searches binary or oversized files", async () => {
    setCodeSnapshotForTests(snap)
    expect(await searchCodebase("xxxx")).toContain("lib/big.ts") // under the 512 KB search limit: searchable
    const withoutBig: CodeSnapshot = {
      ...snap,
      files: Object.fromEntries(Object.entries(snap.files).filter(([k]) => k !== "lib/big.ts")),
      skipped: { ...snap.skipped, "lib/big.ts": { size: 600 * 1024, binary: false } },
    }
    setCodeSnapshotForTests(withoutBig)
    expect(await searchCodebase("xxxx")).toBe("(no matches)")
  })

  it("stops at 50 matches and says so", async () => {
    const many: CodeSnapshot = {
      ...snap,
      list: ["lib/many.ts"],
      files: { "lib/many.ts": Array.from({ length: 80 }, () => "needle").join("\n") },
      skipped: {},
    }
    setCodeSnapshotForTests(many)
    const out = await searchCodebase("needle")
    expect(out.split("\n").filter((l) => l.startsWith("lib/many.ts:")).length).toBe(50)
    expect(out).toContain("results capped at 50 matches")
  })
})

describe("a deployment without the snapshot", () => {
  it("says the snapshot is missing instead of 'not found' (only when running on Vercel)", async () => {
    setCodeSnapshotForTests(null)
    process.env.VERCEL = "1"
    expect(await readCodebaseFile("lib/a.ts")).toBe(SNAPSHOT_MISSING_MESSAGE)
    expect(await searchCodebase("needle")).toBe(SNAPSHOT_MISSING_MESSAGE)
  })

  it("reads the real files when there is no snapshot and it is not running on Vercel (local dev, tests)", async () => {
    setCodeSnapshotForTests(null)
    expect(await readCodebaseFile("package.json")).toContain("# package.json")
  })
})

describe("which source a process serves from", () => {
  it("on Vercel the packed file on disk is used", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-vercel-"))
    const snap: CodeSnapshot = { version: 1, builtAt: "x", list: ["lib/z.ts"], files: { "lib/z.ts": "packed copy\n" }, skipped: {} }
    const file = path.join(dir, "snap.json.gz")
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(snap), "utf8")))
    expect(await loadSnapshotFile(file)).toEqual(snap)
  })

  it("a missing, corrupt or foreign file is treated as 'no snapshot', never as an error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-bad-"))
    expect(await loadSnapshotFile(path.join(dir, "nope.gz"))).toBeNull()
    fs.writeFileSync(path.join(dir, "corrupt.gz"), "not gzip at all")
    expect(await loadSnapshotFile(path.join(dir, "corrupt.gz"))).toBeNull()
    fs.writeFileSync(path.join(dir, "foreign.gz"), zlib.gzipSync(Buffer.from(JSON.stringify({ version: 99, list: [], files: {}, skipped: {} }))))
    expect(await loadSnapshotFile(path.join(dir, "foreign.gz"))).toBeNull()
  })

  it("off Vercel the real files are read even when a snapshot file exists on disk", async () => {
    // generated/code-snapshot.json.gz may exist locally after `npm run build`; it must not change local answers.
    delete process.env.VERCEL
    setCodeSnapshotForTests(undefined)
    const out = await readCodebaseFile("package.json") // not part of the snapshot's folders, but a real file
    expect(out).toContain("# package.json")
  })
})

describe("a snapshot of THIS repo answers like the real files", () => {
  let real: CodeSnapshot
  beforeAll(() => {
    real = builder.buildSnapshot(REPO)
  }, 60_000)

  const lines = (s: string) => s.split("\n").filter(Boolean).sort()

  it("is a plausible size and carries no secrets", () => {
    expect(Object.keys(real.files).length).toBeGreaterThan(builder.MIN_PLAUSIBLE_FILES)
    expect(real.list.some((f) => BLOCKED_PATH.test(f))).toBe(false)
  })

  it("reads the same files with the same text", async () => {
    const samples = ["lib/mcp/tools/codebase-read.ts", "middleware.ts", "next.config.js", "lib/operations/sync-tier.ts", "scripts/build-code-snapshot.js"]
    for (const rel of samples) {
      if (!fs.existsSync(path.join(REPO, rel))) continue
      setCodeSnapshotForTests(null)
      const fromDisk = await readCodebaseFile(rel)
      setCodeSnapshotForTests(real)
      const fromSnap = await readCodebaseFile(rel)
      expect(fromSnap).toBe(fromDisk)
    }
  }, 60_000)

  it("finds the same lines for the same searches", async () => {
    const searches: Array<[string, string?, string?]> = [
      ["registerCodebaseReadTools"],
      ["resolveRepoPath", "lib/mcp"],
      ["SOURCE_ROOTS", undefined, "ts"],
      ["syncTier", "lib/operations"],
      ["zzz_string_that_should_never_appear_zzz"],
    ]
    for (const [pattern, dir, ext] of searches) {
      setCodeSnapshotForTests(null)
      const fromDisk = await searchCodebase(pattern, dir, ext)
      setCodeSnapshotForTests(real)
      const fromSnap = await searchCodebase(pattern, dir, ext)
      if (fromDisk.includes("capped at 50")) {
        expect(fromSnap).toContain("capped at 50")
      } else {
        // Same lines. (Order inside a folder can differ: the real walk follows the disk, the snapshot is sorted.)
        expect(lines(fromSnap)).toEqual(lines(fromDisk))
      }
    }
  }, 60_000)

  it("survives a real gzip round trip", () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(real), "utf8"))
    const back = JSON.parse(zlib.gunzipSync(gz).toString("utf8")) as CodeSnapshot
    expect(back.list.length).toBe(real.list.length)
    expect(Object.keys(back.files).length).toBe(Object.keys(real.files).length)
  })
})
