/**
 * Email HTML helpers for the dashboard inbox.
 *
 * `rewriteCidSources` — inline images in email HTML are referenced as
 * `src="cid:<Content-ID>"` and shipped as MIME parts. Gmail's own UI resolves
 * them; a browser cannot. This rewrites every cid: reference to a resolvable
 * URL (our attachment-download endpoint). Unresolvable cids are left as-is so
 * the sanitizer/browser handles them like any other broken image.
 */

/**
 * Decode HTML entities in Gmail snippets for PLAIN-TEXT display. Gmail's
 * `snippet` field is entity-encoded (&#39; &amp; …); rendering it as text
 * shows the entities literally. Numeric entities first; &amp; LAST so
 * double-encoded input can't double-decode. Output is rendered as text
 * (never dangerouslySetInnerHTML), so decoding is safe.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return text
  return text
    .replace(/&#(\d+);/g, (full, n: string) => {
      const code = parseInt(n, 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
    })
    .replace(/&#x([0-9a-f]+);/gi, (full, h: string) => {
      const code = parseInt(h, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/**
 * Human display name from a From/To header: strips the <email> part and the
 * RFC 2822 surrounding quotes ("Tamás Fazekas" <t@x.com> → Tamás Fazekas).
 */
export function displayNameFromHeader(headerValue: string): string {
  return (headerValue || "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim()
}

export function rewriteCidSources(
  html: string,
  resolve: (contentId: string) => string | null
): string {
  if (!html) return html

  // Quoted: src="cid:xxx" or src='cid:xxx'
  let out = html.replace(
    /(src\s*=\s*)(["'])\s*cid:([^"']+)\2/gi,
    (full, prefix: string, quote: string, cid: string) => {
      const url = resolve(cid.trim())
      return url ? `${prefix}${quote}${url}${quote}` : full
    }
  )

  // Unquoted: src=cid:xxx
  out = out.replace(
    /(src\s*=\s*)cid:([^\s>"']+)/gi,
    (full, prefix: string, cid: string) => {
      const url = resolve(cid.trim())
      return url ? `${prefix}"${url}"` : full
    }
  )

  return out
}
