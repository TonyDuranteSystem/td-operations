/**
 * TD Communication — colour tools (Phase 12, Tool 3).
 *
 * Pure, side-effect-free colour maths for Cris's palette tool: hex/RGB/HSL
 * conversions, WCAG 2.1 contrast + rating, palette generators (complementary /
 * analogous / triadic / tints / shades), and designer-ready exports (CSS / SCSS
 * / JSON / Tailwind / comma-list).
 *
 * No DB / no I/O — client-safe and unit-tested (R086). Every entry point guards
 * malformed input (returns null / a sensible fallback) so a bad hex from the AI
 * brand profile never yields NaN swatches.
 */

export interface RGB {
  r: number
  g: number
  b: number
}

export interface HSL {
  /** hue 0–360 */
  h: number
  /** saturation 0–100 */
  s: number
  /** lightness 0–100 */
  l: number
}

/* -------------------------------------------------------------------------- */
/* Parsing / normalisation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a hex string to lowercase `#rrggbb`, expanding a 3-digit shorthand
 * (`#fff` → `#ffffff`). Returns null for anything that isn't a valid 3- or
 * 6-digit hex (with or without a leading `#`).
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
  }
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

/** True when `input` is a valid 3- or 6-digit hex colour. */
export function isValidHex(input: string): boolean {
  return normalizeHex(input) !== null
}

export function hexToRgb(hex: string): RGB | null {
  const norm = normalizeHex(hex)
  if (!norm) return null
  const n = norm.slice(1)
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  }
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

