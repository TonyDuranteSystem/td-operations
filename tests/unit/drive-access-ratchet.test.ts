import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import allow from "./fixtures/drive-access-allowlist.json"

/**
 * The cutover ratchet (dev job ad09ea91, plan Part 32): nobody may ADD a new place that reads or writes a
 * company document straight in Google Drive. Existing places are listed and are moved to the storage-aware
 * path one by one; the list may only shrink. A new file that needs Drive access must either use
 * openDocument / the storage path, or be reviewed and added on purpose.
 */

const ROOT = join(__dirname, "..", "..")
const DIRS = ["app", "lib", "components"]
const PATTERN = /\b(uploadBinaryToDrive|uploadBinaryToDriveUpsert|ensureCompanyFolder|ensureContactFolder|downloadFileBinary|downloadFileBinaryForSend)\b/

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}

function currentUsers(): string[] {
  const files: string[] = []
  for (const d of DIRS) walk(join(ROOT, d), files)
  return files
    .map((f) => relative(ROOT, f))
    .filter((f) => PATTERN.test(readFileSync(join(ROOT, f), "utf8")))
    .sort()
}

describe("Drive-access ratchet", () => {
  const listed = new Set<string>(allow.files)
  const current = currentUsers()

  it("no NEW file reads or writes a company document directly in Drive", () => {
    const added = current.filter((f) => !listed.has(f))
    expect(added, `New direct Drive access: ${added.join(", ")} — use openDocument() / the storage path, or add it on purpose to tests/unit/fixtures/drive-access-allowlist.json after review (dev job ad09ea91).`).toEqual([])
  })

  it("the list only shrinks: a file that no longer touches Drive is removed from it", () => {
    const gone = [...listed].filter((f) => !current.includes(f))
    expect(gone, `No longer touch Drive directly — remove from tests/unit/fixtures/drive-access-allowlist.json: ${gone.join(", ")}`).toEqual([])
  })
})
