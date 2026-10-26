/**
 * Storage "save a new version of this file" — the PURE rules and the plain-English words (dev job bd21e833, master plan Part 54).
 * The real decisions (changed since you opened it, locks, same bytes) are made in ONE database function; this file only holds
 * what can be known from the two files side by side, and the sentences shown to people. Unit-tested without a browser or a database.
 */

export interface OldFile { name: string; mimeType: string | null; size: number | null }
export interface NewFile { name: string; mimeType: string | null; size: number }
export type ReplaceWarning = "different_type" | "much_smaller"

const extOf = (name: string): string => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}

/** An empty file is never saved; a different type or a file more than 90% smaller needs the person's OK first. */
export function checkReplacement(oldFile: OldFile, next: NewFile): { block: string | null; warnings: ReplaceWarning[] } {
  if (next.size <= 0) return { block: "The file you chose is empty, so nothing was saved.", warnings: [] }
  const warnings: ReplaceWarning[] = []
  const a = extOf(oldFile.name)
  const b = extOf(next.name)
  // .jpg / .jpeg are the same thing; everything else must match
  const norm = (x: string) => (x === "jpeg" ? "jpg" : x)
  if (norm(a) !== norm(b)) warnings.push("different_type")
  if (oldFile.size !== null && oldFile.size >= 10 * 1024 && next.size < oldFile.size * 0.1) warnings.push("much_smaller")
  return { block: null, warnings }
}

export function warningText(w: ReplaceWarning, oldName: string, newName: string): string {
  if (w === "different_type") return `"${newName}" is a different kind of file than "${oldName}". Save it as the new version anyway?`
  return `"${newName}" is much smaller than the current version (more than 90% smaller). Save it as the new version anyway?`
}

/** The sentence for a file that cannot be edited in place. */
export function lockText(kind: string | null | undefined, name: string, signedOn?: string | null): string {
  if (kind === "signed") return `"${name}" was signed${signedOn ? ` on ${signedOn}` : ""}. A changed file is no longer what was signed, so it can't be edited. Add a replacement instead.`
  if (kind === "replace_only") return `"${name}" is a passport or ID. It is never edited in place. Add a replacement instead.`
  if (kind === "replaced") return `"${name}" has been replaced by a newer file. Change the newer file instead.`
  if (kind === "filed") return `"${name}" is a filed return and can't be changed. Save the correction as an amended return.`
  return `"${name}" can't be edited in place.`
}

export function conflictText(p: { name: string; currentVersionNo?: number | null; by?: string | null; at?: string | null }): string {
  const who = p.by ? ` by ${p.by}` : ""
  const when = p.at ? `, ${p.at}` : ""
  return `Someone else changed "${p.name}": version ${p.currentVersionNo ?? "?"} was saved${who}${when}. Your file has NOT been saved, so nothing was overwritten.`
}

export type NewVersionReply =
  | { status: "versioned"; versionNo: number; message: string }
  | { status: "unmerged"; versionNo: number; message: string }
  | { status: "unchanged"; message: string; alreadyApplied?: boolean }
  | { status: "conflict"; currentVersionNo: number | null; message: string }
  | { status: "locked" | "frozen"; kind: string | null; message: string }
  | { status: "needs_confirmation"; kind: "amended"; token: string | null; message: string }
  | { status: "refused" | "trashed" | "not_found"; message: string }

/** Plain words for a status of the database function (never a code). */
export function statusMessage(status: string, name: string): string {
  if (status === "trashed") return `"${name}" is in the trash. Restore it first, then save the new version.`
  if (status === "not_found") return "This file no longer exists."
  if (status === "unchanged") return `Nothing changed — this is the same as the current version of "${name}".`
  return `The file was not saved (the storage answered "${status}") — please try again.`
}

/**
 * A staff upload with the SAME NAME as a file that takes no new version (signed, passport/ID, replaced, amended, filed):
 * the plain refusal, or null when the old file may take a new version. Asked BEFORE the old copy is hidden from the client.
 */
export function sameNameLockRefusal(lockKind: string | null | undefined, name: string): string | null {
  if (!lockKind) return null
  return `${lockText(lockKind, name)} Add the new file under another name, or use "Upload edited version" on the file.`
}
