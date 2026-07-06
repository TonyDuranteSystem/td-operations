/**
 * TD Communication — mockup scene templates (Phase 12, Tool 2).
 *
 * Pure, side-effect-free generators of SCHEMATIC brand mockups as inline SVG
 * strings: a business card, letterhead, social post and website/browser frame,
 * each themed off a chosen background colour with the client's logo dropped in.
 *
 * SVG (not photoreal photo compositing) on purpose: no binary assets to license,
 * fully themeable from the palette, and it rasterises to PNG natively (serialise
 * → draw to <canvas> → toBlob) with no html2canvas.
 *
 * The logo is placed with preserveAspectRatio="xMidYMid meet" (= object-contain)
 * so a logo of any aspect ratio is never cropped or distorted. For EXPORT the
 * caller must pass `logoHref` as a data: URL (a cross-origin href would taint the
 * canvas); for live preview a blob/object URL is fine.
 *
 * No DB / no I/O — client-safe, unit-tested (R086).
 */

import { normalizeHex, bestTextColor } from './color-tools'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface MockupTemplate {
  id: string
  label: string
  /** SVG canvas size (viewBox is `0 0 width height`). */
  width: number
  height: number
  /** Sensible default background so the tool opens with something reasonable. */
  recommendedBg: string
  /** Base logo placement rect (before the user's scale multiplier). */
  logoArea: Rect
}

export interface RenderOptions {
  /** Scene/brand background colour (hex). Invalid → the template's recommendedBg. */
  bg: string
  /** Logo image href — a data: URL for export, a blob/object URL for preview. */
  logoHref: string | null
  /** Multiplier on the logo area (centred), clamped to [0.5, 1.5]. Default 1. */
  logoScale?: number
  /**
   * OPTIONAL brand corner radius 0..1 (from the project's logo_geometry). When set,
   * the brand-container corners (business card, website frame) follow it instead of
   * their default rx. Undefined = unchanged default behaviour (existing mockups).
   */
  cornerRadius?: number
}

/**
 * Resolve a container's corner radius in px. Undefined brand radius → the
 * template's baked default (behaviour unchanged). Otherwise a fraction of the
 * container's shorter side, capped so it never exceeds a rounded look.
 */
function brandRx(cornerRadius: number | undefined, fallback: number, minSide: number): number {
  if (typeof cornerRadius !== 'number' || !Number.isFinite(cornerRadius)) return fallback
  const r = Math.max(0, Math.min(1, cornerRadius))
  return round(Math.min(r * (minSide / 2), minSide / 2))
}

const NEUTRAL_SURFACE = '#e7e7ea'

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export const MOCKUP_TEMPLATES: readonly MockupTemplate[] = [
  {
    id: 'business_card',
    label: 'Business Card',
    width: 1050,
    height: 600,
    recommendedBg: '#ffffff',
    logoArea: { x: 90, y: 110, w: 380, h: 200 },
  },
  {
    id: 'letterhead',
    label: 'Letterhead',
    width: 850,
    height: 1100,
    recommendedBg: '#ffffff',
    logoArea: { x: 80, y: 70, w: 320, h: 160 },
  },
  {
    id: 'social_post',
    label: 'Social Post',
    width: 1080,
    height: 1080,
    recommendedBg: '#111111',
    logoArea: { x: 240, y: 300, w: 600, h: 340 },
  },
  {
    id: 'website',
    label: 'Website',
    width: 1200,
    height: 820,
    recommendedBg: '#ffffff',
    logoArea: { x: 430, y: 300, w: 340, h: 190 },
  },
] as const

export function getMockupTemplate(id: string): MockupTemplate | undefined {
  return MOCKUP_TEMPLATES.find((t) => t.id === id)
}

/* -------------------------------------------------------------------------- */
/* Helpers (pure)                                                              */
/* -------------------------------------------------------------------------- */

export function clampScale(scale: number | undefined): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1
  return Math.max(0.5, Math.min(1.5, scale))
}

