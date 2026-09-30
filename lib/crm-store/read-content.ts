/**
 * CRM Store — read what is INSIDE a stored file and say what the system thinks it is (job 685467b5,
 * Antonio 2026-09-30). Read-only: nothing is written, retyped, renamed or deleted here.
 *
 * Why it exists: the Drive import copies the type the OLD CRM record carried, so a file the CRM never
 * typed stays untyped (a passport photo), and a file the CRM mislabelled keeps its wrong label. This reads the
 * file itself — the same Document AI reader the CRM already uses — and classifies the text with the
 * same rule set (`lib/classifier.ts`), so a person can confirm or correct what it thinks.
 *
 * HEIC/HEIF (iPhone photos) cannot be opened by the image library in the build (no HEVC support —
 * measured 2026-09-30), so they are converted to JPEG first.
 */
import type { OcrResult } from "@/lib/docai"
import { classifyDocument } from "@/lib/classifier"

export interface ContentReading {
  fileId: string
  name: string
  mimeType: string | null
  /** true when the picture had to be converted (HEIC) before it could be read */
  converted: boolean
  pageCount: number
  /** average reading confidence 0–1 from Document AI */
  readConfidence: number
  /** the text found (empty for a picture with no words) */
  text: string
  /** what the classifier thinks it is, by name (e.g. "Passport"), or null when no rule matches */
  suggestedType: string | null
  suggestedFolder: string | null
  suggestionStrength: "high" | "medium" | "low" | null
  /** why nothing could be said (unreadable file, no words found, …) */
  problem: string | null
}

export function looksLikeHeic(name: string, mimeType: string | null, bytes: Buffer): boolean {
  const m = (mimeType ?? "").toLowerCase()
  if (m === "image/heic" || m === "image/heif" || m === "image/heic-sequence" || m === "image/heif-sequence") return true
  if (/\.(heic|heif)$/i.test(name)) return true
  // the file signature: bytes 4–11 are "ftyp" plus a HEIF brand
  if (bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp") {
    return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(bytes.toString("ascii", 8, 12))
  }
  return false
}

export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const convert = (await import("heic-convert")).default as (o: { buffer: Buffer; format: "JPEG" | "PNG"; quality?: number }) => Promise<ArrayBuffer>
  return Buffer.from(await convert({ buffer: bytes, format: "JPEG", quality: 0.92 }))
}

export interface ReadDeps {
  readStore: (fileId: string) => Promise<{ bytes: Buffer; mimeType: string | null; name: string }>
  ocrBytes: (content: ArrayBuffer, mimeType: string, fileName: string) => Promise<OcrResult>
  toJpeg: (bytes: Buffer) => Promise<Buffer>
}

async function defaultDeps(): Promise<ReadDeps> {
  const { readStoreFile } = await import("./document-pointer")
  const { ocrRawContent } = await import("@/lib/docai")
  return { readStore: readStoreFile, ocrBytes: ocrRawContent, toJpeg: heicToJpeg }
}

export async function readStoreFileContent(fileId: string, deps?: ReadDeps): Promise<ContentReading> {
  const d = deps ?? (await defaultDeps())
  const f = await d.readStore(fileId)
  const base: ContentReading = {
    fileId, name: f.name, mimeType: f.mimeType, converted: false, pageCount: 0, readConfidence: 0,
    text: "", suggestedType: null, suggestedFolder: null, suggestionStrength: null, problem: null,
  }
  try {
    let bytes = f.bytes
    let mime = f.mimeType || "application/pdf"
    if (looksLikeHeic(f.name, f.mimeType, f.bytes)) {
      bytes = await d.toJpeg(f.bytes)
      mime = "image/jpeg"
      base.converted = true
    }
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const ocr = await d.ocrBytes(ab, mime, f.name)
    base.pageCount = ocr.pageCount
    base.readConfidence = ocr.confidence
    base.text = ocr.fullText
    if (!ocr.fullText.trim()) return { ...base, problem: "No words could be read in this file." }
    const hit = classifyDocument(ocr.pages.length ? ocr.pages : [ocr.fullText])
    if (!hit) return { ...base, problem: "The words were read, but they do not match any known document type." }
    return { ...base, suggestedType: hit.type, suggestedFolder: hit.suggestedFolder, suggestionStrength: hit.confidence }
  } catch (e) {
    return { ...base, problem: e instanceof Error ? e.message : "This file could not be read." }
  }
}
