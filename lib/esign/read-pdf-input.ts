/**
 * Read the PDF + JSON payload for the two staff routes that create something
 * from an uploaded PDF (POST /api/esign/envelopes, POST /api/esign/templates).
 *
 * TWO request shapes, one result:
 *  - JSON   { staging_path, file_name, payload }  — the normal path: the PDF was
 *    uploaded straight to storage (no size limit from the platform). The staged
 *    file is claimed and read here.
 *  - multipart  pdf + payload  — the original shape. Kept so (a) a browser tab
 *    left open across a deploy still works and (b) a small file can still be
 *    created if the direct upload is blocked on someone's network (the editor
 *    only falls back for files under ~4 MB, which the platform still accepts).
 *
 * `discard()` MUST be called on every exit once the caller is done with the
 * bytes — it removes the claimed staging object (a no-op for multipart).
 */

import type { NextRequest } from "next/server"
import { claimStagedPdf, discardStaged } from "@/lib/esign/staging"

// String discriminant `kind` (strict:false projects do not narrow on a boolean `ok`).
export type PdfInput =
  | {
      kind: "ready"
      ok: true
      bytes: Uint8Array
      fileName: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: any
      discard: () => Promise<void>
    }
  | { kind: "refused"; ok: false; status: number; error: string }

const noop = async () => {}

export async function readPdfInput(req: NextRequest, userId: string): Promise<PdfInput> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase()

  if (contentType.includes("application/json")) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any
    try {
      body = await req.json()
    } catch {
      return { kind: "refused", ok: false, status: 400, error: "Invalid request." }
    }
    const payload = body && typeof body.payload === "object" && body.payload ? body.payload : {}
    const claimed = await claimStagedPdf(body?.staging_path, userId)
    if (claimed.kind === "refused") return claimed
    return {
      kind: "ready",
      ok: true,
      bytes: claimed.bytes,
      fileName: typeof body.file_name === "string" && body.file_name ? body.file_name : "document.pdf",
      payload,
      discard: () => discardStaged(claimed.claimedPath),
    }
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return { kind: "refused", ok: false, status: 400, error: "Expected multipart form data." }
  }
  const file = form.get("pdf")
  if (!(file instanceof File)) return { kind: "refused", ok: false, status: 400, error: "A PDF file is required." }

  const payloadRaw = form.get("payload")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any
  try {
    payload = JSON.parse(typeof payloadRaw === "string" ? payloadRaw : "{}")
  } catch {
    return { kind: "refused", ok: false, status: 400, error: "Invalid payload JSON." }
  }
  return {
    kind: "ready",
    ok: true,
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || "document.pdf",
    payload,
    discard: noop,
  }
}
