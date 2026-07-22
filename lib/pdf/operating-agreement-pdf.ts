/**
 * Operating Agreement PDF — rendered on the SERVER.
 *
 * ⛔ WHY THIS EXISTS.
 *
 * Until now the executed operating agreement was produced by the CLIENT's
 * browser: the page rendered the agreement as HTML and html2pdf screenshotted it,
 * then the browser uploaded the result and TD filed that file to Drive and the
 * client portal as the executed instrument.
 *
 * That is indefensible for a document TD files. The server can check who is
 * asking, but it cannot check WHAT IS IN a file the counterparty produced — there
 * was no server-side representation of the document to compare against. Nothing
 * stopped a signer POSTing a different agreement. Both the architect and the
 * security reviewer reached the same conclusion independently: the only sound
 * control is for the server to render the document itself. This is that renderer.
 *
 * Two further defects it removes on the way:
 *   - html2canvas produces a RASTER image, so every executed agreement was a
 *     picture of text: not selectable, not searchable, weaker as evidence. This
 *     produces real text.
 *   - The browser stamped TODAY's date on every member's signature block, so a
 *     member who signed weeks earlier was dated as of the last signer's day —
 *     while the caption beside it showed their true date. The document
 *     contradicted itself. Here each member is dated by their OWN signing date.
 *
 * CONTENT PARITY IS THE HARD REQUIREMENT. The clauses come from the same
 * `generateOASections()` the browser used, so only the painting changes, never
 * the terms. `tests/unit/operating-agreement-pdf.test.ts` extracts the text back
 * out of the produced PDF and asserts every section title and body survives —
 * because the near-miss on this subsystem was exactly a field that the pages
 * didn't read but the template printed (member addresses), and eyeballing would
 * not have caught it.
 *
 * Layout is ported from `lib/pdf/intercompany-agreement-pdf.ts`, the renderer TD
 * already files comparable multi-party legal documents with.
 */

import { PDFDocument, rgb, PDFFont } from "pdf-lib"
import { embedUnicodeFonts } from "./unicode-fonts"
import { generateOASections, type OAData, type OAMember } from "@/lib/types/oa-templates"

export interface OASignatureBlock {
  /** Position in the members array — matches oa_signatures.member_index. */
  memberIndex: number
  /** ISO timestamp this member signed, or null if they have not. */
  signedAt: string | null
  /** PNG bytes of the drawn signature, or null if unavailable. */
  signaturePng: Uint8Array | null
}

export interface OperatingAgreementPdfInput {
  data: OAData
  /** One entry per member for a multi-member agreement; empty for single-member. */
  signatures?: OASignatureBlock[]
  /** Single-member agreements carry one signature and no member blocks. */
  soleSignaturePng?: Uint8Array | null
  soleSignedAt?: string | null
}

const PAGE_WIDTH = 595.28 // A4 — same as the intercompany agreement
const PAGE_HEIGHT = 841.89
const MARGIN = 50
const LINE_HEIGHT = 14
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const SIGNATURE_HEIGHT = 46
const SIGNATURE_MAX_WIDTH = 200

/**
 * Format a stored `YYYY-MM-DD` without a timezone shift.
 *
 * `new Date("2026-01-10")` parses as UTC midnight and renders as the PREVIOUS day
 * west of Greenwich — which would silently move an agreement's effective date.
 * The browser page avoided this by splitting the parts; so does this.
 */
export function formatAgreementDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const parts = String(dateStr).slice(0, 10).split("-").map(Number)
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return String(dateStr)
  const [year, month, day] = parts
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/** Format a signing timestamp (a full ISO instant, not a date-only string). */
export function formatSignedDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

