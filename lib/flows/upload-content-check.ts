/**
 * What a file uploaded on a flow step must at least BE before it is saved and counted (production end-to-end test 2026-11-10, finding F2:
 * a 0-byte "PDF" was accepted as the state's confirmation and satisfied the step's "needs a document" lock).
 *
 * Two plain refusals, both decided from the bytes alone:
 *   - an empty file (nothing inside);
 *   - a file that says it is a PDF (by name or by type) but whose first bytes are not a PDF header — a renamed text file, a half-finished
 *     download, a web page saved as ".pdf". The PDF format allows a few bytes of junk before "%PDF-", so the header is looked for in the first
 *     1024 bytes, as every PDF reader does.
 *
 * Anything else (pictures, Word files …) is only checked for being non-empty: this is a sanity check, not a file-type whitelist.
 * Pure — no I/O.
 */

const PDF_HEADER = "%PDF-"

/**
 * Does the file CLAIM to be a PDF? By its name; the type is only trusted when the name says nothing (no extension) — the upload screens invent
 * "application/pdf" when the browser does not know a file's type (a .heic from a PC, a .msg), and such a file never claimed to be a PDF.
 */
function looksLikePdf(fileName: string, mimeType: string | null | undefined): boolean {
  if (/\.pdf$/i.test(fileName)) return true
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(fileName)
  return !hasExtension && /pdf/i.test(String(mimeType ?? ""))
}

/** `null` when the file is acceptable, else the plain sentence for staff. */
export function uploadContentProblem(p: { fileName: string; mimeType?: string | null; bytes: Uint8Array | Buffer }): string | null {
  const name = p.fileName || "The file"
  if (!p.bytes || p.bytes.length === 0) return `"${name}" is empty (0 bytes), so nothing was saved. Open the file to check it, then upload it again.`
  if (looksLikePdf(p.fileName, p.mimeType)) {
    const head = Buffer.from(p.bytes.subarray(0, 1024)).toString("latin1")
    if (!head.includes(PDF_HEADER)) return `"${name}" is not a real PDF file (it has no PDF content inside), so nothing was saved. Open the file to check it, then upload it again.`
  }
  return null
}
