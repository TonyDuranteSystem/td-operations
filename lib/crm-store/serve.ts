/**
 * Response headers for serving a stored file to STAFF inside the CRM (job 685467b5). The stored content
 * type comes from whoever uploaded the file (a browser, a client's wizard upload), so it is untrusted:
 * only types that cannot run script on our origin are shown inline; everything else downloads as bytes.
 * SVG is deliberately NOT inline (it can carry script). nosniff stops the browser second-guessing.
 */
export const INLINE_SAFE_TYPES = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "text/plain",
])

export function staffFileHeaders(mimeType: string | null | undefined, fileName: string): Record<string, string> {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  const inline = INLINE_SAFE_TYPES.has(mime)
  const name = encodeURIComponent(fileName || "document")
  return {
    "Content-Type": inline ? (mime === "text/plain" ? "text/plain; charset=utf-8" : mime) : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  }
}

/** Whether the in-CRM preview can show this type (else it offers a download). */
export function canPreviewInline(mimeType: string | null | undefined): boolean {
  return INLINE_SAFE_TYPES.has((mimeType ?? "").split(";")[0].trim().toLowerCase())
}
