/**
 * Unicode font helper for pdf-lib
 *
 * Centralizes the embedding of a Unicode-capable TrueType font family (DejaVu
 * Sans) in any `PDFDocument`, so that non-Latin-1 characters (ħ, €, á, ñ, π,
 * ß, ع, etc.) can be rendered in form fields or via drawText without throwing
 * `WinAnsi cannot encode "X" (0x...)` errors.
 *
 * This is the canonical replacement for every call of:
 *   pdfDoc.embedFont(StandardFonts.Helvetica)
 *   pdfDoc.embedFont(StandardFonts.HelveticaBold)
 *   pdfDoc.embedFont(StandardFonts.HelveticaOblique)
 *
 * For AcroForm form fields, call `form.updateFieldAppearances(regular)` BEFORE
 * `form.flatten()` so the form's default Helvetica/WinAnsi appearances are
 * replaced with appearances drawn by the custom Unicode font.
 *
 * Related: dev_task 208d20be — "PDF generators cannot encode non-Latin-1
 * characters (pdf-lib StandardFonts / WinAnsi limit) — blocks ITIN rescue for
 * Maltese/Arabic/Chinese/non-ASCII clients".
 *
 * Font choice: DejaVu Sans 2.37 (public/fonts/DejaVuSans*.ttf) — SIL Open Font
 * License. Covers Latin, Latin Extended A/B, IPA Extensions, Greek, Cyrillic,
 * Armenian, Hebrew, Arabic, N'Ko, Lao, Georgian, mathematical operators, and
 * more. Does NOT cover CJK (Chinese/Japanese/Korean) — add a separate font
 * later if a CJK client appears.
 */

import type { PDFDocument, PDFFont } from "pdf-lib"
import fontkit from "@pdf-lib/fontkit"
import { readFile } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"

const FONTS_DIR = join(process.cwd(), "public", "fonts")

// Cache font bytes across invocations in the same Node process so we only
// touch the filesystem (or fetch the URL) once per cold start.
let regularBytesCache: Buffer | null = null
let boldBytesCache: Buffer | null = null
let obliqueBytesCache: Buffer | null = null

/**
 * Load a font file by name. Mirrors the template-loading pattern used in
 * lib/pdf/8832-fill.ts and lib/pdf/ss4-fill.ts: try the local filesystem
 * first (works in `npm run dev` and in builds where output file tracing
 * bundled public/), then fall back to fetching the font from the app's
 * own static-asset URL (works on Vercel serverless functions where
 * public/fonts/* is served via the CDN but not always included in the
 * function's filesystem bundle at /var/task/public/).
 */
async function loadFontBytes(filename: string): Promise<Buffer> {
  const localPath = join(FONTS_DIR, filename)
  if (existsSync(localPath)) {
    return readFile(localPath)
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    "https://app.tonydurante.us"
  const res = await fetch(`${baseUrl}/fonts/${filename}`)
  if (!res.ok) {
    throw new Error(`Failed to load font ${filename}: ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function loadRegularBytes(): Promise<Buffer> {
  if (!regularBytesCache) {
    regularBytesCache = await loadFontBytes("DejaVuSans.ttf")
  }
  return regularBytesCache
}

async function loadBoldBytes(): Promise<Buffer> {
  if (!boldBytesCache) {
    boldBytesCache = await loadFontBytes("DejaVuSans-Bold.ttf")
  }
  return boldBytesCache
}

async function loadObliqueBytes(): Promise<Buffer> {
  if (!obliqueBytesCache) {
    obliqueBytesCache = await loadFontBytes("DejaVuSans-Oblique.ttf")
  }
  return obliqueBytesCache
}

export interface UnicodeFontSet {
  /** DejaVu Sans Regular — replacement for StandardFonts.Helvetica */
  regular: PDFFont
  /** DejaVu Sans Bold — replacement for StandardFonts.HelveticaBold */
  bold: PDFFont
  /** DejaVu Sans Oblique — replacement for StandardFonts.HelveticaOblique. Only embedded if `oblique: true` is passed. */
  oblique?: PDFFont
}

/**
 * Register fontkit on the given `PDFDocument` and embed DejaVu Sans Regular +
 * Bold (and optionally Oblique) as Unicode-capable subset fonts.
 *
 * Returns a font set with `.regular`, `.bold`, and (if opted in) `.oblique`.
 *
 * Example (coordinate-based drawing):
 * ```ts
 * const pdf = await PDFDocument.load(templateBytes)
 * const { regular: font, bold: boldFont } = await embedUnicodeFonts(pdf)
 * page.drawText("San Pawl il-Baħar", { x: 50, y: 500, size: 10, font })
 * ```
 *
 * Example (AcroForm field fill):
 * ```ts
 * const pdf = await PDFDocument.load(templateBytes)
 * const { regular } = await embedUnicodeFonts(pdf)
 * const form = pdf.getForm()
 * form.getTextField("f1_16[0]").setText("San Pawl il-Baħar, SPB2502, Malta")
 * // IMPORTANT: update field appearances with the custom font BEFORE flatten
 * form.updateFieldAppearances(regular)
 * form.flatten()
 * ```
 */
export async function embedUnicodeFonts(
  pdf: PDFDocument,
  opts: { oblique?: boolean } = {}
): Promise<UnicodeFontSet> {
  pdf.registerFontkit(fontkit)

  const [regularBytes, boldBytes] = await Promise.all([loadRegularBytes(), loadBoldBytes()])
  const regular = await pdf.embedFont(regularBytes, { subset: true })
  const bold = await pdf.embedFont(boldBytes, { subset: true })

  let oblique: PDFFont | undefined
  if (opts.oblique) {
    const obliqueBytes = await loadObliqueBytes()
    oblique = await pdf.embedFont(obliqueBytes, { subset: true })
  }

  return { regular, bold, oblique }
}
