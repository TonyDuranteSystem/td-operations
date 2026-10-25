import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * Many store_* functions are redefined in several migrations (CREATE OR REPLACE). Whoever changes one next must copy the CURRENT
 * text (the newest file below), not an older one — copying an old body silently reverts a fix. This test pins which file is the
 * newest definition of each repeated function. If you redefine one: copy from the file named here, then update THIS map and the
 * table in docs/systems/storage.md in the same change.
 * (store_write is not pinned here: it is owned by the save-path work and changes more often.)
 */
const CANONICAL_LATEST: Record<string, string> = {
  store_abandoned_intents: "20261025-1500-storage-datalayer-hardening.sql",
  store_attach_formation: "20261025-1500-storage-datalayer-hardening.sql",
  store_backup_dirty_owners: "20261013-0900-store-backup-skip-unbacked-owners.sql",
  store_backup_gap_counts: "20261013-0900-store-backup-skip-unbacked-owners.sql",
  store_backup_gaps: "20261013-0900-store-backup-skip-unbacked-owners.sql",
  store_company_contacts: "20260925-1500-crm-store-s3-access.sql",
  store_ensure_owner: "20260927-1000-crm-store-structure.sql",
  store_file_self_visible: "20260926-1900-crm-store-s6-formation-pilot.sql",
  store_import_claim: "20260929-1100-crm-store-drive-import-claim-guard.sql",
  store_purge_pending_objects: "20261025-1500-storage-datalayer-hardening.sql",
  store_rehome_file: "20261025-1500-storage-datalayer-hardening.sql",
  store_rehome_subtree: "20261025-1500-storage-datalayer-hardening.sql",
  store_remove_link: "20261025-1500-storage-datalayer-hardening.sql",
  store_rename_root: "20261025-1500-storage-datalayer-hardening.sql",
  store_set_filing_status: "20261025-1500-storage-datalayer-hardening.sql",
  store_set_published: "20261025-1500-storage-datalayer-hardening.sql",
}

function definitions(): Map<string, string[]> {
  const dir = join(process.cwd(), "scripts/migrations")
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".UNDO.sql")).sort()
  const out = new Map<string, string[]>()
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8")
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION public\.(store_[a-z0-9_]+)\(/g)) {
      const list = out.get(m[1]) ?? []
      if (!list.includes(f)) list.push(f)
      out.set(m[1], list)
    }
  }
  return out
}

describe("repeated store_* function definitions", () => {
  const defs = definitions()
  for (const [fn, latest] of Object.entries(CANONICAL_LATEST)) {
    it(`${fn}: the newest definition is ${latest}`, () => {
      const files = defs.get(fn) ?? []
      expect(files.length, `${fn} is not defined in any migration`).toBeGreaterThan(0)
      expect(files[files.length - 1], `${fn} was redefined in a newer file — update CANONICAL_LATEST and docs/systems/storage.md`).toBe(latest)
    })
  }
  it("every pinned function really is defined in more than one file (otherwise it does not belong in the map)", () => {
    for (const fn of Object.keys(CANONICAL_LATEST)) expect((defs.get(fn) ?? []).length, fn).toBeGreaterThan(1)
  })
})
