/**
 * Small PURE rules the storage screen needs (kept out of the big browser component so they can be tested):
 * the "same name?" key (the same one the server uses), error wording, the eye's rules, file sizes, retry of failed
 * drop items, and which picked paths are hidden folders.
 */
import { storeNameKey } from '@/lib/crm-store/rules'
import { isHeicByNameOrType, jpegNameFor } from '@/lib/image-heic'

/** A server answer that was not OK — keeps the status so the screen can tell "gone" from "could not reach". */
export class HttpError extends Error {
  status: number
  /** The server's whole JSON answer when it sent one (a refusal can carry a `code` and the `hits` it refused for). */
  data?: unknown
  constructor(message: string, status: number, data?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.data = data
  }
}

/**
 * The key two file names are compared by on the screen — the SAME as the server's: an iPhone photo (HEIC/HEIF) is saved as
 * a JPEG ("IMG_1.HEIC" → "IMG_1.jpg"), then trim + Unicode NFC + lowercase (lib/crm-store/rules.ts storeNameKey).
 */
export function sameNameKey(name: string, mimeType?: string | null): string {
  const saved = isHeicByNameOrType(name, mimeType) ? jpegNameFor(name) : name
  return storeNameKey(saved)
}

const NETWORK_TEXT = /^(failed to fetch|load failed|networkerror when attempting to fetch|network request failed|the network connection was lost|the internet connection appears to be offline)/i

/** True for a fetch that never reached the server (offline, dropped connection, blocked) — browsers word it differently. */
export function isNetworkFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e instanceof HttpError) return false
  return NETWORK_TEXT.test(e.message.trim())
}

export const NETWORK_MESSAGE = 'Network problem — check your connection and try again.'

/** The words shown to the person: the server's own message when there is one, a plain network sentence for a dropped connection, else the fallback. */
export function errorText(e: unknown, fallback: string): string {
  if (isNetworkFailure(e)) return NETWORK_MESSAGE
  return e instanceof Error && e.message ? e.message : fallback
}

/** The server says this folder / storage no longer exists (404, or "not found" in its words) — NOT a connection blip or a 5xx. */
export function isGoneError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false
  return e.status === 404 || /not found/i.test(e.message)
}

/** "0 KB" for an empty file (it used to read "1 KB"), a whole number of KB under 1 MB, then MB with one decimal. */
export function fmtSize(n: number | null): string {
  if (n == null) return ''
  if (n <= 0) return '0 KB'
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export interface ShowRuleFile {
  staffOnly: boolean; state: string; listed: boolean; clientVisible: boolean; filingStatus?: string | null
  documentType: string | null; personal: boolean; inPersonStorage: boolean; needsReview?: string | null
}

/**
 * Can the eye on this row show it to the client? (A file already shown can always be hidden again.) A "Needs review" file can't
 * be shown until it is marked reviewed — the server refuses it too, so the eye must not offer it.
 */
export function canShowToClient(f: ShowRuleFile): boolean {
  return !f.staffOnly && f.state === 'live' && (f.listed || f.clientVisible) && f.filingStatus !== 'draft'
    && (f.clientVisible || (!f.needsReview && !!f.documentType && !(f.personal && !f.inPersonStorage)))
}

/** Why the eye is locked (shown in its tooltip). */
export function cantShowReason(f: ShowRuleFile, internal: boolean): string {
  return f.filingStatus === 'draft' ? 'A draft return — never shown to the client until it is marked filed (menu → Mark filed)'
    : f.staffOnly ? "Staff only — it holds other people's personal data and is never shown to a client"
      : internal ? 'Internal folders — never shown to a client'
        : !f.listed ? 'Not linked to the CRM list — the client cannot see it'
          : f.needsReview ? 'It needs review first — use menu → Mark reviewed, then it can be shown'
            : !f.documentType ? 'It needs a document type before it can be shown'
              : "A person's document can only be shown from their own storage"
}

/** Failed items go back to "waiting" so one more Upload press tries them again (saved / skipped ones are left alone). */
export function resetFailedToWaiting<T extends { status: string }>(items: T[]): T[] {
  return items.map((x) => (x.status === 'failed' ? { ...x, status: 'waiting' } : x))
}

/** A path from a folder picker ("proj/.git/config", ".DS_Store") that passes through a hidden (dot) file or folder — never uploaded. */
export function hasHiddenPart(relativeOrName: string): boolean {
  return relativeOrName.split('/').some((p) => p.startsWith('.'))
}

/** What makes an AI mark go stale: the file's current copy and type. A new version, a retype or a restore changes it. */
export function markFingerprint(f: { updatedAt?: string | null; versionNo?: number | null; documentType?: string | null; sha256?: string | null }): string {
  return [f.updatedAt ?? '', f.versionNo ?? '', f.documentType ?? '', f.sha256 ?? ''].join('|')
}

/** Ids whose mark must be (re)asked: never asked before, or whose fingerprint changed since they were. */
export function idsNeedingMark(ids: string[], fingerprints: Record<string, string>, askedFp: Map<string, string>): string[] {
  return Array.from(new Set(ids)).filter((id) => !askedFp.has(id) || askedFp.get(id) !== (fingerprints[id] ?? ''))
}

/** Ids from `ids` that have no mark yet — the marks of the files already known are not requested again. */
export function idsStillToMark(ids: string[], known: Record<string, unknown>, asked: Set<string>): string[] {
  return Array.from(new Set(ids)).filter((id) => !(id in known) && !asked.has(id))
}
