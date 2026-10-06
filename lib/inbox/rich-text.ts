/**
 * Rich-text replies — the pure, dependency-free half (dev job bbc70ff8, step 2, Antonio 2026-10-06:
 * "I want also the tool writing, change font / bold / interspace etc.").
 *
 * WHY THIS FILE IS DEPENDENCY-FREE: the SAME functions run in the browser (to mirror the editor into the plain
 * text every guard reads) AND on the server (to build the text/plain half of the email from the SANITIZED html).
 * One implementation means the two can never disagree about what an email says — a disagreement would let the
 * [blank] guard pass on the client and 400 on the server, or ship an email whose plain half says something its
 * HTML half does not. The server-only sanitizer lives in rich-text-sanitize.ts (it needs `sanitize-html`).
 *
 * THE MODEL (decided with the council, 2026-10-06):
 *  - Message-level STYLE — font, size, line spacing, paragraph spacing — is four small enums applied to the whole
 *    email by the SERVER. The client's HTML never carries line-height / margins / fonts, so it cannot smuggle any.
 *  - Per-selection formatting is only what the editor schema can emit and the server allows: bold, italic,
 *    underline, links, bullet/numbered lists, four colours, left/centre alignment.
 *  - The plain half of a formatted email is built FROM the formatted content (bullets, numbers, links as
 *    "text (url)"): every machine reader of mail here (AI features, Forward, the worker, quoting) reads text/plain
 *    first, so a stripped copy would silently lose the lists and links.
 */

// ─── Allowed values (the editor, the server and the tests all import these) ──────────────────────────────────

/** Fonts every mail app already has, so the recipient sees the one chosen. */
export const RICH_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Courier New'] as const
export type RichFont = (typeof RICH_FONTS)[number]

export const RICH_FONT_STACKS: Record<RichFont, string> = {
  Arial: 'Arial,Helvetica,sans-serif',
  Georgia: 'Georgia,serif',
  // Single quotes around multi-word names: these stacks go inside a double-quoted style="…" attribute.
  'Times New Roman': "'Times New Roman',Times,serif",
  Verdana: 'Verdana,Geneva,sans-serif',
  'Trebuchet MS': "'Trebuchet MS',Helvetica,sans-serif",
  Tahoma: 'Tahoma,Geneva,sans-serif',
  'Courier New': "'Courier New',Courier,monospace",
}

export const RICH_SIZES = { small: 12, normal: 14, large: 18, huge: 24 } as const
export const RICH_LINES = { tight: 1.2, normal: 1.5, airy: 1.8, double: 2.1 } as const
// Extra space BETWEEN paragraphs. The default is none: a blank line typed in the editor is one blank paragraph, exactly
// as the plain email has always been sent, so what is typed is what arrives. The gap is for people who want air.
export const RICH_PARAS = { none: 0, small: 6, medium: 12, large: 18 } as const

/** Four calm colours. Hex only, lower-case: the server compares against exactly these. */
export const RICH_COLORS = ['#1f2937', '#2563eb', '#b91c1c', '#15803d'] as const
export type RichColor = (typeof RICH_COLORS)[number]

// Left is the default, so it is never stored: "Align left" simply removes the centring.
export const RICH_ALIGNMENTS = ['center'] as const

export interface RichStyle {
  font: RichFont
  size: keyof typeof RICH_SIZES
  line: keyof typeof RICH_LINES
  para: keyof typeof RICH_PARAS
}

export const DEFAULT_RICH_STYLE: RichStyle = { font: 'Arial', size: 'normal', line: 'normal', para: 'none' }

