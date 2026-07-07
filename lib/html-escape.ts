/**
 * HTML escaping + email-HTML sanitization helpers.
 *
 * Two distinct jobs:
 *  - `escapeHtml`        : turn untrusted PLAIN TEXT into safe HTML text. Use
 *                          when interpolating a user/client value into an HTML
 *                          template (e.g. a name or message in an outgoing
 *                          email body). Escapes & < > " '.
 *  - `sanitizeEmailHtml` : neutralize EXECUTABLE content in untrusted HTML that
 *                          we still want to render with formatting (e.g. raw
 *                          inbound email HTML shown in the admin inbox). Removes
 *                          script/style/iframe/etc. blocks, inline event-handler
 *                          attributes, and javascript:/vbscript:/data: URLs,
 *                          while preserving normal formatting tags.
 *
 * Both are pure strings (no DOM) so they run on server AND client and stay
 * unit-testable under the node vitest environment.
 *
 * NOTE: `sanitizeEmailHtml` is a conservative regex-based sanitizer, NOT a full
 * DOM-parsing sanitizer (DOMPurify). It removes the common script-execution
 * vectors and is the pragmatic mitigation while no DOM sanitizer dependency
 * exists in the repo. Security audit 2026-06-13 (H8/H9).
 */

/** Escape the 5 HTML-significant characters. Safe for text and attribute contexts. */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Sanitize untrusted HTML for display while keeping basic formatting.
 * Strips:
 *  - whole dangerous element blocks (script/style/iframe/object/embed/…)
 *  - dangerous void / self-closing tags (link/meta/base/input/…)
 *  - inline event-handler attributes (onclick, onerror, onload, …)
 *  - javascript:/vbscript:/data: URLs in href/src/xlink:href
 *  - style attributes containing expression()/javascript:
 */
export function sanitizeEmailHtml(html: unknown): string {
  let out = String(html ?? '')
  if (!out) return ''

  // 1. Remove entire dangerous element blocks (open tag → matching close),
  //    case-insensitive, spanning newlines.
  out = out.replace(
    /<\s*(script|style|iframe|object|embed|noscript|template|svg|math|form|frame|frameset|applet)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
    '',
  )

  // 2. Remove remaining dangerous tags that may be unclosed / self-closing,
  //    plus risky void / interactive tags.
  out = out.replace(
    /<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math|frame|frameset|applet|input|button|textarea|select|option)\b[^>]*>/gi,
    '',
  )

  // 3. Strip inline event-handler attributes (on*=). Quoted and unquoted.
  out = out.replace(/\son[a-z0-9_-]+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
  out = out.replace(/\son[a-z0-9_-]+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '')
  out = out.replace(/\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '')

  // 4. Neutralize dangerous URL schemes in link/resource attributes.
  //    href/xlink:href: javascript:/vbscript:/data: are ALL blocked (a link must
  //    never navigate to script or a data: document).
  out = out.replace(
    /(href|xlink:href)\s*=\s*"(?:\s*(?:javascript|vbscript|data)\s*:)[^"]*"/gi,
    '$1="#"',
  )
  out = out.replace(
    /(href|xlink:href)\s*=\s*'(?:\s*(?:javascript|vbscript|data)\s*:)[^']*'/gi,
    "$1='#'",
  )
  //    src: javascript:/vbscript: blocked; data: blocked EXCEPT data:image/*
  //    (emails legitimately embed images as data URIs — an image payload cannot
  //    execute; data:text/html and friends stay blocked).
  out = out.replace(
    /(src)\s*=\s*"(?:\s*(?:javascript|vbscript)\s*:)[^"]*"/gi,
    '$1="#"',
  )
  out = out.replace(
    /(src)\s*=\s*'(?:\s*(?:javascript|vbscript)\s*:)[^']*'/gi,
    "$1='#'",
  )
  out = out.replace(
    /(src)\s*=\s*"\s*data\s*:(?!\s*image\/)[^"]*"/gi,
    '$1="#"',
  )
  out = out.replace(
    /(src)\s*=\s*'\s*data\s*:(?!\s*image\/)[^']*'/gi,
    "$1='#'",
  )

  // 5. Remove style attributes that try to smuggle script/expression.
  out = out.replace(/\sstyle\s*=\s*"[^"]*(?:expression|javascript:)[^"]*"/gi, '')
  out = out.replace(/\sstyle\s*=\s*'[^']*(?:expression|javascript:)[^']*'/gi, '')

  return out
}
