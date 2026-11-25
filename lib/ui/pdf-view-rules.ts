/**
 * Showing a PDF in the CRM on a phone (Antonio, 2026-11-24: "I open a PDF from Storage on my iPhone in Chrome and I cannot scroll down").
 *
 * Proved on the iPhone simulator: every iPhone browser (Chrome included) uses Apple's engine, and that engine draws a PDF inside a frame as page 1 ONLY,
 * zoomed and cut off on the right — pages 2, 3 … can never be reached. The same file opened as a page of its own shows every page with the phone's own
 * viewer (page counter, fit to width, pinch to zoom). Android Chrome shows nothing inside a frame at all.
 * So: a computer keeps the frame exactly as before; a touch phone / tablet gets an "Open PDF" button that opens the file as its own page.
 */

/** A touch screen with no mouse: no hover and a coarse pointer. A computer (even a touch laptop whose main pointer is a mouse) does not match. */
export const PDF_PHONE_QUERY = '(hover: none) and (pointer: coarse)'

/** checking = the screen has not asked yet (nothing is drawn, so a phone never starts downloading the file into a frame it cannot show). */
export type PdfMode = 'checking' | 'frame' | 'open'

export function pdfModeFor(touchOnly: boolean | null): PdfMode {
  if (touchOnly === null) return 'checking'
  return touchOnly ? 'open' : 'frame'
}
