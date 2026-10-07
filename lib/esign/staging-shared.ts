/**
 * Browser-safe rules for the E-Sign staging upload — pure, no server imports, so
 * the create screen can use the same path shape, size limit and wording as the
 * server. Server-only parts (claim / cleanup / sweep) live in lib/esign/staging.ts;
 * the full design notes are in that file's header.
 */

export const ESIGN_STAGING_BUCKET = "signature-requests"
export const ESIGN_STAGING_PREFIX = "esign-staging"
export const ESIGN_MAX_PDF_BYTES = 25 * 1024 * 1024 // 25 MB — the app's own rule (equals upload-guard DEFAULT_MAX_BYTES; a unit test pins that)
export const ESIGN_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const STAGING_PATH = new RegExp(`^${ESIGN_STAGING_PREFIX}/(${UUID})/(${UUID})\\.pdf$`, "i")
const CLAIMED_PATH = new RegExp(`^${ESIGN_STAGING_PREFIX}/(${UUID})/claimed-(${UUID})\\.pdf$`, "i")

/** The one shape the server ever mints. Pure. */
export function buildStagingPath(userId: string, objectId: string): string {
  return `${ESIGN_STAGING_PREFIX}/${userId.toLowerCase()}/${objectId.toLowerCase()}.pdf`
}

/**
 * Accept ONLY a path we minted for THIS user. Anchored, case-insensitive on the
 * hex, no decoding or normalising — the string is passed verbatim to storage,
 * so `..`, `%2e`, extra segments and other users' folders all fail here.
 */
export function isValidStagingPath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || !userId) return false
  const m = STAGING_PATH.exec(path)
  return !!m && m[1].toLowerCase() === userId.toLowerCase()
}

/** Where a staged object is moved to when a request claims it. Pure. */
export function claimedPathFor(stagingPath: string): string {
  const m = STAGING_PATH.exec(stagingPath)
  if (!m) throw new Error("claimedPathFor: not a staging path")
  return `${ESIGN_STAGING_PREFIX}/${m[1].toLowerCase()}/claimed-${m[2].toLowerCase()}.pdf`
}

/** True for a file we put in the staging prefix (unclaimed or claimed). Pure. */
export function isStagingObjectPath(path: string): boolean {
  return STAGING_PATH.test(path) || CLAIMED_PATH.test(path)
}

/**
 * The original filename only ever becomes the tail of a storage key and a
 * display name. Strip everything outside a safe set, never return an empty or
 * dots-only name, and force a .pdf extension. Pure.
 */
export function sanitizePdfFileName(name: unknown, fallback = "document"): string {
  const raw = typeof name === "string" ? name : ""
  const base = raw.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
  const safe = /[a-zA-Z0-9]/.test(base) ? base : fallback
  return `${safe}.pdf`
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** Plain-language refusal for a file over the app limit. Pure. */
export function tooLargeMessage(bytes: number, maxBytes: number = ESIGN_MAX_PDF_BYTES): string {
  return `That file is ${formatMegabytes(bytes)}; the limit is ${(maxBytes / 1048576).toFixed(0)} MB. Compress the PDF (for example "Reduce File Size" in Preview or Acrobat) and try again.`
}

/** True when a staged object is older than the sweep window. Pure. */
export function isStaleStagingObject(createdAtIso: string | null | undefined, nowMs: number, maxAgeMs: number = ESIGN_STAGING_MAX_AGE_MS): boolean {
  if (!createdAtIso) return true // no timestamp = cannot prove it is fresh; an orphan is safer gone
  const t = Date.parse(createdAtIso)
  if (!Number.isFinite(t)) return true
  return nowMs - t > maxAgeMs
}