/** Scale a rect around its own centre. */
export function scaledPlacement(base: Rect, scale: number): Rect {
  const s = clampScale(scale)
  const cx = base.x + base.w / 2
  const cy = base.y + base.h / 2
  const w = base.w * s
  const h = base.h * s
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** Escape a value for safe inclusion in an XML/SVG attribute. */
export function escapeXmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function logoTag(area: Rect, scale: number, logoHref: string | null): string {
  if (!logoHref) return ''
  const p = scaledPlacement(area, scale)
  return `<image href="${escapeXmlAttr(logoHref)}" x="${round(p.x)}" y="${round(p.y)}" width="${round(
    p.w,
  )}" height="${round(p.h)}" preserveAspectRatio="xMidYMid meet" />`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Faux text lines in a muted version of the ink colour. */
function textLines(
  ink: string,
  x: number,
  startY: number,
  widths: number[],
  gap = 22,
  h = 10,
): string {
  return widths
    .map(
      (w, i) =>
        `<rect x="${x}" y="${startY + i * gap}" width="${w}" height="${h}" rx="${h / 2}" fill="${ink}" opacity="0.28" />`,
    )
    .join('')
}

/* -------------------------------------------------------------------------- */
/* Scene renderers                                                             */
/* -------------------------------------------------------------------------- */

function renderScene(t: MockupTemplate, bg: string, scale: number, logoHref: string | null, cornerRadius?: number): string {
  const ink = bestTextColor(bg)
  const logo = logoTag(t.logoArea, scale, logoHref)

  switch (t.id) {
    case 'business_card': {
      const cw = t.width - 120
      const ch = t.height - 120
      const rx = brandRx(cornerRadius, 24, Math.min(cw, ch))
      return [
        `<rect x="0" y="0" width="${t.width}" height="${t.height}" fill="${NEUTRAL_SURFACE}" />`,
        `<rect x="60" y="60" width="${cw}" height="${ch}" rx="${rx}" fill="${bg}" />`,
        logo,
        textLines(ink, 90, 360, [300, 240, 200]),
      ].join('')
    }
    case 'letterhead': {
      return [
        `<rect x="0" y="0" width="${t.width}" height="${t.height}" fill="${NEUTRAL_SURFACE}" />`,
        `<rect x="40" y="40" width="${t.width - 80}" height="${t.height - 80}" fill="${bg}" />`,
        `<rect x="80" y="250" width="${t.width - 160}" height="2" fill="${ink}" opacity="0.2" />`,
        logo,
        textLines(ink, 80, 320, [560, 640, 600, 520, 640, 480], 30, 12),
      ].join('')
    }
    case 'social_post': {
      return [
        `<rect x="0" y="0" width="${t.width}" height="${t.height}" fill="${bg}" />`,
        logo,
        textLines(ink, 240, 720, [600, 480, 360], 34, 16),
      ].join('')
    }
    case 'website': {
      const rx = brandRx(cornerRadius, 16, 64) // cap to the chrome-bar height so the top stays clean
      return [
        `<rect x="0" y="0" width="${t.width}" height="${t.height}" fill="${NEUTRAL_SURFACE}" />`,
        `<rect x="40" y="40" width="${t.width - 80}" height="${t.height - 80}" rx="${rx}" fill="${bg}" />`,
        // browser chrome
        `<rect x="40" y="40" width="${t.width - 80}" height="64" rx="${rx}" fill="${ink}" opacity="0.06" />`,
        `<circle cx="78" cy="72" r="8" fill="${ink}" opacity="0.25" />`,
        `<circle cx="106" cy="72" r="8" fill="${ink}" opacity="0.25" />`,
        `<circle cx="134" cy="72" r="8" fill="${ink}" opacity="0.25" />`,
        `<rect x="180" y="60" width="${t.width - 260}" height="24" rx="12" fill="${ink}" opacity="0.08" />`,
        logo,
        textLines(ink, 430, 520, [340, 260], 30, 12),
      ].join('')
    }
    default:
      return `<rect x="0" y="0" width="${t.width}" height="${t.height}" fill="${bg}" />${logo}`
  }
}

/**
 * Render a mockup as a standalone SVG string. Returns '' for an unknown template
 * id. An invalid `bg` falls back to the template's recommended background.
 */
export function renderMockupSvg(templateId: string, opts: RenderOptions): string {
  const t = getMockupTemplate(templateId)
  if (!t) return ''
  const bg = normalizeHex(opts.bg) ?? t.recommendedBg
  const scale = clampScale(opts.logoScale)
  const scene = renderScene(t, bg, scale, opts.logoHref ?? null, opts.cornerRadius)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t.width} ${t.height}" width="${t.width}" height="${t.height}">${scene}</svg>`
}
