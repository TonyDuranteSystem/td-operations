/**
 * Slack multi-format file reader (pure extractors).
 *
 * The Slack worker can be handed ANY file type a user shares in Slack — not just
 * screenshots. This module is the type-router + text extractors. It is pure (no
 * network, no Slack token): given a downloaded Buffer + mimetype/name it returns
 * plain text the model can read. The Slack-specific download + document-block
 * decision lives in `slack-claude.ts::readSlackFiles` (mirrors how the image
 * download lives there next to `prepareSlackImages`), so this file stays
 * unit-testable without a Slack token.
 *
 * Coverage:
 *   - text/* + csv/tsv/json/xml/yaml/markdown/source/log → decoded UTF-8
 *   - PDF   → pdf-parse text layer (caller falls back to a native document block
 *             when the text layer is empty/scanned — see readSlackFiles)
 *   - XLSX/XLS → every sheet flattened to tab-separated rows (exceljs)
 *   - DOCX  → raw text (mammoth)
 *   - ZIP   → each text-like entry decoded + concatenated (jszip); binary entries
 *             inside the zip are listed by name only
 *   - images are handled by the existing vision path (prepareSlackImages), NOT here
 *   - anything else → unsupported (caller emits a short "couldn't read" note)
 */

/**
 * Per-file extracted-text cap (chars) PER READ — a window size, not a wall.
 *
 * CONFIG, not a constant to edit: `WORKER_FILE_READ_CAP` on Vercel overrides it
 * (floor 1,000 so a typo like "20" can't blind every read; absent/invalid ⇒ 20k
 * ≈ 5k tokens). Raising it is a config change, not a deploy.
 *
 * The cap stopped being a hard limit on 2026-07-29: reads are windowed
 * (`windowText`), and the truncation marker tells the model the exact offset to
 * continue from, so a long document is read to the END across calls instead of
 * being silently answered from its first pages. The live failure that forced
 * this: Smit's amended 2024 Form 1065 for Dynamiq SR LLC ran 125k chars and the
 * assistant could reach only ~the first 4 pages, on real client tax work.
 */
export const SLACK_FILE_TEXT_CHAR_CAP = (() => {
  const n = Number(process.env.WORKER_FILE_READ_CAP)
  return Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : 20_000
})()

/** Text-like file extensions found INSIDE a zip that we decode (others listed by name). */
const ZIP_TEXT_EXTENSIONS = new Set([
  "txt", "csv", "tsv", "json", "xml", "yaml", "yml", "md", "markdown", "log",
  "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs",
  "java", "c", "h", "cpp", "sh", "sql", "ini", "conf", "env", "vcf", "srt",
])

export type SlackFileKind =
  | "text"
  | "pdf"
  | "xlsx"
  | "docx"
  | "zip"
  | "image"
  | "unsupported"

/**
 * Classify a Slack file into an extraction route from its mimetype + filename.
 * Pure + synchronous. Filename extension wins for the structured formats
 * (Slack's mimetype for an .xlsx/.docx/.zip is reliable, but the extension is a
 * good secondary signal and covers octet-stream uploads).
 */
export function classifySlackFile(mimetype: string | undefined, name: string | undefined): SlackFileKind {
  const mime = (mimetype ?? "").toLowerCase()
  const lowerName = (name ?? "").toLowerCase()
  const ext = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".") + 1) : ""

  // Images are read by the vision path, not here.
  if (mime.startsWith("image/")) return "image"

  if (mime === "application/pdf" || ext === "pdf") return "pdf"

  if (
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    return "xlsx"
  }

  if (mime.includes("wordprocessingml") || ext === "docx") return "docx"

  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "multipart/x-zip" ||
    ext === "zip"
  ) {
    return "zip"
  }

  // Text-bearing: any text/* mimetype, or the common structured/source extensions
  // even when Slack labels them application/octet-stream.
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-ndjson" ||
    mime === "application/csv" ||
    ZIP_TEXT_EXTENSIONS.has(ext)
  ) {
    return "text"
  }

  return "unsupported"
}

/**
 * Truncate text to the cap, marking the result as a PARTIAL read.
 *
 * The marker is emitted at the HEAD, not only as the tail note, and carries the
 * machine-readable `"complete": false` contract that `looksLikeIncompleteRead`
 * (lib/ai-agent/answer-guards.ts) keys on — that check scans only the first 600
 * characters, by design, so a tail-only note is invisible to it.
 *
 * WHY THIS MATTERS, and it is the spreadsheet case exactly: a year of bank
 * transactions flattened to rows runs far past this cap, so the assistant used to
 * receive the first few hundred rows as an ordinary SUCCESSFUL read. It could then
 * total the payouts, or state that a wire is absent, while the absence guard
 * affirmatively confirmed it had looked. Same failure the windowed-OCR contract
 * closed for long scanned PDFs; this closes it for extracted text.
 */
export function capText(text: string, cap: number = SLACK_FILE_TEXT_CHAR_CAP): string {
  return windowText(text, 0, cap)
}

/**
 * One WINDOW of a long text, with a marker that makes continuing possible.
 *
 * The head marker keeps the exact `"complete": false` shape the absence guard
 * scans for (head-only, 600 chars — a tail-only note is invisible to it). What
 * changed on 2026-07-29: the marker now carries the NEXT OFFSET, so a truncated
 * read is a page turn, not a dead end. Before this, "the file is long" was the
 * end of the road and a 125k-char amended tax return was answered from its first
 * ~4 pages.
 */
