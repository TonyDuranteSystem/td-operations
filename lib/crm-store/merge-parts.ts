/**
 * Storage "Merge into one": several files of ONE company (or ONE person) become a single PDF, in the order the staff member
 * chose (Antonio 2026-10-24 — e.g. a tax return + its IRS fax receipt). The merge runs in the browser from files the staff
 * member can already open, and the result goes through the normal Upload window — so folder, document type, name, "show to
 * client" and every existing question are chosen by the person, nothing is fixed here.
 *
 * Pure (Uint8Array, no Buffer, no DOM) so it is tested in plain node. PDFs are appended page by page; a PNG or JPG (a fax
 * receipt is often a picture) becomes one page; anything else (Word, Excel, a locked PDF…) is refused with the file's name.
 * Same inputs always give the same bytes (fixed dates), so the "this exact file is already stored" check keeps working.
 */
import { PDFDocument } from "pdf-lib"

export class MergeError extends Error {
  constructor(message: string) { super(message); this.name = "MergeError" }
}

export const MERGE_MAX_PARTS = 20
export const MERGE_MAX_TOTAL_BYTES = 150 * 1024 * 1024

export interface MergePart { name: string; mimeType: string | null; bytes: Uint8Array }
export interface MergeResult { bytes: Uint8Array; pageCounts: number[] }
export type PartKind = "pdf" | "png" | "jpg" | "unsupported"

const FIXED_DATE = new Date(Date.UTC(2000, 0, 1))
const PRODUCER = "TD Operations"
// a Letter page, in points: a picture larger than this is scaled DOWN to fit (never enlarged)
const MAX_W = 612
const MAX_H = 792

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b)

/** What a file really is, by its first bytes (the name and the type the browser reports can lie). */
export function partKind(bytes: Uint8Array): PartKind {
  if (latin1(bytes.subarray(0, 1024)).includes("%PDF-")) return "pdf"
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg"
  return "unsupported"
}

/** A quick look at the NAME only, for the dialog before anything is downloaded. The real check is `partKind`. */
export function looksMergeable(name: string, mimeType: string | null): boolean {
  const n = name.toLowerCase()
  const m = (mimeType ?? "").toLowerCase()
  return /\.(pdf|png|jpe?g)$/.test(n) || m === "application/pdf" || m === "image/png" || m === "image/jpeg"
}

/** A locked PDF names /Encrypt near the start or the end of the file. */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  return latin1(bytes.subarray(Math.max(0, bytes.length - 4096))).includes("/Encrypt") || latin1(bytes.subarray(0, 4096)).includes("/Encrypt")
}

export function baseName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, "")
}

/** A starting name for the merged file (the person renames it freely in the Upload window). */
export function suggestMergedName(names: string[]): string {
  const bases = names.map(baseName).filter(Boolean)
  const joined = bases.slice(0, 2).join(" + ") + (bases.length > 2 ? ` + ${bases.length - 2} more` : "")
  return `${(joined || "Merged document").slice(0, 120)}.pdf`
}

export async function mergeParts(parts: MergePart[]): Promise<MergeResult> {
  if (parts.length < 2) throw new MergeError("Choose at least two files to merge.")
  if (parts.length > MERGE_MAX_PARTS) throw new MergeError(`At most ${MERGE_MAX_PARTS} files can be merged at a time.`)
  const total = parts.reduce((n, p) => n + p.bytes.length, 0)
  if (total > MERGE_MAX_TOTAL_BYTES) throw new MergeError(`These files are ${Math.round(total / 1048576)} MB together — the limit for a merge is ${MERGE_MAX_TOTAL_BYTES / 1048576} MB.`)
  const out = await PDFDocument.create({ updateMetadata: false })
  const pageCounts: number[] = []
  for (const p of parts) {
    const kind = partKind(p.bytes)
    if (kind === "unsupported") throw new MergeError(`"${p.name}" is not a PDF, PNG or JPG — only those can be merged.`)
    try {
      if (kind === "pdf") {
        if (isEncryptedPdf(p.bytes)) throw new MergeError(`"${p.name}" is locked (password-protected) — it cannot be merged.`)
        const src = await PDFDocument.load(p.bytes, { updateMetadata: false })
        const n = src.getPageCount()
        if (n === 0) throw new MergeError(`"${p.name}" has no pages.`)
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page)
        pageCounts.push(n)
      } else {
        const img = kind === "png" ? await out.embedPng(p.bytes) : await out.embedJpg(p.bytes)
        const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height)
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h })
        pageCounts.push(1)
      }
    } catch (e) {
      if (e instanceof MergeError) throw e
      throw new MergeError(`"${p.name}" cannot be opened — it may be damaged (${e instanceof Error ? e.message : String(e)}).`)
    }
  }
  const expected = pageCounts.reduce((a, b) => a + b, 0)
  if (out.getPageCount() !== expected) throw new MergeError(`The merged file has ${out.getPageCount()} pages, expected ${expected}.`)
  out.setCreationDate(FIXED_DATE)
  out.setModificationDate(FIXED_DATE)
  out.setProducer(PRODUCER)
  out.setCreator(PRODUCER)
  return { bytes: await out.save({ useObjectStreams: false, addDefaultPage: false }), pageCounts }
}
