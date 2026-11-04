/**
 * "Simplified view" of a file inside the storage screen (Antonio 2026-10-02: a Word file could only be downloaded, not read).
 * The server turns a Word / Excel / text-like file into ONE self-contained, script-free HTML page; the screen shows it in a locked
 * iframe. Nothing here runs the document: Word goes through mammoth, Excel through exceljs, text is escaped — and the route adds a
 * CSP that forbids every script. Plain helpers are exported for the tests; the two converters are the only async parts.
 */

export type ViewKind = "docx" | "xlsx" | "text" | "zip" | "pptx" | "odf" | "iwork" | "rtf" | "image"

export const VIEW_MAX_BYTES = { docx: 25 * 1024 * 1024, xlsx: 15 * 1024 * 1024, text: 2 * 1024 * 1024, zip: 60 * 1024 * 1024, pptx: 40 * 1024 * 1024, odf: 25 * 1024 * 1024, iwork: 80 * 1024 * 1024, rtf: 5 * 1024 * 1024, image: 40 * 1024 * 1024 } as const
export const VIEW_MAX_ROWS = 500
export const VIEW_MAX_COLS = 40

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|log|xml|yml|yaml|ini|sql|html?|conf|cfg|config|zoom|tag|properties|toml)$/i

/** What the simplified view can show, or null (PDF / pictures open the normal way; PowerPoint and old .doc/.xls are download-only). */
export function viewKindFor(name: string, mimeType: string | null | undefined): ViewKind | null {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (/\.docx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx"
  if (/\.xlsx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx"
  if (/\.zip$/i.test(name) || mime === "application/zip" || mime === "application/x-zip-compressed") return "zip"
  if (/\.(pptx|ppsx|potx)$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx"
  if (/\.(odt|ods|odp|odg|ott|ots)$/i.test(name) || mime.startsWith("application/vnd.oasis.opendocument.")) return "odf"
  if (/\.(numbers|pages|key)$/i.test(name) || mime.startsWith("application/vnd.apple.")) return "iwork"
  if (/\.rtf$/i.test(name) || mime === "application/rtf" || mime === "text/rtf") return "rtf"
  if (/\.(svg|tiff?|avif|jfif)$/i.test(name) || mime === "image/svg+xml" || mime === "image/tiff" || mime === "image/avif") return "image"
  if (TEXT_EXT.test(name) || mime === "text/markdown" || mime === "text/csv" || mime === "application/json" || (mime.startsWith("text/") && mime !== "text/plain")) return "text"
  return null
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const STYLE = "body{font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b;max-width:860px;margin:0 auto;padding:20px 24px}" +
  "h1,h2,h3,h4{line-height:1.25}table{border-collapse:collapse;margin:12px 0;font-size:13px}td,th{border:1px solid #d4d4d8;padding:4px 8px;vertical-align:top}" +
  "th{background:#f4f4f5}pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}img{max-width:100%;height:auto}" +
  ".note{font-size:12px;color:#71717a;border-bottom:1px solid #e4e4e7;margin:0 0 14px;padding-bottom:8px}.cut{color:#b45309;font-size:12px}"

export function wrapPage(title: string, body: string, note = "Simplified view — download the file for the exact original."): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><p class="note">${escapeHtml(note)}</p>${body}</body></html>`
}

/** Plain text / markdown / csv / json … shown as text, escaped. */
export function renderTextView(title: string, text: string): string {
  return wrapPage(title, `<pre>${escapeHtml(text)}</pre>`)
}

/**
 * Belt and braces on top of mammoth's own output: no script, style or embedded objects, no event handlers, and only http(s) / mailto /
 * in-page links survive. (The route's CSP and the iframe's sandbox forbid script anyway.)
 */
export function sanitizeDocxHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr: string, _q: string, d: string | undefined, s: string | undefined) => {
      const v = (d ?? s ?? "").trim()
      if (attr.toLowerCase() === "src") return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(v) ? m : ""
      return /^(https?:|mailto:|#)/i.test(v) ? ` href="${escapeHtml(v)}" rel="noopener noreferrer"` : ""
    })
}

export interface SheetData { name: string; rows: string[][]; totalRows: number; totalCols: number }

export function renderSheetsView(title: string, sheets: SheetData[]): string {
  if (!sheets.length) return wrapPage(title, "<p>This workbook has no sheets.</p>")
  const body = sheets.map((s) => {
    const cut = s.totalRows > s.rows.length || s.totalCols > (s.rows[0]?.length ?? 0)
    const table = s.rows.length
      ? `<table>${s.rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join("")}</tr>`).join("")}</table>`
      : "<p>(empty sheet)</p>"
    return `<h3>${escapeHtml(s.name)}</h3>${table}${cut ? `<p class="cut">Showing the first ${s.rows.length} of ${s.totalRows} rows and ${s.rows[0]?.length ?? 0} of ${s.totalCols} columns — download the file for all of it.</p>` : ""}`
  }).join("")
  return wrapPage(title, body)
}

/** Any exceljs cell value as plain text. */
export function cellText(v: unknown): string {
  if (v == null) return ""
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("")
    if ("result" in o) return cellText(o.result)
    if (typeof o.text === "string") return o.text
    if (typeof o.error === "string") return o.error
    return ""
  }
  return String(v)
}