export async function generateOperatingAgreementPDF(
  input: OperatingAgreementPdfInput,
): Promise<Uint8Array> {
  const { data } = input
  const doc = await PDFDocument.create()
  const { regular: font, bold, oblique } = await embedUnicodeFonts(doc, { oblique: true })
  const italic = (oblique as PDFFont) ?? font

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
  }
  const check = (needed: number) => {
    if (y - needed < MARGIN + 30) newPage()
  }

  function wrap(text: string, maxW: number, size: number, f: PDFFont): string[] {
    const lines: string[] = []
    for (const rawLine of String(text).split("\n")) {
      if (!rawLine.trim()) {
        lines.push("")
        continue
      }
      let line = ""
      for (const w of rawLine.split(" ")) {
        const test = line ? `${line} ${w}` : w
        if (f.widthOfTextAtSize(test, size) > maxW && line) {
          lines.push(line)
          line = w
        } else {
          line = test
        }
      }
      if (line) lines.push(line)
    }
    return lines
  }

  function drawWrapped(text: string, size: number, f: PDFFont, indent = 0) {
    for (const ln of wrap(text, CONTENT_WIDTH - indent, size, f)) {
      check(LINE_HEIGHT)
      if (ln) page.drawText(ln, { x: MARGIN + indent, y, size, font: f, color: rgb(0, 0, 0) })
      y -= LINE_HEIGHT
    }
  }

  function drawCentered(text: string, size: number, f: PDFFont, color = rgb(0, 0, 0)) {
    check(size + 6)
    const w = f.widthOfTextAtSize(text, size)
    page.drawText(text, { x: (PAGE_WIDTH - w) / 2, y, size, font: f, color })
    y -= size + 6
  }

  function drawLabelled(label: string, value: string, size = 10) {
    check(LINE_HEIGHT)
    // The trailing space is deliberate: it is part of the DRAWN text, so the
    // extracted text reads "Title: Manager" rather than "Title:Manager". The
    // document is read back out of the PDF for the content-parity test, and by
    // whoever inspects an executed agreement later — a gap that exists only as
    // positioning is invisible to both.
    const drawn = `${label} `
    page.drawText(drawn, { x: MARGIN, y, size, font, color: rgb(0.35, 0.35, 0.35) })
    if (value) {
      page.drawText(value, { x: MARGIN + font.widthOfTextAtSize(drawn, size), y, size, font: bold, color: rgb(0, 0, 0) })
    }
    y -= LINE_HEIGHT
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const isMMLLC = data.entity_type === "MMLLC"
  const entityLabel = isMMLLC ? "Multi-Member" : "Single Member"

  drawCentered("OPERATING AGREEMENT", 18, bold)
  drawCentered(data.company_name, 13, font, rgb(0.33, 0.33, 0.33))
  drawCentered(`A ${data.state_of_formation} ${entityLabel} Limited Liability Company`, 10, font, rgb(0.53, 0.53, 0.53))
  drawCentered("Manager-Managed", 9, font, rgb(0.67, 0.67, 0.67))
  y -= 10

  // ── Preamble ──────────────────────────────────────────────────────────────
  const preambleSigners = isMMLLC ? "the Members listed herein" : `${data.member_name} (the "Member")`
  drawWrapped(
    `This Operating Agreement ("Agreement") of ${data.company_name} (the "Company") is entered into and effective as of ${formatAgreementDate(data.effective_date)}, by ${preambleSigners}.`,
    9.5,
    italic,
  )
  y -= 10

  // ── Clauses — the SAME source the browser used ────────────────────────────
  for (const section of generateOASections(data)) {
    check(40)
    page.drawText(section.title, { x: MARGIN, y, size: 11, font: bold, color: rgb(0.04, 0.19, 0.38) })
    y -= LINE_HEIGHT + 4
    drawWrapped(section.content, 9.5, font)
    y -= 10
  }

  // ── Execution ─────────────────────────────────────────────────────────────
  check(60)
  y -= 6
  drawWrapped(
    `IN WITNESS WHEREOF, the ${isMMLLC ? "Members have" : "Member has"} executed this Operating Agreement as of the date first written above.`,
    10.5,
    bold,
  )
  y -= 12

  async function drawSignatureImage(png: Uint8Array | null | undefined) {
    if (!png || png.length === 0) return false
    try {
      const img = await doc.embedPng(png)
      const scale = Math.min(SIGNATURE_MAX_WIDTH / img.width, SIGNATURE_HEIGHT / img.height)
      const w = img.width * scale
      const h = img.height * scale
      check(h + 6)
      y -= h
      page.drawImage(img, { x: MARGIN + 12, y, width: w, height: h })
      y -= 8
      return true
    } catch {
      // A corrupt or non-PNG blob must not abort the whole document — the block
      // falls back to the text confirmation below, exactly as the page did.
      return false
    }
  }

  // Manager block
  check(70)
  page.drawText("MANAGER", { x: MARGIN, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) })
  y -= LINE_HEIGHT
  page.drawText(data.company_name, { x: MARGIN, y, size: 10, font: bold })
  y -= LINE_HEIGHT
  drawLabelled("Print Name:", data.manager_name)
  drawLabelled("Title:", "Manager")

  if (isMMLLC && Array.isArray(data.members) && data.members.length > 0) {
    y -= 10
    check(30)
    page.drawText("MEMBERS", { x: MARGIN, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) })
    y -= LINE_HEIGHT + 4

    const byIndex = new Map<number, OASignatureBlock>()
    for (const s of input.signatures ?? []) byIndex.set(s.memberIndex, s)

    for (let idx = 0; idx < data.members.length; idx++) {
      const m: OAMember = data.members[idx]
      const sig = byIndex.get(idx)
      check(80)
      drawLabelled("Print Name:", m.name)
      drawLabelled("Ownership:", `${m.ownership_pct}%`)
      if (m.address) drawLabelled("Address:", m.address)
      // Each member is dated by THEIR OWN signing date. The browser stamped
      // today's date on every block, so an earlier signer was dated as of the
      // last signer's day while the caption beside it showed the true date.
      drawLabelled("Date:", formatSignedDate(sig?.signedAt) || "____________________")

      const drew = await drawSignatureImage(sig?.signaturePng)
      const when = formatSignedDate(sig?.signedAt)
      if (sig?.signedAt) {
        check(LINE_HEIGHT)
        page.drawText(drew ? `Signed on ${when}` : `Signed on ${when} (signature on file)`, {
          x: MARGIN + 12,
          y,
          size: 8.5,
          font,
          color: rgb(0.13, 0.55, 0.33),
        })
        y -= LINE_HEIGHT
      }
      y -= 8
    }
  } else {
    // Single-member: one signature under the manager block.
    drawLabelled("Date:", formatSignedDate(input.soleSignedAt) || "____________________")
    const drew = await drawSignatureImage(input.soleSignaturePng)
    if (input.soleSignedAt) {
      check(LINE_HEIGHT)
      page.drawText(
        drew
          ? `Signed on ${formatSignedDate(input.soleSignedAt)}`
          : `Signed on ${formatSignedDate(input.soleSignedAt)} (signature on file)`,
        { x: MARGIN + 12, y, size: 8.5, font, color: rgb(0.13, 0.55, 0.33) },
      )
      y -= LINE_HEIGHT
    }
    y -= 6
    check(LINE_HEIGHT)
    page.drawText("Sole Member / Manager", { x: MARGIN, y, size: 9, font: italic, color: rgb(0.35, 0.35, 0.35) })
    y -= LINE_HEIGHT
  }

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    const label = `Page ${i + 1} of ${pages.length}`
    const w = font.widthOfTextAtSize(label, 8)
    pages[i].drawText(label, {
      x: (PAGE_WIDTH - w) / 2,
      y: MARGIN - 20,
      size: 8,
      font,
      color: rgb(0.6, 0.6, 0.6),
    })
  }

  return doc.save()
}
