/**
 * CRM Store — the typed "this file is locked" error and the ONE place that turns store errors into plain English
 * (dev job bd21e833 follow-up: producers/writers around the lock rules).
 *
 * The database trigger `store_files_version_lock` refuses a new current version of a signed / passport-ID (replace_only) /
 * replaced / amended file with a check_violation whose DETAIL is `lock:<kind>`. `callWrite` (writer.ts) turns that into a
 * StoreLockedFileError so callers can handle it (save a replacement file) instead of showing raw "store: …" text.
 * This file must not import writer.ts (writer imports it).
 */

import { lockText } from "./new-version-rules"

export type StoreLockKind = "signed" | "replace_only" | "replaced" | "amended"

export class StoreLockedFileError extends Error {
  constructor(public readonly kind: StoreLockKind, public readonly fileName: string | null = null) {
    super(`store: locked file (${kind})`)
    this.name = "StoreLockedFileError"
  }
}

const KIND_FROM_DETAIL = /lock:(signed|replace_only|replaced|amended)/
const KIND_FROM_MESSAGE: Array<[RegExp, StoreLockKind]> = [
  [/signed document and cannot be changed in place/i, "signed"],
  [/passport or ID is never edited in place/i, "replace_only"],
  [/has been replaced by a newer file/i, "replaced"],
  [/amended return — a change must be confirmed/i, "amended"],
]

/** The lock kind of a database error (the trigger's DETAIL, or its message), or null when it is not a lock refusal. */
export function lockKindFromDbError(err: { message?: string | null; details?: string | null; code?: string | null } | null | undefined): StoreLockKind | null {
  if (!err) return null
  const d = KIND_FROM_DETAIL.exec(`${err.details ?? ""} ${err.message ?? ""}`)
  if (d) return d[1] as StoreLockKind
  for (const [re, kind] of KIND_FROM_MESSAGE) if (re.test(err.message ?? "")) return kind
  return null
}

function lockSentence(kind: string, name: string): string {
  if (kind === "amended") return `"${name}" is an amended return. A change to it has to be made on the Storage page with a written reason.`
  return lockText(kind, name)
}

/** Any refusal that means "this file takes no new version" (locked kinds, or a filed return). */
export function isLockRefusal(e: unknown): boolean {
  return e instanceof Error && (e.name === "StoreLockedFileError" || e.name === "StoreFrozenFileError")
}

/**
 * Plain English for staff for ANY error thrown by the store writers. A known refusal gets its own sentence; anything else
 * gets `fallback` (the raw text goes to the server log, never to the screen).
 */
export function plainStoreError(e: unknown, fallback = "The file could not be saved in the store. Please try again, and tell support if it keeps happening."): string {
  if (e instanceof Error) {
    if (e.name === "StoreLockedFileError") {
      const le = e as StoreLockedFileError
      return lockSentence(le.kind, le.fileName ?? "This file")
    }
    if (e.name === "StoreFrozenFileError") {
      return lockSentence("filed", (e as Error & { fileName?: string }).fileName ?? "This file")
    }
    // already written for people (personal document in a company folder)
    if (e.name === "PersonalDocumentMisfileError") return e.message
    const kind = lockKindFromDbError({ message: e.message })
    if (kind) return lockSentence(kind, "This file")
    // the store's own technical wording ("store: could not register the file — …", "store pilot: …") never reaches a screen
    if (/\bstore(?: pilot)?:/i.test(e.message)) {
      console.error("[crm-store] store error hidden from the screen:", e.message)
      return fallback
    }
    // every other message was written for people by our own code ("This company's files are being moved …")
    if (e.message.trim()) return e.message
  }
  return fallback
}