export async function docxToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const mammoth = await import("mammoth")
  const r = await mammoth.convertToHtml({ buffer: bytes })
  return wrapPage(title, sanitizeDocxHtml(r.value) || "<p>(this document has no text)</p>")
}

export async function xlsxToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const sheets: SheetData[] = []
  wb.eachSheet((ws) => {
    const totalRows = ws.actualRowCount || ws.rowCount
    const totalCols = ws.actualColumnCount || ws.columnCount
    const cols = Math.min(totalCols, VIEW_MAX_COLS)
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (rows.length >= VIEW_MAX_ROWS || n > ws.rowCount) return
      const cells: string[] = []
      for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c).value))
      rows.push(cells)
    })
    sheets.push({ name: ws.name, rows, totalRows, totalCols })
  })
  return renderSheetsView(title, sheets)
}

/**
 * Does this look like readable text (no NUL byte, hardly any control characters in the first 8 KB)? Used for a file whose name says
 * nothing: a settings file with no ending, a log … It is shown ESCAPED as text, so a wrong guess can only look odd, never run anything.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  if (n === 0) return true
  let odd = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) odd++
  }
  return odd / n < 0.02
}

export const ZIP_MAX_LISTED = 500

export interface ZipEntryRow { name: string; dir: boolean; size: number | null }

/** The inside of a .zip as a plain page: names and sizes only — nothing is unpacked or run. */
export function renderZipView(title: string, entries: ZipEntryRow[], total: number): string {
  if (!entries.length) return wrapPage(title, "<p>This zip file is empty.</p>", "Zip contents — download the file to open what is inside.")
  const rows = entries.map((e) => `<tr><td>${escapeHtml(e.name)}</td><td>${e.dir ? "folder" : e.size == null ? "" : escapeHtml(formatBytes(e.size))}</td></tr>`).join("")
  const cut = total > entries.length ? `<p class="cut">Showing the first ${entries.length} of ${total} items.</p>` : ""
  return wrapPage(title, `<table><tr><th>Name</th><th>Size</th></tr>${rows}</table>${cut}`, "Zip contents — download the file to open what is inside.")
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${Math.round(n / 1024)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export async function zipToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const all = Object.values(zip.files)
  const rows: ZipEntryRow[] = all.slice(0, ZIP_MAX_LISTED).map((f) => ({
    name: f.name,
    dir: f.dir,
    size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? null,
  }))
  return renderZipView(title, rows, all.length)
}

// ---- every other kind: PowerPoint, OpenOffice, Apple files, RTF, pictures a browser cannot show, and the "details" page for the rest ----

/** Readable runs of text (letters, digits, punctuation, accents) found inside any file — what is left of an old binary Word / Excel file. */
export function extractStrings(bytes: Uint8Array, minLen = 6, maxLines = 200): string[] {
  const out: string[] = []
  let cur = ""
  const flush = () => { if (cur.trim().length >= minLen) out.push(cur.trim()); cur = "" }
  for (let i = 0; i < bytes.length && out.length < maxLines; i++) {
    const b = bytes[i]
    if ((b >= 32 && b < 127) || b === 9) cur += String.fromCharCode(b)
    else if (b >= 0xc2 && b <= 0xf4 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) { // a UTF-8 accented letter
      const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2
      cur += Buffer.from(bytes.subarray(i, i + len)).toString("utf-8"); i += len - 1
    } else flush()
  }
  flush()
  return out.slice(0, maxLines)
}

export function hexDump(bytes: Uint8Array, max = 256): string {
  const n = Math.min(bytes.length, max)
  const lines: string[] = []
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, n))
    const hex = Array.from(row).map((b) => b.toString(16).padStart(2, "0")).join(" ")
    const txt = Array.from(row).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${txt}`)
  }
  return lines.join("\n")
}

/** The page for a file nothing can draw: what it is, its size, the readable text inside, and the first bytes. Never a dead end. */
export function renderDetailsView(name: string, mimeType: string | null | undefined, size: number | null, head: Uint8Array, why = ""): string {
  const strings = extractStrings(head)
  const rows = [
    ["Name", name],
    ["Type", (mimeType ?? "").split(";")[0].trim() || "unknown"],
    ["Size", size == null ? "unknown" : formatBytes(size)],
  ].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")
  const body = `<h3>This kind of file has no picture to show</h3>${why ? `<p class="cut">${escapeHtml(why)}</p>` : ""}<table>${rows}</table>` +
    (strings.length ? `<h3>Readable text found inside</h3><pre>${escapeHtml(strings.join("\n"))}</pre>` : "<p>No readable text found inside.</p>") +
    `<h3>First bytes</h3><pre>${escapeHtml(hexDump(head))}</pre>`
  return wrapPage(name, body, "Details view — use Download the original to open it in its own program.")
}

/** RTF as plain text: drop the control words and groups, keep the letters. */
export function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(par|line|row)\b ?/g, "\n").replace(/\\tab\b ?/g, "\t")
    .replace(/\{\\\*[^{}]*\}/g, " ").replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, " ")
    .replace(/\\[a-z]+-?\d* ?/gi, "").replace(/\\([\\{}])/g, "$1").replace(/[{}]/g, "")
    .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

const xmlText = (xml: string): string => xml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
export const dataImg = (mime: string, b: Uint8Array): string => `<img alt="" src="data:${mime};base64,${Buffer.from(b).toString("base64")}">`

/** PowerPoint: the text of each slide (and the saved thumbnail). The slides are not drawn. */
export async function pptxToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
  const parts: string[] = []
  const thumb = zip.file("docProps/thumbnail.jpeg")
  if (thumb) parts.push(dataImg("image/jpeg", await thumb.async("uint8array")))
  const shown = slides.slice(0, 200)
  for (let i = 0; i < shown.length; i++) {
    const n = shown[i]
    const xml = await zip.files[n].async("string")
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) ?? []).map((p) => xmlText((p.match(/<a:t>[\s\S]*?<\/a:t>|<a:t [^>]*>[\s\S]*?<\/a:t>/g) ?? []).join(""))).filter((t) => t.trim())
    parts.push(`<h3>Slide ${i + 1}</h3>${paras.length ? paras.map((t) => `<p>${escapeHtml(t)}</p>`).join("") : "<p>(no text on this slide)</p>"}`)
  }
  return wrapPage(title, parts.join("") || "<p>This presentation has no slides.</p>", "Slide text — download the file for the exact design.")
}

/** OpenOffice / LibreOffice (odt ods odp …): the text, and the saved thumbnail. */
export async function odfToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const content = zip.file("content.xml")
  if (!content) throw new Error("no content.xml")
  const xml = await content.async("string")
  const text = xmlText(xml.replace(/<text:tab\/>/g, "\t").replace(/<\/(text:p|text:h|table:table-row)>/g, "\n").replace(/<\/table:table-cell>/g, "\t")).replace(/\n{3,}/g, "\n\n").trim()
  const thumb = zip.file("Thumbnails/thumbnail.png")
  const body = (thumb ? dataImg("image/png", await thumb.async("uint8array")) : "") + `<pre>${escapeHtml(text || "(no text)")}</pre>`
  return wrapPage(title, body, "Simplified view — download the file for the exact original.")
}

/** Apple Numbers / Pages / Keynote: the preview picture the file carries inside, else the list of its parts. */
export async function iworkToViewHtml(title: string, bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)
  const prefer = ["preview.jpg", "preview-web.jpg", "preview.png", "quicklook/preview.jpg", "quicklook/thumbnail.jpg"]
  const pick = prefer.map((p) => names.find((n) => n.toLowerCase() === p)).find(Boolean) ?? names.find((n) => /(^|\/)(preview|thumbnail)[^/]*\.(jpe?g|png)$/i.test(n))
  if (!pick) throw new Error("no preview picture inside")
  const b = await zip.files[pick].async("uint8array")
  return wrapPage(title, dataImg(/png$/i.test(pick) ? "image/png" : "image/jpeg", b), "Preview picture saved inside the file — download it to open it in Numbers / Pages / Keynote.")
}

export { isHtmlFile, HTML_RE, HTML_PAGE_MAX_BYTES } from "./media"
