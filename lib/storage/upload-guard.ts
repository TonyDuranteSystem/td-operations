/**
 * Authorization guard for the generic signed-upload endpoint
 * (app/api/storage/upload).
 *
 * WHY THIS EXISTS (council review 2026-07-20, dev job 527b2377):
 * The route took `{ bucket, path }` straight from the request body and returned
 * a SERVICE-ROLE `createSignedUploadUrl` for whatever it was handed, with no
 * authorization of its own. Middleware only proves a session EXISTS — it does
 * not run a role check for `/api/*` paths (`isDashboardPath` returns false for
 * anything under /api), so a logged-in CLIENT portal user reached this route and
 * could obtain service-role write access to ANY bucket at ANY path: overwrite
 * another client's signed contract, write into the private worker-attachments
 * bucket, etc.
 *
 * Two layers close it: the route now requires a dashboard (staff) user, and this
 * guard pins the request to the exact bucket + path prefixes the five real
 * callers use. The prefix list matters even for staff — without it any staff
 * session could still overwrite an arbitrary client's staged flow upload by id.
 *
 * The five callers (verified 2026-07-20, all dashboard-only surfaces):
 *   components/flows/document-upload.tsx      -> flow-uploads/<sd>/...
 *   components/accounts/file-manager.tsx      -> crm-account-uploads/<account>/...
 *   components/accounts/account-detail.tsx    -> crm-dba-uploads/<account>/<detail>/...
 *   components/contacts/contact-detail.tsx    -> crm-uploads/<contact>/...
 *   components/contacts/chain-audit-dialog.tsx-> articles/<contact>/...
 *
 * Adding a caller = add its prefix here AND a case to the unit test. Do not
 * widen this to "any prefix" — the allow-list IS the control.
 */

/** The only bucket this endpoint may mint upload URLs for. */
export const ALLOWED_UPLOAD_BUCKETS = ["onboarding-uploads"] as const

/** Path prefixes the known dashboard callers stage files under. */
export const ALLOWED_UPLOAD_PREFIXES = [
  "flow-uploads/",
  "crm-account-uploads/",
  "crm-dba-uploads/",
  "crm-uploads/",
  "articles/",
] as const

/** Defensive cap — a storage key far longer than any real caller produces. */
export const MAX_UPLOAD_PATH_LENGTH = 512

/**
 * Deliberately a FLAT shape, not a discriminated union on an `ok` flag: this
 * repo compiles with `strict: false`, where narrowing a union by a boolean
 * literal discriminant does not work and every field access after the guard
 * fails to typecheck. Callers branch on `error` being non-null.
 */
export interface UploadGuardResult {
  /** Refusal message to return verbatim; null when the target is allowed. */
  error: string | null
  /** HTTP status for the refusal; null when allowed. */
  status: 400 | null
  /** Validated bucket — only meaningful when `error` is null. */
  bucket: string
  /** Validated path — only meaningful when `error` is null. */
  path: string
}

function refuse(error: string): UploadGuardResult {
  return { error, status: 400, bucket: "", path: "" }
}

/**
 * Validate an upload target. Pure — no I/O, no auth (the ROUTE owns the staff
 * check; this owns "where may a staff member write").
 *
 * Rejects, in order: non-string/empty inputs, a bucket outside the allow-list,
 * an over-long path, path traversal (`..`), absolute paths, backslashes and NUL
 * bytes, and finally any path outside the known caller prefixes.
 */
export function validateStorageUploadTarget(input: {
  bucket?: unknown
  path?: unknown
}): UploadGuardResult {
  const { bucket, path } = input ?? {}

  if (typeof bucket !== "string" || !bucket) return refuse("Missing bucket or path")
  if (typeof path !== "string" || !path) return refuse("Missing bucket or path")

  if (!(ALLOWED_UPLOAD_BUCKETS as readonly string[]).includes(bucket)) {
    return refuse("Bucket not allowed for this endpoint")
  }

  if (path.length > MAX_UPLOAD_PATH_LENGTH) return refuse("Upload path is too long")

  // Traversal / absolute / control characters. Checked BEFORE the prefix test so
  // a crafted "flow-uploads/../../secret" can never pass on prefix alone.
  if (
    path.includes("..") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return refuse("Invalid upload path")
  }

  if (!(ALLOWED_UPLOAD_PREFIXES as readonly string[]).some(p => path.startsWith(p))) {
    return refuse("Upload path is not an allowed destination")
  }

  return { error: null, status: null, bucket, path }
}
