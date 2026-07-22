/**
 * Which stored object is THE signed operating agreement.
 *
 * ⛔ WHY THIS EXISTS — read before changing it.
 *
 * The publish step (`app/api/oa-signed/route.ts`) used to answer that question
 * by listing the agreement's storage folder, taking the NEWEST object, and
 * filing whatever it found to Google Drive and the client portal. It never
 * consulted `pdf_storage_path`, the column the signing page had just written.
 *
 * The storage bucket's only policy is INSERT for role `public` — i.e. anyone can
 * upload into it with no credential at all (verified against production
 * 2026-07-22: an anonymous upload returned 200). Tokens are `<company-slug>-oa-
 * <year>`, derivable from a company name that is public in state registries. So
 * "newest object wins" meant: drop a PDF into a guessed folder, poke the
 * unauthenticated publish route, and TD files YOUR document to the client's
 * Drive (upsert, so it overwrites the real one) and publishes it to their portal
 * as the executed agreement. No login, no access code, no database access.
 *
 * The fix is to file the object the SERVER recorded, and to fail closed rather
 * than guess. Two rules, both load-bearing:
 *
 *   1. USE THE RECORDED PATH. No listing, no "newest", no fallback. If the row
 *      has no path, nothing is filed — a missing document is a visible problem;
 *      the wrong document is an invisible one.
 *   2. THE PATH MUST BELONG TO THIS AGREEMENT. `pdf_storage_path` is still
 *      writable by the browser (that is a later step of this job), so the value
 *      itself is not yet trustworthy. Confining it to the agreement's own folder
 *      stops a poisoned value from pointing at another client's document.
 *
 * WHAT THIS DOES NOT CLOSE, so nobody mistakes it for the whole fix: someone who
 * guesses a token can still upload into that agreement's own folder and point
 * the row at it. Closing that needs the bucket locked to the service key and the
 * browser's write access removed — the later steps. This step removes the
 * variant that needs NO credentials and can hit any agreement.
 *
 * Pure function, no I/O, so the rules are unit-testable without storage.
 */

/**
 * FLAT shape on purpose. The repo compiles with `strict: false`, under which
 * TypeScript does NOT narrow a discriminated union on a boolean `ok` — so
 * `if (r.ok) { r.path }` fails to compile. Both fields are always present;
 * `reason` is null when `ok` is true.
 */
export type SignedPdfPathReason = "missing" | "outside_agreement" | "not_pdf"
export type SignedPdfPathResult = {
  ok: boolean
  path: string | null
  reason: SignedPdfPathReason | null
}

/**
 * Resolve the object to file for an agreement, or refuse.
 *
 * @param token         the agreement's token — also its folder name in the bucket
 * @param recordedPath  `oa_agreements.pdf_storage_path` as stored
 */
export function resolveSignedPdfPath(
  token: string | null | undefined,
  recordedPath: string | null | undefined,
): SignedPdfPathResult {
  const path = (recordedPath ?? "").trim()
  const folder = (token ?? "").trim()

  // Nothing recorded, or no token to scope it to → refuse. Never fall back to
  // scanning the folder: that fallback IS the vulnerability.
  if (!path || !folder) return { ok: false, path: null, reason: "missing" }

  // Must sit directly inside this agreement's own folder. Rejects absolute
  // paths, another agreement's folder, traversal, and nested subfolders (the
  // signing page never creates one, so a nested path is already anomalous).
  const prefix = `${folder}/`
  if (!path.startsWith(prefix)) return { ok: false, path: null, reason: "outside_agreement" }
  const rest = path.slice(prefix.length)
  if (!rest || rest.includes("/") || rest.includes("..")) {
    return { ok: false, path: null, reason: "outside_agreement" }
  }

  // The signed agreement is a PDF. A signature image or anything else pointed at
  // by a poisoned value must not be filed to Drive as the executed agreement.
  if (!rest.toLowerCase().endsWith(".pdf")) return { ok: false, path: null, reason: "not_pdf" }

  return { ok: true, path, reason: null }
}

/** Operator-facing explanation for the publish result log. Never shown to a client. */
export function signedPdfPathProblem(reason: SignedPdfPathReason | null): string {
  switch (reason) {
    case "missing":
      return "No signed PDF recorded on the agreement — nothing filed. The signing step did not store a document path."
    case "outside_agreement":
      return "Recorded PDF path does not belong to this agreement's folder — refusing to file it."
    case "not_pdf":
      return "Recorded PDF path is not a PDF — refusing to file it."
    default:
      return "Signed PDF path could not be resolved — nothing filed."
  }
}
