/**
 * Browser side of the E-Sign direct upload (server side: lib/esign/staging.ts).
 *
 *   uploadPdfToStaging(file) → { stagingPath }   (throws EsignUploadError)
 *
 * Asks /api/esign/upload-url for a one-time link, PUTs the PDF straight to
 * storage (so the platform's 4.5 MB request-body cap never applies), and hands
 * back the path for the create route. Every failure becomes a plain-language
 * message (R099) and is reported to the system error log — the old failure left
 * no trace anywhere because the platform answered before our code ran.
 *
 * `fetchWithNetworkRetry` is the same retry the team-chat uploads use, but its
 * default 6 s per-attempt deadline would abort a 20 MB PUT on an ordinary
 * connection every single time, so the deadline here scales with file size.
 */

import { fetchWithNetworkRetry } from "@/lib/chat/upload-with-retry"
import { ESIGN_MAX_PDF_BYTES, tooLargeMessage } from "@/lib/esign/staging-shared"

/** Files at or under this size can still use the original multipart request
 * (the platform accepts <4.5 MB) if the direct upload is blocked on someone's
 * network. Above it there is no fallback: the platform would refuse it. */
export const MULTIPART_FALLBACK_MAX_BYTES = 4 * 1024 * 1024

export class EsignUploadError extends Error {
  /** True when the failure was the connection itself (not an answer from the server). */
  networkFailure: boolean
  constructor(message: string, networkFailure = false) {
    super(message)
    this.name = "EsignUploadError"
    this.networkFailure = networkFailure
  }
}

/** Per-attempt deadline for the PUT: at least 30 s, and enough for ~50 KB/s, capped at 5 min. Pure. */
export function putAttemptTimeoutMs(bytes: number): number {
  return Math.min(5 * 60_000, Math.max(30_000, Math.ceil(bytes / (50 * 1024)) * 1000))
}

/**
 * The message staff see when the create/template request itself failed. Prefers
 * the server's own sentence; a plain-text platform answer (no JSON) gets a
 * message that names the real problem instead of "Could not create the envelope."
 * Pure.
 */
export function describeCreateFailure(status: number, serverError: unknown, what = "create the envelope"): string {
  if (typeof serverError === "string" && serverError.trim()) return serverError
  if (status === 413) {
    return `That file is too large to send in one step. Compress the PDF (for example "Reduce File Size" in Preview or Acrobat) and try again.`
  }
  return `Could not ${what} (the server answered ${status || "with no reply"}). Please try again; if it keeps happening, tell the dev team.`
}

function reportEsignUploadError(route: string, message: string, fileName: string, fileSize: number) {
  try {
    void fetch("/api/system-errors/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route,
        message,
        page_path: typeof window !== "undefined" ? window.location.pathname : undefined,
        context: { file_name: fileName, file_size: fileSize },
      }),
    }).catch(() => {})
  } catch {
    // best-effort telemetry only
  }
}

export async function uploadPdfToStaging(file: File): Promise<{ stagingPath: string }> {
  if (file.size > ESIGN_MAX_PDF_BYTES) throw new EsignUploadError(tooLargeMessage(file.size))
  if (file.size <= 0) throw new EsignUploadError("The file is empty.")

  // 1) One-time upload link (small JSON request — always under the platform cap).
  let urlRes: Response
  try {
    urlRes = await fetchWithNetworkRetry("/api/esign/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_size: file.size }),
    })
  } catch (err) {
    reportEsignUploadError("esign:upload-url", err instanceof Error ? err.message : String(err), file.name, file.size)
    throw new EsignUploadError("Couldn't reach the server to start the upload. Check your connection and try again.", true)
  }
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new EsignUploadError(describeCreateFailure(urlRes.status, d?.error, "start the upload"))
  }
  const { signedUrl, path } = await urlRes.json().catch(() => ({}))
  if (!signedUrl || !path) throw new EsignUploadError("Could not start the upload. Please try again.")

  // 2) Straight to storage.
  let putRes: Response
  try {
    putRes = await fetchWithNetworkRetry(
      signedUrl,
      { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file },
      { attempts: 3, attemptTimeoutMs: putAttemptTimeoutMs(file.size) },
    )
  } catch (err) {
    reportEsignUploadError("esign:upload-put", err instanceof Error ? err.message : String(err), file.name, file.size)
    throw new EsignUploadError("Couldn't upload the file — the connection was interrupted. Please try again.", true)
  }
  if (!putRes.ok) {
    reportEsignUploadError("esign:upload-put", `storage answered ${putRes.status}`, file.name, file.size)
    if (putRes.status === 413) throw new EsignUploadError(tooLargeMessage(file.size))
    throw new EsignUploadError(`The upload was refused (storage answered ${putRes.status}). Please try again.`)
  }
  return { stagingPath: path }
}
