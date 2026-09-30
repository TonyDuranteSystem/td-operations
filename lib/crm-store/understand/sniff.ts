/**
 * File Understanding — what a file REALLY is, from its bytes (never its name or the mime type it was saved with;
 * a `.jpg` can be a PDF and a Drive mime can be wrong). Pure: no network, no database.
 */
export type FileKind =
  | "pdf" | "jpeg" | "png" | "gif" | "webp" | "tiff" | "bmp" | "heic"
  | "docx" | "xlsx" | "pptx" | "zip" | "ole" | "text" | "csv" | "unknown"

export interface Sniffed { kind: FileKind; mime: string }

const MIME: Record<FileKind, string> = {
  pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", tiff: "image/tiff",
  bmp: "image/bmp", heic: "image/heic",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", ole: "application/x-ole-storage", text: "text/plain", csv: "text/csv", unknown: "application/octet-stream",
}

const HEIF_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/

function startsWith(b: Buffer, sig: number[], at = 0): boolean {
  if (b.length < at + sig.length) return false
  return sig.every((v, i) => b[at + i] === v)
}

/** Is this buffer plain text? (No NUL bytes and almost all printable, or a Unicode BOM.) */
export function looksLikeText(b: Buffer): boolean {
  if (startsWith(b, [0xef, 0xbb, 0xbf]) || startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return true
  const n = Math.min(b.length, 8192)
  if (n === 0) return true
  let odd = 0
  for (let i = 0; i < n; i++) {
    const c = b[i]
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) odd++
  }
  return odd / n < 0.02
}

function looksLikeCsv(text: string, name: string): boolean {
  if (/\.(csv|tsv)$/i.test(name)) return true
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 20)
  if (lines.length < 2) return false
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1)
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return true
  }
  return false
}

export function sniffKind(bytes: Buffer, name = ""): Sniffed {
  const k = (kind: FileKind): Sniffed => ({ kind, mime: MIME[kind] })
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return k("pdf")                       // %PDF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return k("jpeg")
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return k("png")
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return k("gif")
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.toString("ascii", 8, 12) === "WEBP") return k("webp")
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return k("tiff")
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 26) return k("bmp")
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp" && HEIF_BRANDS.test(bytes.toString("ascii", 8, 12))) return k("heic")
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return k("ole")   // old .xls/.doc/.ppt
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {                                    // PK — zip family
    const head = bytes.toString("latin1", 0, Math.min(bytes.length, 16384))
    if (head.includes("word/")) return k("docx")
    if (head.includes("xl/")) return k("xlsx")
    if (head.includes("ppt/")) return k("pptx")
    return k("zip")
  }
  if (looksLikeText(bytes)) {
    const sample = decodeText(bytes.subarray(0, 65536))
    return looksLikeCsv(sample, name) ? k("csv") : k("text")
  }
  return k("unknown")
}

/** Decode text bytes: BOM first, then UTF-8, and only if that is not valid UTF-8, Windows-1252 (Italian/Portuguese CSVs). */
export function decodeText(bytes: Buffer): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return bytes.subarray(3).toString("utf8")
  if (startsWith(bytes, [0xff, 0xfe])) return bytes.subarray(2).toString("utf16le")
  if (startsWith(bytes, [0xfe, 0xff])) {
    const sw = Buffer.from(bytes.subarray(2))
    sw.swap16()
    return sw.toString("utf16le")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1252").decode(bytes)
  }
}