/** Validate a client-supplied style field by field; anything unknown falls back to the default for that field. */
export function parseRichStyle(value: unknown): RichStyle {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const pick = <T extends string>(x: unknown, allowed: readonly T[], fallback: T): T =>
    typeof x === 'string' && (allowed as readonly string[]).includes(x) ? (x as T) : fallback
  return {
    font: pick(v.font, RICH_FONTS, DEFAULT_RICH_STYLE.font),
    size: pick(v.size, Object.keys(RICH_SIZES) as Array<keyof typeof RICH_SIZES>, DEFAULT_RICH_STYLE.size),
    line: pick(v.line, Object.keys(RICH_LINES) as Array<keyof typeof RICH_LINES>, DEFAULT_RICH_STYLE.line),
    para: pick(v.para, Object.keys(RICH_PARAS) as Array<keyof typeof RICH_PARAS>, DEFAULT_RICH_STYLE.para),
  }
}

export function isDefaultRichStyle(style: RichStyle): boolean {
  return (
    style.font === DEFAULT_RICH_STYLE.font &&
    style.size === DEFAULT_RICH_STYLE.size &&
    style.line === DEFAULT_RICH_STYLE.line &&
    style.para === DEFAULT_RICH_STYLE.para
  )
}

// ─── Links ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hosts a client must never be sent (CLAUDE.md R005: the internal domain; R012: client links come from APP_BASE_URL).
 * A free-form link tool makes pasting one easy, and no other guard covers typed links.
 */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.vercel.app') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === '[::1]' ||
    h === '::1' ||
    h === '0.0.0.0'
  )
}

export type LinkCheck = { ok: true; href: string } | { ok: false; reason: string }

/** The single link rule, used by the editor's link tool AND the server sanitizer. Absolute http/https/mailto only. */
export function checkLinkHref(raw: unknown): LinkCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'That is not a web address.' }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2000) return { ok: false, reason: 'That is not a web address.' }
  if (/^mailto:/i.test(trimmed)) {
    const addr = trimmed.slice(7).split('?')[0]
    return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(addr)
      ? { ok: true, href: `mailto:${addr}` }
      : { ok: false, reason: 'That email address does not look right.' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'Start the address with https:// so it is a complete web address.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only web (http/https) and email (mailto:) links can be sent.' }
  }
  if (url.username || url.password) return { ok: false, reason: 'Links with a login in them cannot be sent.' }
  if (isInternalHost(url.hostname)) {
    return { ok: false, reason: 'Links to our internal address cannot be sent to clients.' }
  }
  return { ok: true, href: url.toString() }
}

/**
 * What a person types into the link box -> the string checkLinkHref judges. People type "example.com" or
 * "tony@x.com" without a scheme; a bare domain gets https://, a bare address gets mailto:. Anything that already
 * names a scheme is passed through untouched, so "javascript:..." still reaches the rule and is refused there.
 */
export function normalizeLinkInput(raw: string): string {
  const v = raw.trim()
  // "example.com:8080/x" is a host and port, not a scheme.
  if (!v || /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(v)) return v
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return `mailto:${v}`
  return `https://${v}`
}

/**
 * A colour as a browser reports it (`rgb(37, 99, 235)`, `#2563EB`) -> one of the four allowed hex values, or null.
 * Used when text is PASTED into the editor: only our four colours survive, anything else loses its colour.
 */
export function normalizeRichColor(raw: string | null | undefined): RichColor | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  let hex = v
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*1(?:\.0+)?\s*)?\)$/.exec(v)
  if (m) {
    const parts = [m[1], m[2], m[3]].map((n) => Number(n))
    if (parts.some((n) => n > 255)) return null
    hex = '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('')
  }
  return (RICH_COLORS as readonly string[]).includes(hex) ? (hex as RichColor) : null
}

// ─── Tokenizer for the restricted HTML (editor output / sanitized output) ─────────────────────────────────

export type RichToken =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; tag: string }

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g
const ATTR_RE = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Decode HTML entities EXACTLY ONCE — "&amp;lt;" is the literal text "&lt;", never "<". */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      const ch = String.fromCodePoint(code)
      return ch === ' ' ? ' ' : ch
    }
    const mapped = NAMED[body.toLowerCase()]
    return mapped === undefined ? whole : mapped
  })
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;')
}

