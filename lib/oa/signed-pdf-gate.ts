/**
 * May this agreement's EXECUTED PDF be handed out, and which object is it?
 *
 * Pure decision for `GET /api/operating-agreement/[token]/signed-pdf`. The access
 * code / signer-link checks happen BEFORE this (so none of the answers below can
 * be used to probe which agreements exist); this only judges the agreement itself.
 *
 * WHY A SERVER ROUTE AT ALL: the signing page used to download the signed PDF
 * straight from the `signed-oa` bucket with the anonymous browser client. Since
 * the 2026-07-22 lockdown the bucket answers "Object not found" to an anonymous
 * read, so the button only worked in the browser session that had just signed, and
 * it then showed the stale "ready once all members sign" message — to people whose
 * agreement WAS fully signed. The route reads with the service key instead.
 *
 * FLAT result on purpose (the repo compiles with `strict: false`, which does not
 * narrow a discriminated union on a boolean).
 */
import { resolveSignedPdfPath } from "@/lib/oa/signed-pdf-path"

export interface SignedPdfGateResult {
  ok: boolean
  /** Storage path inside the `signed-oa` bucket — only when ok. */
  path: string | null
  /** HTTP status to answer with — only when not ok. */
  status: number
  /** Client-safe sentence — only when not ok. */
  error: string | null
}

export function signedPdfGate(agreement: {
  token: string
  status: string | null
  pdf_storage_path: string | null
}): SignedPdfGateResult {
  if (agreement.status === "voided") {
    return {
      ok: false, path: null, status: 410,
      error: "This Operating Agreement has been voided and is no longer valid. Please contact support@tonydurante.us.",
    }
  }
  if (agreement.status !== "signed") {
    return {
      ok: false, path: null, status: 409,
      error: "The signed copy is not ready yet. It becomes available once every member has signed and the document is finalized. If you have already signed, please try again in a minute, or contact support@tonydurante.us.",
    }
  }
  const target = resolveSignedPdfPath(agreement.token, agreement.pdf_storage_path)
  if (!target.ok || !target.path) {
    return {
      ok: false, path: null, status: 404,
      error: "This agreement is signed, but its signed copy could not be found. Please contact support@tonydurante.us and we will send it to you.",
    }
  }
  return { ok: true, path: target.path, status: 200, error: null }
}
