/**
 * "Every kind of file opens" (Antonio 2026-11-04: "all type of files"). ONE decision for the simplified-view route: given what the file is
 * (name, type, size, its first bytes), make the page the screen shows. A kind we can read is converted (Word, Excel, PowerPoint,
 * OpenOffice, Apple files, RTF, text, zip, pictures a browser cannot draw); a file whose content reads as text is shown as text; and
 * anything else — or a file too big to read here, or one that fails to convert — gets the details page. So the answer is always a page,
 * never "cannot be shown". Nothing here runs the file: every page is script-free HTML made by the server.
 */
import {
  viewKindFor, VIEW_MAX_BYTES, looksLikeText, renderTextView, wrapPage, escapeHtml, formatBytes, rtfToText, renderDetailsView,
  docxToViewHtml, xlsxToViewHtml, zipToViewHtml, pptxToViewHtml, odfToViewHtml, iworkToViewHtml, type ViewKind,
} from "./view-html"
import { imageToViewHtml } from "./view-image"

export const VIEW_HEAD_BYTES = 64 * 1024

export interface ViewInput {
  name: string
  mimeType: string | null
  /** total size when known (null = not known) */
  size: number | null
  /** the first bytes of the file (up to VIEW_HEAD_BYTES) */
  head: Buffer
  /** the whole file — only called when the kind needs it and the size is within its limit */
  full: () => Promise<Buffer>
}

export async function viewPageFor(i: ViewInput): Promise<{ html: string; kind: ViewKind | "details" }> {
  const total = i.size ?? i.head.length
  let kind: ViewKind | null = viewKindFor(i.name, i.mimeType)
  // a name that says nothing: if the content reads as plain text, show it as text (escaped)
  if (!kind && total <= VIEW_MAX_BYTES.text && looksLikeText(i.head)) kind = "text"
  if (!kind) return { html: renderDetailsView(i.name, i.mimeType, i.size ?? i.head.length, i.head), kind: "details" }
  if (total > VIEW_MAX_BYTES[kind]) {
    return { html: renderDetailsView(i.name, i.mimeType, total, i.head, `This file is too large to draw here (${formatBytes(total)}) — download it to open it.`), kind: "details" }
  }
  try {
    const bytes = await i.full()
    if (bytes.length > VIEW_MAX_BYTES[kind]) throw new Error("larger than expected")
    const html = kind === "docx" ? await docxToViewHtml(i.name, bytes)
      : kind === "xlsx" ? await xlsxToViewHtml(i.name, bytes)
      : kind === "zip" ? await zipToViewHtml(i.name, bytes)
      : kind === "pptx" ? await pptxToViewHtml(i.name, bytes)
      : kind === "odf" ? await odfToViewHtml(i.name, bytes)
      : kind === "iwork" ? await iworkToViewHtml(i.name, bytes)
      : kind === "image" ? await imageToViewHtml(i.name, bytes)
      : kind === "rtf" ? wrapPage(i.name, `<pre>${escapeHtml(rtfToText(bytes.toString("latin1")) || "(no text)")}</pre>`)
      : renderTextView(i.name, bytes.toString("utf-8"))
    return { html, kind }
  } catch (e) {
    const why = `The inside of this file could not be read (${e instanceof Error ? e.message : "unknown problem"}).`
    return { html: renderDetailsView(i.name, i.mimeType, total, i.head, why), kind: "details" }
  }
}