/** Split restricted HTML into tokens. Comments, doctype and processing instructions are dropped. */
export function tokenizeRichHtml(html: string): RichToken[] {
  const tokens: RichToken[] = []
  const src = html.replace(/<!--[\s\S]*?-->/g, '')
  let last = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(src))) {
    if (m.index > last) tokens.push({ kind: 'text', text: src.slice(last, m.index) })
    const tag = m[2].toLowerCase()
    if (m[1]) {
      tokens.push({ kind: 'close', tag })
    } else {
      const attrs: Record<string, string> = {}
      ATTR_RE.lastIndex = 0
      let a: RegExpExecArray | null
      while ((a = ATTR_RE.exec(m[3]))) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
      tokens.push({ kind: 'open', tag, attrs, selfClosing: !!m[4] || tag === 'br' })
    }
    last = TAG_RE.lastIndex
  }
  if (last < src.length) tokens.push({ kind: 'text', text: src.slice(last) })
  return tokens
}

// Zero-width space, word joiner and byte-order mark only. The zero-width JOINER / NON-JOINER are real characters
// (emoji sequences such as a person + laptop, and several scripts) and must survive.
const INVISIBLE = /[\u200B\u2060\uFEFF]/g

// ─── Plain text <-> HTML ─────────────────────────────────────────────────────────────────────────────────

