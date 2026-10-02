/**
 * "Simplified view" of a file inside the storage screen (Antonio 2026-10-02: a Word file could only be downloaded, not read).
 * The server turns a Word / Excel / text-like file into ONE self-contained, script-free HTML page; the screen shows it in a locked
 * iframe. Nothing here runs the document: Word goes through mammoth, Excel through exceljs, text is escaped — and the route adds a
 * CSP that forbids every script. Plain helpers are exported for the tests; the two converters are the only async parts.
 */

export type ViewKind = "docx" | "xlsx" | "text"

export const VIEW_MAX_BYTES = { docx: 25 * 1024 * 1024, xlsx: 15 * 1024 * 1024, text: 2 * 1024 * 1024 } as const
export const VIEW_MAX_ROWS = 500
export const VIEW_MAX_COLS = 40

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|log|xml|yml|yaml|ini|sql|html?)$/i

/** What the simplified view can show, or null (PDF / pictures open the normal way; PowerPoint and old .doc/.xls are download-only). */
export function viewKindFor(name: string, mimeType: string | null | undefined): ViewKind | null {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (/\.docx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx"
  if (/\.xlsx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx"
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
