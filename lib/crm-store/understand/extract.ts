/**
 * File Understanding — read the CONTENT of any file (job 685467b5). One entry point for every kind:
 * PDF (text layer first, Document AI for scans, windowed), photos (HEIC converted, oversized ones shrunk),
 * Word/Excel, CSV/text (BOM/UTF-16/Windows-1252 aware, never silently cut), zip (bounded), everything else =
 * a plain "could not be read" — a FINAL state, never an empty string that later gets classified as if it meant something.
 * Dependencies are injectable so every branch is unit-tested without Document AI.
 */
import { LIMITS } from "./vocab"
import { sniffKind, decodeText, type FileKind } from "./sniff"

export interface Extracted {
  kind: FileKind
  mime: string
  text: string
  pages: string[]
  /** the document's real length when known */
  pageCount: number | null
  pagesRead: number
  /** true when the file has more than was read */
  partial: boolean
  /** a JPEG the AI can LOOK at (scans / photos / HEIC converted) — null for text-like files */
  visual: Buffer | null
  converted: boolean
  /** why nothing (or not everything) could be read; null when fully read */
  problem: string | null
  /** true when the reading is final and a retry cannot help (locked, unknown type, too big …) */
  terminal: boolean
}

export interface ExtractDeps {
  ocr: (buf: Buffer, mime: string, name: string) => Promise<{ fullText: string; pages: string[]; documentPageCount?: number; partial: boolean }>
  pdfTextLayer: (buf: Buffer) => Promise<{ text: string; numpages: number }>
  heicToJpeg: (buf: Buffer) => Promise<Buffer>
  shrinkJpeg: (buf: Buffer, maxBytes: number) => Promise<Buffer>
  officeText: (buf: Buffer, kind: "xlsx" | "docx") => Promise<string>
}