export function rgbToHex(rgb: RGB): string {
  const to2 = (v: number) => clampByte(v).toString(16).padStart(2, '0')
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`
}

/** Format a hex/RGB as `rgb(r, g, b)` for display; '' when the hex is invalid. */
export function rgbString(hex: string): string {
  const rgb = hexToRgb(hex)
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : ''
}

/* -------------------------------------------------------------------------- */
/* HSL conversions                                                             */
/* -------------------------------------------------------------------------- */

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hn = ((h % 360) + 360) % 360
  const sn = Math.max(0, Math.min(100, s)) / 100
  const ln = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1))
  const m = ln - c / 2
  let rp = 0
  let gp = 0
  let bp = 0
  if (hn < 60) [rp, gp, bp] = [c, x, 0]
  else if (hn < 120) [rp, gp, bp] = [x, c, 0]
  else if (hn < 180) [rp, gp, bp] = [0, c, x]
  else if (hn < 240) [rp, gp, bp] = [0, x, c]
  else if (hn < 300) [rp, gp, bp] = [x, 0, c]
  else [rp, gp, bp] = [c, 0, x]
  return { r: clampByte((rp + m) * 255), g: clampByte((gp + m) * 255), b: clampByte((bp + m) * 255) }
}

export function hexToHsl(hex: string): HSL | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHsl(rgb) : null
}

export function hslToHex(hsl: HSL): string {
  return rgbToHex(hslToRgb(hsl))
}

/* -------------------------------------------------------------------------- */
/* Accessibility — WCAG 2.1 contrast                                           */
/* -------------------------------------------------------------------------- */

/** WCAG relative luminance of an sRGB colour (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: RGB): number {
  const chan = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

/**
 * WCAG contrast ratio between two colours, 1–21. Returns null when either hex is
 * invalid. Not rounded (callers format): black↔white is exactly 21.
 */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  if (!a || !b) return null
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export interface WcagRating {
  ratio: number
  /** normal text ≥ 4.5 */
  AA: boolean
  /** normal text ≥ 7 */
  AAA: boolean
  /** large text (≥18pt / 14pt bold) ≥ 3 */
  AALarge: boolean
  /** large text ≥ 4.5 */
  AAALarge: boolean
}

/** Rate a raw contrast ratio against the WCAG 2.1 thresholds. */
export function wcagRating(ratio: number): WcagRating {
  return {
    ratio,
    AA: ratio >= 4.5,
    AAA: ratio >= 7,
    AALarge: ratio >= 3,
    AAALarge: ratio >= 4.5,
  }
}

/** Best foreground (black or white) for a background, by contrast. */
export function bestTextColor(bgHex: string): '#000000' | '#ffffff' {
  const onWhite = contrastRatio(bgHex, '#ffffff') ?? 0
  const onBlack = contrastRatio(bgHex, '#000000') ?? 0
  return onBlack >= onWhite ? '#000000' : '#ffffff'
}

/* -------------------------------------------------------------------------- */
/* Palette generators                                                          */
/* -------------------------------------------------------------------------- */

/** Rotate a colour's hue by `deg` (keeps S/L). '' inputs pass through as ''. */
export function rotateHue(hex: string, deg: number): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return normalizeHex(hex) ?? hex
  return hslToHex({ ...hsl, h: hsl.h + deg })
}

export function complementary(hex: string): string[] {
  const base = normalizeHex(hex)
  if (!base) return []
  return [base, rotateHue(base, 180)]
}

export function analogous(hex: string, spread = 30): string[] {
  const base = normalizeHex(hex)
  if (!base) return []
  return [rotateHue(base, -spread), base, rotateHue(base, spread)]
}

export function triadic(hex: string): string[] {
  const base = normalizeHex(hex)
  if (!base) return []
  return [base, rotateHue(base, 120), rotateHue(base, 240)]
}

/** N progressively lighter variants toward white (excludes the base). */
export function tints(hex: string, steps = 4): string[] {
  const hsl = hexToHsl(hex)
  if (!hsl) return []
  const out: string[] = []
  for (let i = 1; i <= steps; i++) {
    const l = hsl.l + ((100 - hsl.l) * i) / (steps + 1)
    out.push(hslToHex({ ...hsl, l }))
  }
  return out
}

/** N progressively darker variants toward black (excludes the base). */
export function shades(hex: string, steps = 4): string[] {
  const hsl = hexToHsl(hex)
  if (!hsl) return []
  const out: string[] = []
  for (let i = 1; i <= steps; i++) {
    const l = hsl.l - (hsl.l * i) / (steps + 1)
    out.push(hslToHex({ ...hsl, l }))
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Exports for designers                                                       */
/* -------------------------------------------------------------------------- */

export interface NamedColor {
  hex: string
  name: string
}

/** Slugify a colour name into a CSS-safe token (`Coffee Brown` → `coffee-brown`). */
export function colorSlug(name: string, fallbackIndex: number): string {
  const slug = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `color-${fallbackIndex + 1}`
}

export interface PaletteExports {
  css: string
  scss: string
  json: string
  tailwind: string
  list: string
}

/**
 * Render a named palette in five designer-ready formats. Invalid hexes are
 * dropped. Duplicate slugs are disambiguated with a numeric suffix so CSS/SCSS
 * variables never collide.
 */
export function formatExports(colors: NamedColor[]): PaletteExports {
  const clean = colors
    .map((c, i) => {
      const hex = normalizeHex(c.hex)
      return hex ? { hex, name: c.name, slug: colorSlug(c.name, i) } : null
    })
    .filter((c): c is { hex: string; name: string; slug: string } => c !== null)

  const seen = new Map<string, number>()
  const withUniqueSlugs = clean.map((c) => {
    const count = seen.get(c.slug) ?? 0
    seen.set(c.slug, count + 1)
    return { ...c, slug: count === 0 ? c.slug : `${c.slug}-${count + 1}` }
  })

  const css = `:root {\n${withUniqueSlugs.map((c) => `  --${c.slug}: ${c.hex};`).join('\n')}\n}`
  const scss = withUniqueSlugs.map((c) => `$${c.slug}: ${c.hex};`).join('\n')
  const json = JSON.stringify(
    withUniqueSlugs.reduce<Record<string, string>>((acc, c) => {
      acc[c.slug] = c.hex
      return acc
    }, {}),
    null,
    2,
  )
  const tailwind = `colors: {\n${withUniqueSlugs
    .map((c) => `  '${c.slug}': '${c.hex}',`)
    .join('\n')}\n}`
  const list = withUniqueSlugs.map((c) => c.hex).join(', ')

  return { css, scss, json, tailwind, list }
}
