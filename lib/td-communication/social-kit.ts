/**
 * TD Communication — Social Sharing Kit (Phase 15).
 *
 * Pure, side-effect-free logic for the CLIENT-FACING social kit:
 *   - BRANDED POST TEMPLATES (the net-new bit) — composed social posts using the
 *     client's brand colours + logo + optional short text, as inline SVG strings.
 *     The browser rasterises them (serialise → <canvas> → toBlob), exactly like
 *     the Phase 12 mockup previewer, so there is NO server image pipeline and no
 *     `sharp`.
 *   - Naming for the `posts/` folder inside the kit zip.
 *   - Upload validation for the released kit zip (zip-only, 100 MB), isolated from
 *     the Phase 12 design-asset validator so that path stays untouched.
 *
 * The logo-on-background social sizes + favicons + manifest come from the Phase 12
 * `asset-kit.ts` registry, reused as-is — this module only adds what Phase 12 did
 * not have (branded posts) plus the client-release naming/validation.
 *
 * SVG (not photoreal) on purpose: no binary assets to license, fully themeable
 * from the palette, native PNG export. For EXPORT the caller passes `logoHref` as
 * a data: URL (a cross-origin href would taint the canvas); a blob/object URL is
 * fine for live preview.
 *
 * No DB / no I/O — client-safe, unit-tested (R086).
 */

import { normalizeHex, bestTextColor } from './color-tools'
import { escapeXmlAttr } from './mockup-templates'
import { getExtension } from './deliverables'
import { kitSlug } from './asset-kit'

/* -------------------------------------------------------------------------- */
/* Formats                                                                     */
/* -------------------------------------------------------------------------- */

export interface PostFormat {
  id: string
  label: string
  width: number
  height: number
}

/** Output formats for a branded post. Square feed post + vertical story. */
export const POST_FORMATS: readonly PostFormat[] = [
  { id: 'post', label: 'Feed Post 1080×1080', width: 1080, height: 1080 },
  { id: 'story', label: 'Story 1080×1920', width: 1080, height: 1920 },
] as const

export function getPostFormat(id: string): PostFormat | undefined {
  return POST_FORMATS.find((f) => f.id === id)
}

/* -------------------------------------------------------------------------- */
/* Template registry                                                           */
/* -------------------------------------------------------------------------- */

export type PostTemplateId = 'announcement' | 'tagline' | 'launch'

export interface PostTemplate {
  id: PostTemplateId
  label: string
  /** Placeholder shown in the tool + used when the caller supplies no headline. */
  defaultHeadline: string
  /** Whether this template renders the optional subtext line. */
  usesSubtext: boolean
}

export const POST_TEMPLATES: readonly PostTemplate[] = [
  { id: 'announcement', label: 'Announcement', defaultHeadline: 'We have a new look', usesSubtext: true },
  { id: 'tagline', label: 'Tagline', defaultHeadline: 'Your tagline here', usesSubtext: false },
  { id: 'launch', label: 'Launch / Coming Soon', defaultHeadline: 'Coming soon', usesSubtext: true },
] as const

export function getPostTemplate(id: string): PostTemplate | undefined {
  return POST_TEMPLATES.find((t) => t.id === id)
}

/* -------------------------------------------------------------------------- */
/* Brand colour resolution                                                     */
/* -------------------------------------------------------------------------- */

/** Neutral fallback when the project has no usable brand palette. */
export const FALLBACK_POST_BG = '#111111'
export const FALLBACK_POST_ACCENT = '#4f6bed'

export interface PostColors {
  /** Background fill. */
  bg: string
  /** A secondary brand colour for accents (a rule/underline). */
  accent: string
  /** Readable text colour computed from the background (WCAG-aware). */
  ink: string
}

/**
 * Resolve the post colours from a brand palette (hex list, most-important first).
 * bg = first valid colour, accent = second valid (or the bg's contrast colour),
 * ink = the best-contrast text colour for the bg. Invalid/empty → neutral
 * fallback so a post always renders.
 */
export function resolvePostColors(palette: (string | null | undefined)[] | null | undefined): PostColors {
  const valid: string[] = []
  for (const c of palette ?? []) {
    const h = normalizeHex(String(c ?? ''))
    if (h) valid.push(h)
  }
  const bg = valid[0] ?? FALLBACK_POST_BG
  const ink = bestTextColor(bg)
  const accent = valid[1] ?? (valid[0] ? ink : FALLBACK_POST_ACCENT)
  return { bg, accent, ink }
}

/* -------------------------------------------------------------------------- */
/* Text wrapping (SVG has no auto-wrap)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Greedy word-wrap into at most `maxLines` lines of about `maxCharsPerLine`
 * characters. A single word longer than the limit is kept whole (it just runs a
 * bit wide rather than being chopped). The last line is ellipsised if text
 * remains. Deterministic + pure → unit-testable.
 */
export function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    // On the LAST allowed line, keep folding every remaining word in (so nothing
    // is silently dropped) — it gets ellipsised below if it overflows.
    if (lines.length === maxLines - 1) {
      current = candidate
    } else if (candidate.length <= maxCharsPerLine || current === '') {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  lines.push(current)

  // Ellipsise only a MULTI-word last line that overflows; a single long word
  // (e.g. a URL or one big word) is kept whole rather than chopped.
  const lastIdx = lines.length - 1
  const last = lines[lastIdx]
  if (last.includes(' ') && last.length > maxCharsPerLine) {
    lines[lastIdx] = `${last.slice(0, Math.max(0, maxCharsPerLine - 1)).trimEnd()}…`
  }
  return lines
}

