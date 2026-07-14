/**
 * The committed production snapshot — loading and validating it.
 *
 * Split from lib/db-contract.ts so the pure comparison stays free of any import of the JSON
 * file (unit tests feed it fixtures; nothing should have to reason about the real 190-row
 * snapshot to test a comparison).
 */

import snapshotJson from "@/db/constraints.prod.json"
import { type ConstraintDefs, checksumDefs } from "@/lib/db-contract"

export interface ProdSnapshot {
  generated_from: string
  generated_at: string
  constraint_count: number
  checksum_md5: string
  constraints: ConstraintDefs
}

const snapshot = snapshotJson as unknown as ProdSnapshot

/** Production's CHECK constraints as of the last regeneration. */
export function prodConstraints(): ConstraintDefs {
  return snapshot.constraints
}

export function prodSnapshotMeta() {
  return {
    generatedFrom: snapshot.generated_from,
    generatedAt: snapshot.generated_at,
    count: snapshot.constraint_count,
    checksum: snapshot.checksum_md5,
  }
}

/**
 * Is the snapshot file internally honest?
 *
 * Its stated checksum and count must match its own contents. This catches the one attack the
 * whole design is otherwise open to: someone (a person, or a future me under deadline)
 * editing the file to add the value a failing gate is complaining about, instead of adding it
 * to the database. That would turn the gate into a rubber stamp — and it would look exactly
 * like a fix.
 *
 * The checksum can only be produced by the database over its own constraints, so the honest
 * way to change this file is to change production and regenerate.
 */
export function verifySnapshotIntegrity(): { ok: boolean; reason?: string } {
  const defs = snapshot.constraints
  const actualCount = Object.keys(defs).length

  if (actualCount !== snapshot.constraint_count) {
    return {
      ok: false,
      reason:
        `The snapshot claims ${snapshot.constraint_count} constraints but contains ${actualCount}. ` +
        `It has been edited by hand. Regenerate it from production: npm run snapshot:constraints`,
    }
  }

  const actualChecksum = checksumDefs(defs)
  if (actualChecksum !== snapshot.checksum_md5) {
    return {
      ok: false,
      reason:
        `The snapshot's checksum does not match its contents (file says ${snapshot.checksum_md5}, ` +
        `contents hash to ${actualChecksum}). It has been edited by hand. If the database really ` +
        `changed, change it there and regenerate: npm run snapshot:constraints — do NOT edit this ` +
        `file to silence a failing gate; that converts the gate into a rubber stamp.`,
    }
  }

  return { ok: true }
}
