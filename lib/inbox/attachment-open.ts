/**
 * Gmail attachment opening — type resolution.
 *
 * WHY THIS EXISTS (do not "simplify" the chips back to `<a href target=_blank>`):
 * Gmail's `attachmentId` is a ~400-character opaque token. Carried in the query
 * string of a TOP-LEVEL (document) navigation, the request is rejected at the
 * platform edge with a **503 before it ever reaches our route**. Verified in
 * production 2026-07-14 (Alessio Casula thread, dev_task 62ca1b5a):
 *   - authed navigation, long token  -> 503, absent from the function logs,
 *     and NOT a firewall denial (0 denied / 0 challenged, bot protection off)
 *   - authed navigation, SHORT token -> 500 (i.e. it DOES reach the route)
 *   - authed same-origin fetch, same long token -> 200 + bytes, every time
 * So the fix is to fetch the bytes (the path that works) and open them from a
 * blob. Short-path download links elsewhere (`/api/invoices/<id>/pdf`, …) carry
 * no long token and are unaffected — they were deliberately left alone.
 *
 * SECURITY — why `inline` is an allow-list, not "anything the browser can show":
 * anyone can email support@, so an attachment is attacker-controlled content.
 * A blob: URL inherits OUR origin, so opening an SVG or an HTML attachment in a
 * tab would execute the attacker's script as us. Only formats that cannot script
 * our origin may render inline (PDF renders in the browser's own viewer; raster
 * images cannot script). Everything else — svg, html, xml, office docs, archives
 * — is downloaded instead. NEVER add a scriptable type to INLINE_SAFE.
 */

/** Types a sender may declare that tell us nothing — fall back to the filename. */
const GENERIC_MIME = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'application/force-download',
])

/** Filename extension -> real MIME, used when the declared type is generic. */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  // Deliberately mapped but NOT inline-safe (see INLINE_SAFE): they script.
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * Formats safe to render in a tab from a blob: URL on our own origin.
 * PDF -> the browser's sandboxed PDF viewer. Raster images -> cannot script.
 * SVG / HTML / XML are intentionally absent — they would be same-origin XSS.
 */
const INLINE_SAFE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
])

export interface ResolvedAttachment {
  /** MIME type to hand the browser (corrected when the sender's type is generic). */
  type: string
  /** true -> may be rendered in a tab; false -> must be downloaded. */
  inline: boolean
}

/** Lowercased extension of a filename, or "" when there isn't one. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Decide what type to open a Gmail attachment as, and whether it may render
 * inline. Trusts the sender's declared type unless it is generic (mail clients
 * very often send a PDF as `application/octet-stream` — Alessio's signed PDFs
 * did exactly that), in which case the filename extension decides.
 */
export function resolveAttachmentType(
  filename: string,
  serverMime?: string | null,
): ResolvedAttachment {
  // Drop any parameters: "text/plain; charset=utf-8" -> "text/plain".
  const declared = (serverMime || '').split(';')[0].trim().toLowerCase()

  const type = GENERIC_MIME.has(declared)
    ? EXT_MIME[extensionOf(filename)] || 'application/octet-stream'
    : declared

  return { type, inline: INLINE_SAFE.has(type) }
}

/**
 * Above this, do not try to render the file in a tab — hand it to the browser as
 * a download instead. Gmail caps attachments at ~25 MB, so this is a backstop
 * against a pathological file eating the tab's memory, not a routine path.
 */
export const MAX_INLINE_BYTES = 40 * 1024 * 1024

/**
 * Decide whether to VIEW the attachment in a tab or DOWNLOAD it.
 *
 * `standalone` is the installed-PWA case (Antonio runs the whole CRM as a phone
 * app). A standalone window very often refuses to open a new tab at all, so the
 * old code's `window.open` could silently do nothing there. We do not gamble on
 * it: in standalone we ALWAYS download, which works everywhere. That removes the
 * one path this fix could not be tested on directly.
 */
export function shouldOpenInTab(opts: {
  /** From resolveAttachmentType — false for anything that could script us. */
  inline: boolean
  /** Running as an installed app (display-mode: standalone). */
  standalone: boolean
  /** Byte size; Gmail sometimes reports 0 = unknown, which must not block. */
  size: number
}): boolean {
  if (!opts.inline) return false
  if (opts.standalone) return false
  if (opts.size > MAX_INLINE_BYTES) return false
  return true
}
