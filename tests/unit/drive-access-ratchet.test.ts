import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import allow from "./fixtures/drive-access-allowlist.json"

/**
 * The Drive-access ratchets (dev job ad09ea91 plan Part 32; Stop Drive S2, dev job 264bb882).
 *
 * WRITE ratchet (strict, no list that grows): since Stop Drive S2 NOTHING but the one-way storage backup may write to Google Drive.
 * Exactly ONE application file may import a Drive write helper — lib/crm-store/backup.ts (the helpers' own definition file,
 * lib/google-drive.ts, is the only other file that names them). A new file that imports a write helper fails here: use the CRM
 * storage (saveDocumentForAccount / saveDocumentForContact) instead. The runtime switch (lib/google-drive-write-scope.ts) refuses such
 * a call anyway; this test makes the mistake visible at review time.
 *
 * READ ratchet: the files that read a company document straight from Google Drive (the read-only archive) are listed in
 * tests/unit/fixtures/drive-access-allowlist.json (`readers`). The list may only SHRINK.
 */

const ROOT = join(__dirname, "..", "..")
const DIRS = ["app", "lib", "components"]

const DRIVE_WRITE_HELPERS = [
  "uploadFile", "updateFileContent", "renameFile", "createFolder", "moveFile", "createFolderMyDrive", "uploadFileMyDrive", "ensureDrivePath",
  "uploadBinaryToDrive", "uploadBinaryToDriveUpsert", "updateBinaryFile", "trashFile", "findOrCreateYearFolder", "createTaggedFolder",
  "patchTaggedItem", "uploadStreamToDrive",
]
const READ_PATTERN = /\b(downloadFileBinary|downloadFileBinaryForSend)\b/

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}

function appFiles(): string[] {
  const files: string[] = []
  for (const d of DIRS) walk(join(ROOT, d), files)
  return files.map((f) => relative(ROOT, f)).sort()
}

const MODULE = String.raw`["'][^"']*\/google-drive["']`

/** Every name a file takes from the Drive client module: static imports, dynamic destructures, `(await import(...)).name`. */
function namesImportedFromDriveClient(src: string): string[] {
  const names = new Set<string>()
  const add = (list: string) => { for (const part of list.split(",")) { const n = part.trim().split(/\s+as\s+/)[0].trim(); if (n) names.add(n) } }
  for (const m of Array.from(src.matchAll(new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${MODULE}`, "g")))) add(m[1])
  for (const m of Array.from(src.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*${MODULE}\s*\)`, "g")))) add(m[1])
  for (const m of Array.from(src.matchAll(new RegExp(String.raw`\(\s*await\s+import\(\s*${MODULE}\s*\)\s*\)\.(\w+)`, "g")))) names.add(m[1])
  // a namespace import or a bare module handle: any write helper named in the file counts
  const namespaced = new RegExp(String.raw`import\s*\*\s*as\s+\w+\s+from\s*${MODULE}`).test(src) || new RegExp(String.raw`(?:const|let|var)\s+\w+\s*=\s*await\s+import\(\s*${MODULE}\s*\)`).test(src)
  if (namespaced) for (const h of DRIVE_WRITE_HELPERS) if (new RegExp(String.raw`\b${h}\b`).test(src)) names.add(h)
  return Array.from(names)
}

describe("Drive WRITE ratchet — only the one-way storage backup may write to Google Drive", () => {
  it("exactly one application file imports a Drive write helper: the backup", () => {
    const writers = appFiles()
      .filter((f) => f !== "lib/google-drive.ts")
      .filter((f) => namesImportedFromDriveClient(readFileSync(join(ROOT, f), "utf8")).some((n) => DRIVE_WRITE_HELPERS.includes(n)))
    expect(writers, `A file imports a Drive write helper: ${writers.join(", ")} — Drive is the backup + a read-only archive; save to the CRM storage instead.`).toEqual(allow.writers)
    expect(allow.writers).toEqual(["lib/crm-store/backup.ts"])
  })

  it("the backup runs every Drive write inside the backup scope (runAsStoreBackup)", () => {
    const src = readFileSync(join(ROOT, "lib/crm-store/backup.ts"), "utf8")
    for (const call of ["createTaggedFolder", "patchTaggedItem", "uploadStreamToDrive", "trashFile"]) {
      const re = new RegExp(String.raw`drive\.${call}\(`, "g")
      for (const m of Array.from(src.matchAll(re))) {
        const lineStart = src.lastIndexOf("\n", m.index) + 1
        expect(src.slice(lineStart, m.index), `${call} must be wrapped in runAsStoreBackup`).toContain("runAsStoreBackup(")
      }
    }
  })
})

describe("Drive READ ratchet — the list only shrinks", () => {
  const listed = new Set<string>(allow.readers)
  const current = appFiles().filter((f) => READ_PATTERN.test(readFileSync(join(ROOT, f), "utf8")))

  it("no NEW file reads a company document directly in Drive", () => {
    const added = current.filter((f) => !listed.has(f))
    expect(added, `New direct Drive read: ${added.join(", ")} — use openDocument() / the storage path, or add it on purpose to tests/unit/fixtures/drive-access-allowlist.json after review (dev job ad09ea91).`).toEqual([])
  })

  it("a file that no longer reads Drive directly is removed from the list", () => {
    const gone = Array.from(listed).filter((f) => !current.includes(f))
    expect(gone, `No longer read Drive directly — remove from tests/unit/fixtures/drive-access-allowlist.json: ${gone.join(", ")}`).toEqual([])
  })
})
