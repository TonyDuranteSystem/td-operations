/**
 * Email HTML helpers for the dashboard inbox.
 *
 * `rewriteCidSources` — inline images in email HTML are referenced as
 * `src="cid:<Content-ID>"` and shipped as MIME parts. Gmail's own UI resolves
 * them; a browser cannot. This rewrites every cid: reference to a resolvable
 * URL (our attachment-download endpoint). Unresolvable cids are left as-is so
 * the sanitizer/browser handles them like any other broken image.
 */

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