export function windowText(text: string, offset: number, cap: number = SLACK_FILE_TEXT_CHAR_CAP): string {
  const start = Math.min(Math.max(0, Math.floor(offset) || 0), text.length)
  const end = Math.min(start + Math.max(1, cap), text.length)
  if (start === 0 && end === text.length) return text
  const slice = text.slice(start, end)
  const more = end < text.length
  return [
    `INCOMPLETE READ — "complete": false`,
    `Showing characters ${start}–${end} of ${text.length}. The rest was NOT read.`,
    more
      ? `To keep reading, call this tool again with offset: ${end}. Do not total, count, or state that something is absent from this file until you have read to the end.`
      : `This is the FINAL section — the file ends here.`,
    '',
    slice,
    '',
    more
      ? `…[truncated — file is ${text.length} chars; continue with offset: ${end}]`
      : `[end of file — ${text.length} chars total]`,
  ].join('\n')
}

/**
 * Strip every <mergeCells> element from a workbook's worksheet XML.
 *
 * Apple Numbers → Excel exports routinely write OVERLAPPING merged-cell ranges,
 * which exceljs refuses to load ("Cannot merge already merged cells") — so the
 * whole read died and the worker told staff to convert the file yet again
 * (Luca's tax-returns tracking sheet, td-bug 2026-07-29). Merges carry zero
 * information for flattening to rows, so dropping them loses nothing.
 */
async function stripMergeCells(buffer: Buffer): Promise<Buffer> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buffer)
  const sheets = Object.values(zip.files).filter((f) => !f.dir && /^xl\/worksheets\/[^/]+\.xml$/i.test(f.name))
  for (const sheet of sheets) {
    const xml = await sheet.async("string")
    const cleaned = xml.replace(/<mergeCells[^>]*\/>|<mergeCells[^>]*>[\s\S]*?<\/mergeCells>/g, "")
    if (cleaned !== xml) zip.file(sheet.name, cleaned)
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }))
}

/** Flatten an exceljs workbook buffer to tab-separated rows, sheet by sheet. */
async function extractXlsx(buffer: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default
  let workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch (err) {
    // Retry once with merges stripped (the Numbers-export failure). Any error on
    // the retry path rethrows the ORIGINAL error — it names the real problem.
    let cleaned: Buffer
    try {
      cleaned = await stripMergeCells(buffer)
    } catch {
      throw err
    }
    workbook = new ExcelJS.Workbook()
    try {
      await workbook.xlsx.load(cleaned as unknown as ArrayBuffer)
    } catch {
      throw err
    }
  }
  const parts: string[] = []
  workbook.eachSheet((sheet) => {
    const rows: string[] = []
    sheet.eachRow((row) => {
      // row.values is 1-indexed (index 0 is unused); join non-empty cells with tabs.
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(values.map((v) => (v == null ? "" : String(typeof v === "object" && "text" in (v as object) ? (v as { text: unknown }).text : v))).join("\t"))
    })
    if (rows.length > 0) parts.push(`--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`)
  })
  return parts.join("\n\n")
}

/** Extract docx raw text via mammoth. */
async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = (await import("mammoth")).default
  const result = await mammoth.extractRawText({ buffer })
  return result.value ?? ""
}

/**
 * Decode the text-like entries of a zip (jszip). Each decoded entry is labeled;
 * binary entries are listed by name only. The per-entry text is itself capped so
 * one huge member can't blow the whole budget; the caller caps the total again.
 */
async function extractZip(buffer: Buffer, perEntryCap: number): Promise<string> {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buffer)
  const decoded: string[] = []
  const binaryNames: string[] = []
  // Object.values keeps insertion (archive) order; sort for stable output in tests.
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.dir) continue
    const lower = entry.name.toLowerCase()
    const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
    if (ZIP_TEXT_EXTENSIONS.has(ext)) {
      const content = await entry.async("string")
      decoded.push(`--- ${entry.name} ---\n${capText(content, perEntryCap)}`)
    } else {
      binaryNames.push(entry.name)
    }
  }
  const sections: string[] = []
  if (decoded.length > 0) sections.push(decoded.join("\n\n"))
  if (binaryNames.length > 0) sections.push(`[Other files in archive — not text, not read: ${binaryNames.join(", ")}]`)
  return sections.join("\n\n")
}

/**
 * Extract plain text from a downloaded file buffer by kind. Returns the (uncapped)
 * text; the caller applies SLACK_FILE_TEXT_CHAR_CAP. For "pdf" the returned text is
 * the pdf-parse text layer, which is empty for a scanned/image-only PDF — the
 * caller treats an empty/near-empty result as "send the PDF as a document block".
 * For "image"/"unsupported" this throws (caller routes those elsewhere / skips).
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  kind: SlackFileKind,
  perEntryCap: number = SLACK_FILE_TEXT_CHAR_CAP,
): Promise<string> {
  switch (kind) {
    case "text":
      return buffer.toString("utf-8")
    case "pdf": {
      // Dynamic import of pdf-parse v1 (CommonJS) — import the lib file directly to
      // avoid index.js loading a bundled test PDF (same idiom as bank-statement-parser).
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (
        buf: Buffer,
      ) => Promise<{ text: string; numpages: number }>
      const data = await pdfParse(buffer)
      return data.text ?? ""
    }
    case "xlsx":
      return extractXlsx(buffer)
    case "docx":
      return extractDocx(buffer)
    case "zip":
      return extractZip(buffer, perEntryCap)
    default:
      throw new Error(`extractTextFromBuffer: unsupported kind "${kind}"`)
  }
}
