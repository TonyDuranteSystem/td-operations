/**
 * Capture/Share feature — the ONE shared upload engine (Antonio, 2026-09-04:
 * "we must have only one working machinery"). Every destination this feature
 * ever gets (a sticky note, a team-chat thread, later a client chat) calls
 * this SAME function to get a picture into safe storage and logged — never a
 * separate upload path per destination.
 *
 * Mirrors lib/team/attachment.ts::uploadTeamAttachment's exact shape on
 * purpose: same two-step signed-URL flow, same shared network-retry primitive
 * (lib/chat/upload-with-retry.ts), same error philosophy (R099 — callers
 * surface err.message directly, never a generic toast). That file's own
 * header explains why: this retry logic used to be defined locally per
 * feature, which is exactly how the client-facing portal chat once ended up
 * with none of this protection at all. Captures reuse the shared primitive
 * from day one instead of repeating that mistake.
 */
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import { fetchWithNetworkRetry } from "@/lib/chat/upload-with-retry"

export interface CaptureRecord {
  id: string
  captured_by_user_id: string | null
  captured_by_name: string | null
  image_url: string
  image_name: string | null
  mime_type: string | null
  size_bytes: number | null
  title: string
  note: string | null
  destination: { type: string; id: string; label?: string } | null
  created_at: string
  updated_at: string
}

export interface UploadCaptureInput {
  /** The finished, flattened image (post mark-up/redaction) as a File. */
  file: File
  /** Auto-generated from context (page/client/time) — never from the image itself. */
  title: string
  /** The separate plain-text note field, apart from anything drawn on the image. */
  note?: string
}

/**
 * Best-effort telemetry for an upload that fails after retries — mirrors
 * lib/team/attachment.ts's reportTeamAttachmentError. This is the only way a
 * raw browser-level network error on the direct-to-Storage PUT becomes
 * visible to us at all; it happens entirely client-side.
 */
function reportCaptureError(payload: { route: string; message: string; file_name: string }) {
  try {
    void fetch("/api/system-errors/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: payload.route,
        message: payload.message,
        page_path: typeof window !== "undefined" ? window.location.pathname : undefined,
        context: { file_name: payload.file_name },
      }),
    }).catch(() => {})
  } catch {
    // ignore — reporting is best-effort
  }
}

/**
 * Upload one finished capture and log it. Returns the created row (its id is
 * what a later "Share to..." step PATCHes with a destination).
 * Throws Error(<user-friendly message>) on any failure (R099).
 */
export async function uploadCapture({ file, title, note }: UploadCaptureInput): Promise<CaptureRecord> {
  const validationError = validateChatAttachment(file.name, file.size, file.type)
  if (validationError) throw new Error(validationError)
  if (!title.trim()) throw new Error("A title is required.")

  let urlRes: Response
  try {
    urlRes = await fetchWithNetworkRetry("/api/captures/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: file.name, file_size: file.size, mime_type: file.type }),
    })
  } catch (err) {
    reportCaptureError({
      route: "captures:upload-url",
      message: err instanceof Error ? err.message : String(err),
      file_name: file.name,
    })
    throw new Error("Couldn't reach the server to start the upload. Check your connection and try again.")
  }
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || "Could not start the upload. Please try again.")
  }
  const { signedUrl, path } = await urlRes.json()
  if (!signedUrl || !path) {
    throw new Error("Could not start the upload. Please try again.")
  }

  let putRes: Response
  try {
    putRes = await fetchWithNetworkRetry(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    })
  } catch (err) {
    reportCaptureError({
      route: "captures:upload-put",
      message: err instanceof Error ? err.message : String(err),
      file_name: file.name,
    })
    throw new Error("Couldn't upload the picture — the connection was interrupted. Please try again.")
  }
  if (!putRes.ok) {
    if (putRes.status === 413) throw new Error("File too large.")
    throw new Error("Upload failed. Please check your connection and try again.")
  }

  let finalizeRes: Response
  try {
    finalizeRes = await fetchWithNetworkRetry("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        image_name: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
        title: title.trim(),
        note: note?.trim() || null,
      }),
    })
  } catch (err) {
    reportCaptureError({
      route: "captures:finalize",
      message: err instanceof Error ? err.message : String(err),
      file_name: file.name,
    })
    // The bytes are already safely in storage at this point — only the log
    // entry failed. Say so plainly rather than implying the picture is lost.
    throw new Error("The picture uploaded, but saving it failed. Please try again.")
  }
  if (!finalizeRes.ok) {
    const d = await finalizeRes.json().catch(() => ({}))
    throw new Error(d.error || "The picture uploaded, but saving it failed. Please try again.")
  }

  const { capture } = await finalizeRes.json()
  return capture as CaptureRecord
}
