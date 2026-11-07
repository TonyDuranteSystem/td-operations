/**
 * A short fingerprint of what the client SUBMITTED on a tax questionnaire: the answers and the list of uploaded files (dev job 7df278cd, Shipment 2).
 *
 * Used for two rules that must agree on "is this the same submission?":
 *   - a client's resubmit that changed nothing does not open a new save (so no pointless new version of the saved file),
 *   - the save job checks, just before it says "saved", that the client did not change the answers while it was running.
 *
 * Pure: key order and file order do not matter; an answer of undefined and one that is absent read the same (JSON drops both).
 */

import { createHash } from "node:crypto"

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canonical((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

export function answersFingerprint(submittedData: unknown, uploadPaths: unknown): string {
  const paths = Array.isArray(uploadPaths) ? uploadPaths.filter((p): p is string => typeof p === "string").slice().sort() : []
  const body = JSON.stringify({ d: canonical(submittedData ?? {}), u: paths })
  return createHash("sha1").update(body).digest("hex")
}
