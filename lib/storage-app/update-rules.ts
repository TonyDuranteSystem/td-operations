/**
 * Updating a file this Mac saved (dev job 1992a087 phase C1, safe-save follow-up bd21e833) — the PURE rules: the key of one update's
 * upload slot, and the plain-English answers for every outcome of the one safe save (store_append_version). No database, no network.
 *
 * Status codes are chosen for the SHIPPED Mac app: 409 / 413 / 422 are shown to the person as "refused" with the body's `message` and are
 * NOT retried; 429 is "try later"; anything else (500 …) is retried. So a locked, filed or changed-by-someone-else file answers 422 / 409.
 */
import { conflictText, lockText } from "@/lib/crm-store/new-version-rules"

/** One Mac update = one slot: the file's own key plus THIS update's item key (so two updates never share a slot). */
export const updateCallerKey = (fileCallerKey: string, itemKey: string): string => `${fileCallerKey}:u:${itemKey.toLowerCase()}`

/**
 * Does an upload slot belong to this update?
 *   "match"  — made for exactly this update (its caller key is the update key)
 *   "legacy" — made before slots were keyed per update (its key is the file's own key): usable once, but never answered as a repeat
 *   "no"     — anything else
 */
export function slotBelongsToUpdate(p: { slotKey: string | null | undefined; fileCallerKey: string; itemKey: string }): "match" | "legacy" | "no" {
  if (p.slotKey === updateCallerKey(p.fileCallerKey, p.itemKey)) return "match"
  if (p.slotKey === p.fileCallerKey) return "legacy"
  return "no"
}

/** A body that has to be a positive whole number to count as the version the Mac started from; anything else = not sent (last write wins, as before). */
export function parseBaseVersionNo(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : null
}

export interface AppendOutcome {
  status: string
  kind?: string | null
  name?: string | null
  versionNo?: number | null
  currentVersionNo?: number | null
  alreadyApplied?: boolean
}
export interface UpdateAnswer { status: 200 | 404 | 409 | 422; body: Record<string, unknown>; /** true = the new bytes are now (or already were) the file's current content */ done: boolean }

/** The answer to the Mac for each outcome of the safe save. Never raw codes in `message`. */
export function answerForAppend(res: AppendOutcome, fileId: string, ownerId: string, fallbackName: string, size: number): UpdateAnswer {
  const name = res.name ?? fallbackName
  switch (res.status) {
    case "versioned":
    case "unchanged":
      return { status: 200, done: true, body: { fileId, ownerId, name, size, outcome: res.status, ...(res.versionNo ? { versionNo: res.versionNo } : {}), ...(res.alreadyApplied ? { alreadyApplied: true } : {}) } }
    case "conflict":
      return { status: 409, done: false, body: { error: "conflict", message: conflictText({ name, currentVersionNo: res.currentVersionNo }), currentVersionNo: res.currentVersionNo ?? null } }
    case "unmerged":
      // a Mac never asks for a hidden "not applied" copy; if one is ever made, tell it plainly that the current copy did not change
      return { status: 409, done: false, body: { error: "conflict", message: `Someone else changed "${name}". Your copy was kept aside and the current file was not changed.`, currentVersionNo: res.currentVersionNo ?? null } }
    case "locked":
      return { status: 422, done: false, body: { error: "locked", kind: res.kind ?? null, message: lockText(res.kind, name) } }
    case "frozen":
      return { status: 422, done: false, body: { error: "frozen", kind: "filed", message: lockText("filed", name) } }
    case "needs_confirmation":
      return { status: 422, done: false, body: { error: "locked", kind: "amended", message: `"${name}" is an amended return. Change it in the CRM, where the change is confirmed with a reason.` } }
    case "trashed":
      return { status: 409, done: false, body: { error: "trashed", message: `"${name}" is in the trash. Restore it in the CRM first.` } }
    default:
      return { status: 404, done: false, body: { error: "not_found", message: "That file was not found." } }
  }
}
