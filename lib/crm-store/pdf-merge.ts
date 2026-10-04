/**
 * CRM Store — merge PDFs into ONE document (plan-driven build, job 685467b5).
 *
 * Antonio's rule: an e-signature certificate is added to the document it belongs to and saved as ONE complete
 * document. The merge must be DETERMINISTIC (the same inputs always give the same bytes), otherwise every retry of
 * a build would save a new version of every merged file — pdf-lib stamps the current time into the file unless it
 * is told not to. The originals on Google Drive are never touched.
 */

import { PDFDocument } from "pdf-lib"

export class PdfMergeError extends Error {
  constructor(message: string) { super(message); this.name = "PdfMergeError" }
}

/** Fixed value written into the file's dates so the same parts always produce the same bytes. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1))
const PRODUCER = "TD Operations"

export function looksLikePdf(bytes: Buffer): boolean {
  // the header may be preceded by a few junk bytes in real files, but never more than 1 KB
  return bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")
}

/** An encrypted PDF names /Encrypt in its trailer (near the end of the file, or in the cross-reference stream). */
export function looksEncrypted(bytes: Buffer): boolean {
  return bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1").includes("/Encrypt")
    || bytes.subarray(0, 4096).toString("latin1").includes("/Encrypt")
}

export interface MergedPdf { bytes: Buffer; pageCounts: number[] }

/** Append every part after the first, in the order given. A part that cannot be read fails the whole merge. */
export async function mergePdfs(parts: Buffer[]): Promise<MergedPdf> {
  if (parts.length < 2) throw new PdfMergeError("A merge needs a document and at least one certificate.")
  const out = await PDFDocument.create({ updateMetadata: false })
  const pageCounts: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const label = i === 0 ? "the document" : `certificate ${i}`
    if (!looksLikePdf(parts[i])) throw new PdfMergeError(`${label} is not a PDF.`)
    // a locked PDF is refused outright (never "ignored": its pages would copy over blank)
    if (looksEncrypted(parts[i])) throw new PdfMergeError(`${label} is locked (encrypted) — it cannot be merged.`)
    let n: number
    try {
      const src = await PDFDocument.load(parts[i], { updateMetadata: false })
      n = src.getPageCount()
      if (n === 0) throw new PdfMergeError(`${label} has no pages.`)
      const pages = await out.copyPages(src, src.getPageIndices())
      for (const p of pages) out.addPage(p)
    } catch (e) {
      if (e instanceof PdfMergeError) throw e
      throw new PdfMergeError(`${label} cannot be opened — it may be locked or damaged (${e instanceof Error ? e.message : String(e)}).`)
    }
    pageCounts.push(n)
  }
  const expected = pageCounts.reduce((a, b) => a + b, 0)
  if (out.getPageCount() !== expected) throw new PdfMergeError(`The merged file has ${out.getPageCount()} pages, expected ${expected}.`)
  out.setCreationDate(FIXED_DATE)
  out.setModificationDate(FIXED_DATE)
  out.setProducer(PRODUCER)
  out.setCreator(PRODUCER)
  const bytes = Buffer.from(await out.save({ useObjectStreams: false, addDefaultPage: false }))
  return { bytes, pageCounts }
}
