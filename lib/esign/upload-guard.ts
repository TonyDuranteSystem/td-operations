/**
 * E-Sign upload guard — first line of the malicious-upload defense.
 *
 * Validates that an uploaded file is genuinely a PDF (by magic bytes, not just a
 * .pdf extension), within size + page limits, and readable. A client-uploaded
 * document is later served + emailed to third parties, so this gate runs before
 * a file ever becomes signable/sendable.
 *
 * AV scanning (ClamAV / scan API) is a separate seam (`scanForMalware`) wired
 * before CLIENTS can upload (Phase 5 per the plan); TD-first uploads are TD's
 * own trusted PDFs.
 */

import { PDFDocument } from "pdf-lib"

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 // 25 MB
export const DEFAULT_MAX_PAGES = 50

export interface UploadValidation {
  ok: boolean
  error?: string
  pageCount?: number
}

/** A real PDF starts with the bytes "%PDF-" — an extension/MIME header can lie. Pure. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  )
}

export async function validatePdfUpload(
  bytes: Uint8Array,
  opts: { maxBytes?: number; maxPages?: number } = {},
): Promise<UploadValidation> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES

  if (!bytes || bytes.length === 0) return { ok: false, error: "The file is empty." }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      error: `That file is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB.`,
    }
  }
  if (!hasPdfMagic(bytes)) {
    return { ok: false, error: "That file is not a valid PDF (it failed the file-signature check)." }
  }

  let pageCount: number
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    pageCount = pdf.getPageCount()
  } catch {
    return { ok: false, error: "The PDF could not be read — it may be corrupted or password-protected." }
  }

  if (pageCount < 1) return { ok: false, error: "The PDF has no pages." }
  if (pageCount > maxPages) {
    return { ok: false, error: `The PDF has ${pageCount} pages; the limit is ${maxPages}.` }
  }

  return { ok: true, pageCount }
}

/**
 * Malware scan seam. Returns clean by default. The real provider (ClamAV / scan
 * API) is wired before clients can upload (Phase 5); on a hit it must quarantine
 * the file and block the envelope from becoming signable/sendable.
 */
export async function scanForMalware(_bytes: Uint8Array): Promise<{ clean: boolean; detail?: string }> {
  // TODO(phase-5): call the configured AV provider; quarantine + block on hit.
  return { clean: true }
}