/**
 * Plain text -> the editor's HTML: one paragraph per line, an empty line is an empty paragraph. Escaped, so text
 * that merely LOOKS like markup ("Form 5472 <Form>") is kept as text, never parsed as a tag.
 * Round trip: richHtmlToText(textToHtml(t)) === t (CRLF normalised to LF).
 */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeText(line)}</p>`)
    .join('')
}

/**
 * Restricted HTML -> plain text. THE one rule for how a formatted email reads as text/plain:
 *  - one line per paragraph, an empty paragraph is a blank line (matches the old textarea: Enter = "\n")
 *  - <br> is a line break
 *  - bullet items start "• ", numbered items "1. ", "2. " …; nested lists indent two spaces per level
 *  - a link reads "words (address)" — "click here" must not lose its address — unless the words ARE the address
 *  - an EMPTY list item is dropped (it must never make a blank email look non-empty)
 *  - invisible characters (zero-width space etc.) are removed
 */
export function richHtmlToText(html: string): string {
  const out: string[] = []
  let line = ''
  let hasText = false
  const lists: Array<{ ordered: boolean; n: number }> = []
  let liPrefix: string | null = null
  const anchors: Array<{ href: string; start: number }> = []
  let blockOpen = false

  const flush = (force: boolean) => {
    if (liPrefix !== null) {
      if (hasText) out.push(liPrefix + line)
      liPrefix = null
    } else if (force || hasText || line.length > 0) {
      out.push(line)
    }
    line = ''
    hasText = false
  }

  for (const t of tokenizeRichHtml(html)) {
    if (t.kind === 'text') {
      const s = decodeEntities(t.text).replace(INVISIBLE, '').replace(/\r?\n/g, '')
      if (s) {
        line += s
        if (s.trim()) hasText = true
      }
      continue
    }
    if (t.kind === 'open') {
      if (t.tag === 'p') {
        if (liPrefix === null) {
          if (blockOpen || line) flush(true)
          blockOpen = true
        } else if (hasText) {
          line += ' '
        }
      } else if (t.tag === 'br') {
        if (liPrefix !== null) {
          // A line break inside a list item: the item continues on the next line, lined up under its text.
          if (hasText) out.push(liPrefix + line)
          liPrefix = ' '.repeat(liPrefix.length)
          line = ''
          hasText = false
        } else {
          out.push(line)
          line = ''
          hasText = false
        }
      } else if (t.tag === 'ul' || t.tag === 'ol') {
        if (liPrefix !== null) flush(false)
        else if (line) flush(true)
        lists.push({ ordered: t.tag === 'ol', n: 0 })
      } else if (t.tag === 'li') {
        if (liPrefix !== null) flush(false)
        const top = lists[lists.length - 1]
        if (top) top.n += 1
        const indent = '  '.repeat(Math.max(0, lists.length - 1))
        liPrefix = top?.ordered ? `${indent}${top.n}. ` : `${indent}• `
        line = ''
        hasText = false
      } else if (t.tag === 'a') {
        anchors.push({ href: t.attrs.href ?? '', start: line.length })
      }
      continue
    }
    // close
    if (t.tag === 'p') {
      if (liPrefix === null) {
        flush(true)
        blockOpen = false
      }
    } else if (t.tag === 'li') {
      flush(false)
    } else if (t.tag === 'ul' || t.tag === 'ol') {
      if (liPrefix !== null) flush(false)
      lists.pop()
    } else if (t.tag === 'a') {
      const a = anchors.pop()
      if (a && a.href) {
        const words = line.slice(a.start).trim()
        const bare = a.href.replace(/^mailto:/i, '')
        if (words && words !== a.href && words !== bare && words.replace(/\/$/, '') !== a.href.replace(/\/$/, '')) {
          line += ` (${bare})`
        }
      }
    }
  }
  if (liPrefix !== null || line || hasText) flush(false)
  return out.join('\n')
}

// ─── What counts as "formatted" ─────────────────────────────────────────────────────────────────────────

/**
 * Does this editor HTML carry anything beyond plain paragraphs and line breaks? Decided from the HTML ITSELF, never
 * from a UI flag, so a list, a link or a centred line can never be silently dropped onto the old plain path.
 * Plain paragraphs go out EXACTLY as before (text only, byte-identical MIME).
 */
export function hasRichFormatting(html: string): boolean {
  for (const t of tokenizeRichHtml(html)) {
    if (t.kind === 'open' && t.tag !== 'p' && t.tag !== 'br') return true
    if (t.kind === 'open' && t.tag === 'p' && (t.attrs.style || t.attrs.class)) return true
  }
  return false
}

/** Inline formatting only the editor can restore word-by-word (bold, links, lists, colours, alignment). */
export function hasInlineFormatting(html: string): boolean {
  return hasRichFormatting(html)
}

/** Should this draft take the formatted send path (HTML part built by the server)? */
export function shouldSendRich(html: string, style: RichStyle): boolean {
  return hasRichFormatting(html) || !isDefaultRichStyle(style)
}

// ─── Restyle sanitized html for sending (server applies the style from enums) ────────────────────────────

/**
 * Remove list items that hold no words (a trailing Enter in a list leaves one), and any list left with no items — the
 * same rule richHtmlToText applies to the plain half, so the two halves of the email cannot disagree about a bullet.
 */
function dropEmptyListItems(tokens: RichToken[]): RichToken[] {
  const drop = new Set<number>()
  const items: Array<{ start: number; text: boolean }> = []
  const lists: Array<{ start: number; kept: boolean }> = []
  tokens.forEach((t, i) => {
    if (t.kind === 'text') {
      if (t.text.replace(INVISIBLE, '').trim()) items.forEach((it) => { it.text = true })
    } else if (t.kind === 'open' && (t.tag === 'ul' || t.tag === 'ol')) lists.push({ start: i, kept: false })
    else if (t.kind === 'open' && t.tag === 'li') items.push({ start: i, text: false })
    else if (t.kind === 'close' && t.tag === 'li') {
      const it = items.pop()
      if (!it) return
      if (it.text) {
        const l = lists[lists.length - 1]
        if (l) l.kept = true
      } else for (let j = it.start; j <= i; j++) drop.add(j)
    } else if (t.kind === 'close' && (t.tag === 'ul' || t.tag === 'ol')) {
      const l = lists.pop()
      if (l && !l.kept) for (let j = l.start; j <= i; j++) drop.add(j)
    }
  })
  return drop.size ? tokens.filter((_, i) => !drop.has(i)) : tokens
}

/** Leading and trailing empty paragraphs are not part of the message (a stray Enter at either end). */
export function trimEmptyParagraphs(html: string): string {
  const empty = '<p(?:\\s[^>]*)?>\\s*(?:<br\\s*/?>\\s*)?</p>'
  return html.replace(new RegExp(`^(?:\\s*${empty})+`, 'i'), '').replace(new RegExp(`(?:${empty}\\s*)+$`, 'i'), '')
}

/**
 * Re-emit already-SANITIZED html with the message-level spacing applied as ONE style attribute per element:
 *  - <p>: margin-bottom from `para`, line-height from `line`, merged with a centre/left alignment already there
 *  - a <p> directly inside an <li> gets margin 0 (it would otherwise double-space every list item)
 *  - <ul>/<ol>: bottom margin and left padding
 *  - an EMPTY <p> becomes <p><br /></p>, so a blank line survives in mail apps (an empty <p> renders zero-height)
 * Works on the sanitizer's output, which is well-formed by construction.
 */
export function restyleRichHtml(html: string, style: RichStyle): string {
  const para = RICH_PARAS[style.para]
  const line = RICH_LINES[style.line]
  const out: string[] = []
  const stack: string[] = []
  let pHasContent = false
  const tokens = dropEmptyListItems(tokenizeRichHtml(html))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'text') {
      const s = t.text.replace(INVISIBLE, '')
      if (s) {
        out.push(s)
        if (stack.includes('p') && s.trim()) pHasContent = true
      }
      continue
    }
    if (t.kind === 'open') {
      if (t.tag === 'p') {
        const inLi = stack[stack.length - 1] === 'li'
        const parts: string[] = []
        const align = /text-align\s*:\s*(left|center)/i.exec(t.attrs.style ?? '')
        if (align && align[1].toLowerCase() === 'center') parts.push('text-align:center')
        parts.push(`margin:0 0 ${inLi ? 0 : para}px 0`)
        parts.push(`line-height:${line}`)
        out.push(`<p style="${parts.join(';')}">`)
        stack.push('p')
        pHasContent = false
      } else if (t.tag === 'br') {
        // A <br> that ends a paragraph which already has words collapses to nothing in mail apps; the editor (and the
        // plain half) show it as a blank line, so it is written twice.
        const endsParagraph = stack[stack.length - 1] === 'p' && pHasContent && tokens[i + 1]?.kind === 'close' && (tokens[i + 1] as { tag: string }).tag === 'p'
        out.push(endsParagraph ? '<br /><br />' : '<br />')
        if (stack.includes('p')) pHasContent = true
      } else if (t.tag === 'ul' || t.tag === 'ol') {
        out.push(`<${t.tag} style="margin:0 0 ${para}px 0;padding-left:24px">`)
        stack.push(t.tag)
      } else if (t.tag === 'li') {
        out.push(`<li style="line-height:${line}">`)
        stack.push('li')
      } else if (t.tag === 'a') {
        out.push(`<a href="${escapeAttr(t.attrs.href ?? '')}" target="_blank" rel="noopener noreferrer">`)
        stack.push('a')
        if (stack[stack.length - 2] === 'p') pHasContent = true
      } else if (t.tag === 'span') {
        const color = /color\s*:\s*(#[0-9a-f]{6})/i.exec(t.attrs.style ?? '')
        out.push(color ? `<span style="color:${color[1].toLowerCase()}">` : '<span>')
        stack.push('span')
      } else if (t.tag === 'strong' || t.tag === 'em' || t.tag === 'u') {
        out.push(`<${t.tag}>`)
        stack.push(t.tag)
      }
      continue
    }
    // close
    if (t.tag === 'p') {
      if (!pHasContent) out.push('<br />')
      out.push('</p>')
      stack.pop()
    } else if (['ul', 'ol', 'li', 'a', 'span', 'strong', 'em', 'u'].includes(t.tag)) {
      out.push(`</${t.tag}>`)
      stack.pop()
    }
  }
  return out.join('')
}

/** The wrapper that carries the whole message's font/size, so the signature below it keeps its own look. */
export function richBodyOpenTag(style: RichStyle): string {
  return `<div style="font-family:${RICH_FONT_STACKS[style.font]};font-size:${RICH_SIZES[style.size]}px;line-height:${RICH_LINES[style.line]}">`
}