async function defaultDeps(): Promise<ExtractDeps> {
  return {
    ocr: async (buf, mime, name) => {
      const { ocrBytesAllPages } = await import("@/lib/docai")
      const r = await ocrBytesAllPages(buf, mime, name, { maxPages: LIMITS.maxPages })
      return { fullText: r.fullText, pages: r.pages, documentPageCount: r.documentPageCount, partial: r.partial }
    },
    pdfTextLayer: async (buf) => {
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer) => Promise<{ text: string; numpages: number }>
      const d = await pdfParse(buf)
      return { text: d.text ?? "", numpages: d.numpages ?? 0 }
    },
    heicToJpeg: async (buf) => (await import("@/lib/crm-store/read-content")).heicToJpeg(buf),
    shrinkJpeg: async (buf, maxBytes) => {
      const sharp = (await import("sharp")).default
      let last = buf
      for (const [width, quality] of [[2400, 85], [2000, 70], [1600, 55], [1200, 40]] as const) {
        last = await sharp(buf, { failOn: "none" }).rotate().resize({ width, height: width, fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer()
        if (last.length <= maxBytes) return last
      }
      return last
    },
    officeText: async (buf, kind) => {
      const { extractTextFromBuffer } = await import("@/lib/ai-agent/slack-file-reader")
      return extractTextFromBuffer(buf, kind, LIMITS.maxTextBytes)
    },
  }
}

const empty = (kind: FileKind, mime: string): Extracted => ({
  kind, mime, text: "", pages: [], pageCount: null, pagesRead: 0, partial: false, visual: null, converted: false, problem: null, terminal: false,
})
const fail = (base: Extracted, problem: string, terminal = true): Extracted => ({ ...base, problem, terminal })

/** A PDF needs Document AI when its text layer is (nearly) empty — a scan. */
export const PDF_TEXT_MIN_CHARS_PER_PAGE = 40

export async function extractContent(bytes: Buffer, name: string, deps?: ExtractDeps): Promise<Extracted> {
  const d = deps ?? (await defaultDeps())
  const { kind, mime } = sniffKind(bytes, name)
  const base = empty(kind, mime)
  if (bytes.length === 0) return fail(base, "The file is empty.")
  if (bytes.length > LIMITS.maxFileBytes) return fail(base, `The file is too large to read (${(bytes.length / 1048576).toFixed(0)} MB).`)

  try {
    switch (kind) {
      case "pdf": {
        let layer = { text: "", numpages: 0 }
        try { layer = await d.pdfTextLayer(bytes) } catch (e) {
          if (/password|encrypt/i.test(e instanceof Error ? e.message : "")) return fail(base, "This PDF is password-protected, so it cannot be read.")
        }
        const enough = layer.numpages > 0 && layer.text.replace(/\s+/g, "").length >= PDF_TEXT_MIN_CHARS_PER_PAGE * Math.min(layer.numpages, 3)
        if (enough) {
          const pages = layer.text.split(/\f|\n?---PAGE BREAK---\n?/).filter((p) => p.trim())
          // the text layer of the WHOLE document is read for free, whatever its length — nothing is cut, so it is not 'partial'
          return { ...base, text: layer.text, pages: pages.length ? pages : [layer.text], pageCount: layer.numpages, pagesRead: layer.numpages, partial: false, problem: null }
        }
        const r = await d.ocr(bytes, "application/pdf", name)   // a scan → Document AI, window by window
        const total = r.documentPageCount ?? r.pages.length
        return {
          ...base, text: r.fullText, pages: r.pages, pageCount: total, pagesRead: r.pages.length, partial: r.partial,
          problem: r.partial ? `Only ${r.pages.length} of ${total} pages were read.` : (!r.fullText.trim() ? "No words could be read in this file." : null),
        }
      }
      case "jpeg": case "png": case "webp": case "gif": case "tiff": case "bmp": case "heic": {
        let img = bytes
        let mimeOut = mime
        let converted = false
        if (kind === "heic") { img = await d.heicToJpeg(bytes); mimeOut = "image/jpeg"; converted = true }
        if (mimeOut === "image/jpeg" && img.length > LIMITS.maxVisionBytes) { img = await d.shrinkJpeg(img, LIMITS.maxVisionBytes); converted = true }
        const r = await d.ocr(img, mimeOut, name)
        return { ...base, text: r.fullText, pages: r.pages, pageCount: 1, pagesRead: 1, partial: false, converted, visual: mimeOut === "image/jpeg" || kind === "png" || kind === "webp" || kind === "gif" ? img : null, problem: r.fullText.trim() ? null : "No words could be read in this picture." }
      }
      case "docx": case "xlsx": {
        const guard = await guardZip(bytes)
        if (guard) return fail(base, guard)
        const text = await d.officeText(bytes, kind)
        return { ...base, text, pages: [text], pageCount: null, pagesRead: 1, problem: text.trim() ? null : "The document has no text." }
      }
      case "pptx": return fail(base, "PowerPoint files cannot be read yet.")
      case "ole": return fail(base, "This is an old Office file (.xls/.doc/.ppt) — it cannot be read yet. Saving it as .xlsx/.docx makes it readable.")
      case "text": case "csv": {
        if (bytes.length > LIMITS.maxTextBytes) return fail(base, "The text file is too large to read whole.")
        const text = decodeText(bytes)
        return { ...base, text, pages: [text], pagesRead: 1, problem: text.trim() ? null : "The file has no text." }
      }
      case "zip": {
        const z = await readZip(bytes)
        if (z.problem) return fail(base, z.problem)
        return { ...base, text: z.text, pages: [z.text], pagesRead: 1, problem: null }
      }
      default:
        return fail(base, "This kind of file cannot be read.")
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The file could not be read."
    const terminal = /password|encrypt|could not be opened|unsupported|corrupt|invalid|not a valid/i.test(msg)
    return fail(base, msg, terminal)
  }
}

/** Refuse a zip-family file (also docx/xlsx are zips) that would inflate to something dangerous. Returns a problem text or null. */
export async function guardZip(bytes: Buffer): Promise<string | null> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files)
  if (entries.length > LIMITS.zipMaxEntries) return `The archive holds ${entries.length} files — too many to read safely.`
  let total = 0
  for (const e of entries) total += (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
  if (total > LIMITS.zipMaxUncompressedBytes) return "The archive would expand to more than 100 MB — not opened."
  if (bytes.length > 0 && total / bytes.length > LIMITS.zipMaxRatio) return "The archive is suspiciously compressed — not opened."
  return null
}

/** A zip: list its members and decode the small text-like ones (nested archives are listed by name only). */
export async function readZip(bytes: Buffer): Promise<{ text: string; problem: string | null }> {
  const g = await guardZip(bytes)
  if (g) return { text: "", problem: g }
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const lines: string[] = []
  for (const e of Object.values(zip.files)) {
    if (e.dir) continue
    const size = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    const textLike = /\.(txt|csv|tsv|json|xml|md|log|html?)$/i.test(e.name)
    if (textLike && size <= LIMITS.zipMaxMemberBytes) lines.push(`--- ${e.name} ---\n${decodeText(Buffer.from(await e.async("uint8array")))}`)
    else lines.push(`--- ${e.name} (${size} bytes, not read) ---`)
  }
  return { text: lines.join("\n"), problem: lines.length ? null : "The archive is empty." }
}