/** Render centred wrapped text as <tspan> lines around a vertical anchor. */
function textBlock(
  lines: string[],
  cx: number,
  centerY: number,
  fontSize: number,
  color: string,
  weight: number,
): string {
  if (lines.length === 0) return ''
  const lineHeight = fontSize * 1.2
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${cx}" y="${round(startY + i * lineHeight)}">${escapeXmlText(line)}</tspan>`,
    )
    .join('')
  return `<text text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="${weight}" font-size="${fontSize}" fill="${color}">${tspans}</text>`
}

/** Escape text content (not an attribute) for SVG/XML. */
export function escapeXmlText(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export interface RenderPostOptions {
  /** Brand palette (hex list, most-important first). Empty → neutral fallback. */
  palette?: (string | null | undefined)[] | null
  /** Logo href — a data: URL for export, a blob/object URL for preview. */
  logoHref?: string | null
  /** Optional headline text (falls back to the template default when blank). */
  headline?: string | null
  /** Optional subtext (only used by templates whose `usesSubtext` is true). */
  subtext?: string | null
}

function logoTag(cx: number, cy: number, w: number, h: number, logoHref: string | null): string {
  if (!logoHref) return ''
  return `<image href="${escapeXmlAttr(logoHref)}" x="${round(cx - w / 2)}" y="${round(
    cy - h / 2,
  )}" width="${round(w)}" height="${round(h)}" preserveAspectRatio="xMidYMid meet" />`
}

/**
 * Render a branded post as a standalone SVG string. Returns '' for an unknown
 * template or format id.
 */
export function renderPostSvg(
  templateId: string,
  formatId: string,
  opts: RenderPostOptions,
): string {
  const template = getPostTemplate(templateId)
  const format = getPostFormat(formatId)
  if (!template || !format) return ''

  const { width: W, height: H } = format
  const colors = resolvePostColors(opts.palette)
  const logoHref = opts.logoHref ?? null
  const headline = (opts.headline && opts.headline.trim()) || template.defaultHeadline
  const subtext = template.usesSubtext ? (opts.subtext ?? '').trim() : ''

  // Layout anchors scale with the canvas so square + story both look balanced.
  const cx = W / 2
  const logoBoxW = W * 0.5
  const logoBoxH = H * 0.22
  const headlineSize = Math.round(W * 0.075)
  const subtextSize = Math.round(W * 0.038)
  const maxChars = 22

  const parts: string[] = []

  switch (template.id) {
    case 'announcement': {
      // Logo upper third, headline centred, subtext below, accent rule under logo.
      const logoCy = H * 0.3
      parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${colors.bg}" />`)
      parts.push(logoTag(cx, logoCy, logoBoxW, logoBoxH, logoHref))
      parts.push(
        `<rect x="${round(cx - W * 0.08)}" y="${round(H * 0.44)}" width="${round(W * 0.16)}" height="6" rx="3" fill="${colors.accent}" />`,
      )
      parts.push(textBlock(wrapText(headline, maxChars, 3), cx, H * 0.6, headlineSize, colors.ink, 800))
      if (subtext) {
        parts.push(textBlock(wrapText(subtext, 34, 2), cx, H * 0.78, subtextSize, colors.ink, 400))
      }
      break
    }
    case 'tagline': {
      // Logo centred high, tagline large below — no subtext.
      parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${colors.bg}" />`)
      parts.push(logoTag(cx, H * 0.38, logoBoxW, logoBoxH, logoHref))
      parts.push(textBlock(wrapText(headline, maxChars, 3), cx, H * 0.66, headlineSize, colors.ink, 700))
      break
    }
    case 'launch': {
      // Accent band top, big headline, logo lower third, subtext at the very bottom.
      parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${colors.bg}" />`)
      parts.push(`<rect x="0" y="0" width="${W}" height="${round(H * 0.03)}" fill="${colors.accent}" />`)
      parts.push(textBlock(wrapText(headline, maxChars, 3), cx, H * 0.32, headlineSize, colors.ink, 800))
      parts.push(logoTag(cx, H * 0.62, logoBoxW, logoBoxH, logoHref))
      if (subtext) {
        parts.push(textBlock(wrapText(subtext, 34, 2), cx, H * 0.86, subtextSize, colors.ink, 400))
      }
      break
    }
    default:
      parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${colors.bg}" />`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join(
    '',
  )}</svg>`
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/** Zip path for a branded post PNG: posts/{brand}-{template}-{format}.png */
export function postFileName(templateId: string, formatId: string, brandName: string): string {
  return `posts/${kitSlug(brandName)}-${templateId}-${formatId}.png`
}

/** Default zip file name for a released kit download. */
export function socialKitZipName(brandName: string): string {
  return `${kitSlug(brandName)}-social-sharing-kit.zip`
}

/* -------------------------------------------------------------------------- */
/* Upload validation (released kit zip)                                        */
/* -------------------------------------------------------------------------- */

export const SOCIAL_KIT_MAX_MB = 100
export const SOCIAL_KIT_MAX_BYTES = SOCIAL_KIT_MAX_MB * 1024 * 1024

/**
 * Validate the released social-kit upload — a single ZIP, ≤100 MB. Isolated from
 * the Phase 12 design-asset validator (which is keyed to mockup/asset_kit) so
 * that path is untouched. Returns a user-friendly message, or null when allowed.
 */
export function validateSocialKitZip(fileName: string, sizeBytes: number): string | null {
  if (sizeBytes > SOCIAL_KIT_MAX_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    return `File too large: ${mb} MB. Maximum allowed: ${SOCIAL_KIT_MAX_MB} MB.`
  }
  const ext = getExtension(fileName)
  if (ext !== 'zip') {
    return 'The social sharing kit must be a ZIP file.'
  }
  return null
}
