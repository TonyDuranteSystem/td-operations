/**
 * Scan document: the pages become ONE PDF, made on the phone. pdf-lib is loaded only when the person taps
 * "Attach PDF", so nothing extra downloads for anyone who never scans.
 */

export interface PdfPageInput { jpeg: Uint8Array; /** pixel size of the picture */ width: number; height: number }

/** A4's long side in points; the page keeps the picture's own shape (no white margins, no stretching). */
const LONG_SIDE_PT = 841.89

export function pdfPageSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, width); const h = Math.max(1, height)
  const k = LONG_SIDE_PT / Math.max(w, h)
  return { width: Math.round(w * k * 100) / 100, height: Math.round(h * k * 100) / 100 }
}

export async function buildPdf(pages: ReadonlyArray<PdfPageInput>): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('A scan needs at least one page.')
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (const p of pages) {
    const image = await doc.embedJpg(p.jpeg)
    const size = pdfPageSize(p.width, p.height)
    const page = doc.addPage([size.width, size.height])
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height })
  }
  return doc.save()
}
