/**
 * SERVER-ONLY: the gate between a staff member's browser and a real client's inbox for formatted replies
 * (dev job bbc70ff8, step 2). Never import this from a client component — it pulls in `sanitize-html`; the
 * browser-safe half is lib/inbox/rich-text.ts.
 *
 * TRUST MODEL: the staff member's browser is NOT trusted to send safe HTML (the route accepts a partner login
 * too — requireStaffRoute lets a managed partner through). Everything that reaches the email goes through this
 * file: a strict ALLOW-LIST (not the inbound-mail blacklist in lib/html-escape.ts), then the server — not the
 * client — builds the plain-text half from the sanitized result and applies the spacing from four enums.
 *
 * What survives: p, br, strong, em, u, ul, ol, li, a (absolute http/https/mailto, never an internal host),
 * span carrying ONLY one of four hex colours, p carrying ONLY text-align center. Everything else — scripts,
 * images, tables, classes, ids, event handlers, other styles, other schemes — is removed (the words stay).
 */

import sanitizeHtml from 'sanitize-html'
import {
  RICH_COLORS,
  checkLinkHref,
  normalizeRichColor,
  parseRichStyle,
  restyleRichHtml,
  richHtmlToText,
  shouldSendRich,
  trimEmptyParagraphs,
  type RichStyle,
} from '@/lib/inbox/rich-text'

/** Raw HTML larger than this is refused before it is parsed (a pasted document, or an attack on the parser). */
export const RICH_HTML_MAX_CHARS = 100_000

const COLOR_RE = new RegExp(`^(${RICH_COLORS.join('|')})$`, 'i')

/**
 * The colour a span carries, normalised to one of the four allowed hex values — or null. A browser reports the same
 * colour as `rgb(37, 99, 235)` when the editor serialises its HTML (a real browser-QA catch: the hex-only rule
 * below silently stripped every colour), so both spellings are accepted HERE, once, and only the hex is emitted.
 * Only a declaration named exactly `color` counts (`background-color` does not).
 */
function spanColor(style: string | undefined): string | null {
  if (!style) return null
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    if (decl.slice(0, i).trim().toLowerCase() === 'color') return normalizeRichColor(decl.slice(i + 1))
  }
  return null
}

/** Run the allow-list. Output is well-formed, entity-escaped HTML made only of the tags above. */
export function sanitizeRichHtml(raw: string): string {
  return sanitizeHtml(raw, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a', 'span'],
    allowedAttributes: {
      a: ['href'],
      p: ['style'],
      span: ['style'],
    },
    allowedStyles: {
      span: { color: [COLOR_RE] },
      p: { 'text-align': [/^center$/i] },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    // Unknown tags are discarded but their words are kept; script/style/etc. lose their content too.
    disallowedTagsMode: 'discard',
    transformTags: {
      b: 'strong',
      i: 'em',
      span: (_tagName, attribs) => {
        const color = spanColor(attribs.style)
        return { tagName: 'span', attribs: color ? { style: `color:${color}` } : {} }
      },
      a: (_tagName, attribs) => {
        const check = checkLinkHref(attribs.href)
        // A link the rule refuses (internal address, odd scheme…) keeps its words and loses the link.
        return check.ok ? { tagName: 'a', attribs: { href: check.href } } : { tagName: 'span', attribs: {} }
      },
    },
  })
}

export interface ResolvedReplyBody {
  ok: true
  /** The text the email's plain half carries — and what every guard (empty, [blank]) must look at. */
  text: string
  /** Present only when the email is genuinely formatted; absent means "take today's plain path unchanged". */
  rich: { html: string; style: RichStyle } | null
}
export interface RejectedReplyBody {
  ok: false
  error: string
}

/**
 * The ONE place a reply/draft route turns the request's body fields into what it sends.
 *  - No `messageHtml` -> exactly today's behaviour: `message` is the text, no HTML part override.
 *  - `messageHtml` present -> sanitize, derive the text FROM the sanitized html (the client's own `message` is
 *    ignored, so the two MIME halves can never disagree), refuse an empty result, and decide plain-vs-formatted
 *    from the sanitized result — never from a client flag.
 */
export function resolveReplyBody(input: {
  message?: unknown
  messageHtml?: unknown
  style?: unknown
}): ResolvedReplyBody | RejectedReplyBody {
  if (input.messageHtml === undefined || input.messageHtml === null) {
    return { ok: true, text: typeof input.message === 'string' ? input.message : '', rich: null }
  }
  if (typeof input.messageHtml !== 'string') return { ok: false, error: 'The formatted message is not valid.' }
  if (input.messageHtml.length > RICH_HTML_MAX_CHARS) {
    return { ok: false, error: 'This message is too long to send with formatting. Shorten it or remove the formatting.' }
  }
  const clean = trimEmptyParagraphs(sanitizeRichHtml(input.messageHtml))
  const text = richHtmlToText(clean)
  if (!text.trim()) return { ok: false, error: 'The message is empty.' }
  const style = parseRichStyle(input.style)
  if (!shouldSendRich(clean, style)) return { ok: true, text, rich: null }
  return { ok: true, text, rich: { html: restyleRichHtml(clean, style), style } }
}
