/**
 * Free-form document → PDF.
 *
 * The gap this closes (Luca, 2026-07-10): he asked the worker for the IRS
 * name-change letter "as a PDF", got plain text plus an offer to download something
 * that did not exist, and had to reformat it himself. Every other PDF in this codebase
 * fills a known template — a W-7, an invoice, a lease. There was nothing that could
 * take arbitrary text and produce a printable page.
 *
 * Deliberately plain: a letterhead line, an optional date and reference block, then the
 * body. Good enough to print and post to the IRS, which is the actual job. It is NOT a
 * layout engine — no tables, columns or images. Anything needing those wants a real
 * template, and a template is a better answer than a half-built renderer.
 *
 * Formatting understood in the body, chosen because it is what a model writes anyway:
 *   · a blank line starts a new paragraph
 *   · a line of "## text" or "**text**" alone becomes a bold heading
 *   · a line starting "- " or "• " becomes a bullet
 * Everything else is a normal wrapped line. Unrecognised markdown is printed literally
 * rather than silently swallowed — a stray asterisk in a letter is a smaller problem
 * than a sentence that vanished.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { embedUnicodeFonts } from '@/lib/pdf/unicode-fonts'
import { wrapPdfText } from '@/lib/pdf/wrap-text'

/** US Letter, the format these documents are printed and posted on. */
const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 64
const CONTENT_W = PAGE_W - MARGIN * 2

const BODY_SIZE = 11
const HEADING_SIZE = 13
const LINE_GAP = 1.45
const PARA_GAP = 8

export interface LetterOptions {
  /** Bold line at the top of page one. Omit for a bare document. */
  title?: string | null
  /** Body text. Blank lines separate paragraphs. */
  body: string
  /** Right-aligned under the title, e.g. a date. */
  dateLine?: string | null
  /** Small grey lines under the title, e.g. "Re: EIN 12-3456789". */
  reference?: string[] | null
  /**
   * Sender block at the very top.
   *
   * OMIT for the firm's default. Pass `''` OR `null` for a bare document — both mean
   * "no letterhead". Previously only `''` worked and `null` silently restored the
   * default, so a caller saying "no header" in the more obvious of the two ways got a
   * header. Only one caller exists (the pdf_create tool), so the meaning of `null` is
   * safe to pin here rather than at each call site.
   */
  letterhead?: string | null
}

const DEFAULT_LETTERHEAD = 'Tony Durante LLC'

interface Cursor {
  page: PDFPage
  y: number
}

/** Start a fresh page when the next line would run past the bottom margin. */
function ensureRoom(pdf: PDFDocument, cur: Cursor, needed: number): void {
  if (cur.y - needed >= MARGIN) return
  cur.page = pdf.addPage([PAGE_W, PAGE_H])
  cur.y = PAGE_H - MARGIN
}

function drawWrapped(
  pdf: PDFDocument,
  cur: Cursor,
  text: string,
  font: PDFFont,
  size: number,
  opts: { indent?: number; color?: ReturnType<typeof rgb> } = {},
): void {
  const indent = opts.indent ?? 0
  const lines = wrapPdfText(text, font, size, CONTENT_W - indent)
  const lineHeight = size * LINE_GAP
  for (const line of lines) {
    ensureRoom(pdf, cur, lineHeight)
    cur.page.drawText(line, {
      x: MARGIN + indent,
      y: cur.y - size,
      size,
      font,
      color: opts.color ?? rgb(0, 0, 0),
    })
    cur.y -= lineHeight
  }
}

/** Strip the markers we understand, so they never print as literal characters. */
function stripHeading(line: string): string | null {
  const t = line.trim()
  const hash = t.match(/^#{1,4}\s+(.+)$/)
  if (hash) return hash[1].trim()
  const bold = t.match(/^\*\*(.+)\*\*$/)
  if (bold) return bold[1].trim()
  return null
}

function stripBullet(line: string): string | null {
  const t = line.trim()
  const m = t.match(/^[-•*]\s+(.+)$/)
  return m ? m[1].trim() : null
}

/** Remove inline bold markers — the text is drawn in one weight per line. */
function stripInline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1')
}

/**
 * Render a document and return the PDF bytes.
 *
 * Never throws on odd input: an empty body still produces a valid one-page file, so a
 * caller can always hand the staff member something rather than an error.
 */
export async function renderLetterPdf(opts: LetterOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const { regular, bold } = await embedUnicodeFonts(pdf)

  const cur: Cursor = { page: pdf.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN }

  // `undefined` (key absent) means "use the firm's default"; an explicit `''` or
  // `null` both mean "no letterhead". `??` alone would fold null into the default.
  const letterhead = (opts.letterhead === undefined ? DEFAULT_LETTERHEAD : (opts.letterhead ?? '')).trim()
  if (letterhead) {
    drawWrapped(pdf, cur, letterhead, bold, HEADING_SIZE)
    cur.y -= PARA_GAP
  }

  if (opts.dateLine?.trim()) {
    drawWrapped(pdf, cur, opts.dateLine.trim(), regular, BODY_SIZE, {
      color: rgb(0.35, 0.35, 0.35),
    })
    cur.y -= PARA_GAP / 2
  }

  if (opts.title?.trim()) {
    cur.y -= PARA_GAP / 2
    drawWrapped(pdf, cur, stripInline(opts.title.trim()), bold, HEADING_SIZE)
    cur.y -= PARA_GAP / 2
  }

  for (const ref of opts.reference ?? []) {
    if (ref?.trim()) {
      drawWrapped(pdf, cur, stripInline(ref.trim()), regular, BODY_SIZE, {
        color: rgb(0.35, 0.35, 0.35),
      })
    }
  }
  if (opts.reference?.length) cur.y -= PARA_GAP

  cur.y -= PARA_GAP

  // Normalise line endings so a body written on any platform paragraphs the same way.
  const lines = (opts.body ?? '').replace(/\r\n?/g, '\n').split('\n')
  for (const raw of lines) {
    if (!raw.trim()) {
      cur.y -= PARA_GAP
      continue
    }
    const heading = stripHeading(raw)
    if (heading) {
      cur.y -= PARA_GAP / 2
      drawWrapped(pdf, cur, stripInline(heading), bold, HEADING_SIZE)
      continue
    }
    const bullet = stripBullet(raw)
    if (bullet) {
      // Bullet glyph drawn separately so wrapped lines align under the text, not
      // under the dot.
      ensureRoom(pdf, cur, BODY_SIZE * LINE_GAP)
      cur.page.drawText('•', { x: MARGIN, y: cur.y - BODY_SIZE, size: BODY_SIZE, font: regular })
      drawWrapped(pdf, cur, stripInline(bullet), regular, BODY_SIZE, { indent: 14 })
      continue
    }
    drawWrapped(pdf, cur, stripInline(raw.trim()), regular, BODY_SIZE)
  }

  return pdf.save()
}
