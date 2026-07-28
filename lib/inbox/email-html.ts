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

/** Input cap for the plain-text/snippet strippers. Marketing emails routinely
 *  carry multi-MB HTML; regex work on that per collapsed card per render would
 *  jank the thread. A snippet needs only the leading content. */
const STRIP_INPUT_CAP = 20_000

/**
 * Pure HTML → plain text for previews. Removes <style>/<script>/<head>
 * CONTENT (not just the tags — a naive tag-strip turns a styled newsletter
 * into `body{margin:0}…`), strips remaining tags, decodes entities, and
 * collapses whitespace. Pure string work (no DOM) so it is unit-testable and
 * safe on the server. NOT a sanitizer — output must be rendered as a text
 * node only, never dangerouslySetInnerHTML.
 *
 * (The Share-to-team flow keeps its own DOM-based stripper in inbox-shell —
 * shipped behavior, deliberately untouched; this one exists for snippets.)
 */
export function htmlToPlainText(html: string): string {
  if (!html) return ""
  return decodeHtmlEntities(
    html
      .slice(0, STRIP_INPUT_CAP)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    // inline tags were replaced with spaces — don't leave "Antonio ," behind
    .replace(/ ([.,;:!?])/g, "$1")
    .trim()
}

/**
 * One-line preview of an email body for a collapsed thread card (Gmail-style).
 * `isHtml` mirrors the renderer's branch: real MIME type when the server sent
 * it, content sniff as fallback for cached payloads.
 */
export function emailSnippet(
  content: string,
  isHtml: boolean | undefined,
  maxLen = 140
): string {
  if (!content) return ""
  const html = isHtml ?? (content.includes("<") && content.includes(">"))
  const text = html
    ? htmlToPlainText(content)
    : content.slice(0, STRIP_INPUT_CAP).replace(/\s+/g, " ").trim()
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text
}

/**
 * Safe ISO date for an email message. A hostile/spam sender can put anything
 * in the Date header (`Date: Never`) — `new Date(bad).toISOString()` THROWS,
 * and one such message must not 500 the whole thread. Falls back to Gmail's
 * server-stamped internalDate (epoch ms as a string), then to epoch 0.
 */
export function safeEmailDate(
  dateHeader: string | undefined | null,
  internalDate: string | undefined | null
): string {
  if (dateHeader) {
    const d = new Date(dateHeader)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  const ms = parseInt(internalDate || "", 10)
  if (!isNaN(ms)) {
    const d = new Date(ms)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return new Date(0).toISOString()
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
