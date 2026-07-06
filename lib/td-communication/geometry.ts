/**
 * TD Communication — Logo Geometry tool (Design Tools 5th tab) pure logic.
 *
 * CLIENT-SAFE (mirrors color-tools.ts / mockup-templates.ts): no DB, no I/O, no
 * crypto. Imported by the Geometry tab UI, the server write-back, and the unit
 * tests. All parameter clamping, the preset registry, the defensive coercer, and
 * the (XML-escaped) SVG specimen renderer live here.
 *
 * WHY A VERSIONED, NORMALIZED CONTRACT: the chosen geometry is DURABLE, structured
 * state that a future logo generator will read (and that drives the Mockups tool
 * today). So it is a real contract, not a loose blob — `schema_version` lets it
 * evolve, and every dimension is NORMALIZED (0..1) so it's unit-independent.
 *
 * SECURITY: the exported SVG is generated ONLY from this pure template with the
 * shared `escapeXmlAttr`; the tool never persists arbitrary/user SVG.
 */

import { escapeXmlAttr } from './mockup-templates'

/** Bump when the LogoGeometry shape changes in a non-backward-compatible way. */
export const GEOMETRY_SCHEMA_VERSION = 1

/** Corner treatment KIND: rounded, outward chamfer (bevel), or inward concave cut (notch). */
export type CornerStyle = 'round' | 'bevel' | 'notch'

/**
 * The durable, structured geometry decision. Normalized + versioned so a future
 * logo generator can consume it and it can evolve. `preset_id` is what a consumer
 * branches on; `source`/`derived_from_preset` record whether Cris hand-tuned it.
 */
export interface LogoGeometry {
  schema_version: number
  /** Stable registry id (e.g. 'rounded'); the thing a generator branches on. */
  preset_id: string
  /** Corner treatment kind. */
  corner_style: CornerStyle
  /** Corner SIZE as a fraction 0..1 of half the shorter side (unit-independent). */
  corner_radius: number
  /** Secondary axis 0..1: for `bevel`, the cut depth (0 subtle → 1 deep/pointed); inert for `round`. */
  edge_sharpness: number
  /** 'preset' = untouched preset values; 'custom' = a slider was moved. */
  source: 'preset' | 'custom'
  /** The preset the current values were seeded from (kept even when source='custom'). */
  derived_from_preset: string | null
}

/* -------------------------------- presets -------------------------------- */

export interface GeometryPreset {
  id: string
  label: string
  corner_style: CornerStyle
  corner_radius: number
  edge_sharpness: number
}

/** Immutable registry — adding a preset later is one entry here (like MOCKUP_TEMPLATES). */
export const GEOMETRY_PRESETS: readonly GeometryPreset[] = [
  { id: 'squared', label: 'Squared', corner_style: 'round', corner_radius: 0, edge_sharpness: 0 },
  { id: 'rounded', label: 'Rounded', corner_style: 'round', corner_radius: 0.35, edge_sharpness: 0 },
  { id: 'pill', label: 'Pill', corner_style: 'round', corner_radius: 1, edge_sharpness: 0 },
  { id: 'bevelled', label: 'Bevelled', corner_style: 'bevel', corner_radius: 0.3, edge_sharpness: 0.5 },
  { id: 'chiseled', label: 'Chiseled', corner_style: 'bevel', corner_radius: 0.55, edge_sharpness: 1 },
  { id: 'notched', label: 'Notched', corner_style: 'notch', corner_radius: 0.35, edge_sharpness: 0.6 },
] as const

export const GEOMETRY_PRESET_IDS: readonly string[] = GEOMETRY_PRESETS.map((p) => p.id)

export function getGeometryPreset(id: string): GeometryPreset | undefined {
  return GEOMETRY_PRESETS.find((p) => p.id === id)
}

/* -------------------------------- clamps --------------------------------- */

/** Clamp any value into 0..1 (NaN/non-number → 0). */
export function clamp01(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}
export const clampRadius = clamp01
export const clampSharpness = clamp01

function isCornerStyle(v: unknown): v is CornerStyle {
  return v === 'round' || v === 'bevel' || v === 'notch'
}

/** Whether the edge-sharpness axis applies to a style (bevel + notch cut depth; inert for round). */
export function sharpnessApplies(style: CornerStyle): boolean {
  return style === 'bevel' || style === 'notch'
}

/* ------------------------------ construct/coerce -------------------------- */

/** Build a geometry object seeded from a preset (source='preset'). Unknown id → 'squared'. */
export function geometryFromPreset(id: string): LogoGeometry {
  const preset = getGeometryPreset(id) ?? GEOMETRY_PRESETS[0]
  return {
    schema_version: GEOMETRY_SCHEMA_VERSION,
    preset_id: preset.id,
    corner_style: preset.corner_style,
    corner_radius: clampRadius(preset.corner_radius),
    edge_sharpness: clampSharpness(preset.edge_sharpness),
    source: 'preset',
    derived_from_preset: preset.id,
  }
}

/** The default geometry (Rounded — a safe, common brand choice). */
export function defaultGeometry(): LogoGeometry {
  return geometryFromPreset('rounded')
}

/**
 * Apply an override (slider move / style change). Flips `source` to 'custom' when
 * the result no longer matches its seed preset; keeps `derived_from_preset`.
 */
export function withGeometryOverride(geo: LogoGeometry, patch: Partial<Pick<LogoGeometry, 'corner_style' | 'corner_radius' | 'edge_sharpness'>>): LogoGeometry {
  const next: LogoGeometry = {
    ...geo,
    corner_style: isCornerStyle(patch.corner_style) ? patch.corner_style : geo.corner_style,
    corner_radius: patch.corner_radius === undefined ? geo.corner_radius : clampRadius(patch.corner_radius),
    edge_sharpness: patch.edge_sharpness === undefined ? geo.edge_sharpness : clampSharpness(patch.edge_sharpness),
  }
  const seed = geo.derived_from_preset ? getGeometryPreset(geo.derived_from_preset) : undefined
  const matchesSeed =
    !!seed &&
    seed.corner_style === next.corner_style &&
    clampRadius(seed.corner_radius) === next.corner_radius &&
    clampSharpness(seed.edge_sharpness) === next.edge_sharpness
  next.source = matchesSeed ? 'preset' : 'custom'
  return next
}

/**
 * Defensive coercion of an unknown stored/AI value into a valid LogoGeometry, or
 * null when there's nothing usable. Never yields NaN geometry. (Mirrors
 * coercePalette / parseProfileResponse.)
 */
export function coerceGeometry(v: unknown): LogoGeometry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const presetId = typeof o.preset_id === 'string' && getGeometryPreset(o.preset_id) ? o.preset_id : null
  const corner_style = isCornerStyle(o.corner_style) ? o.corner_style : presetId ? getGeometryPreset(presetId)!.corner_style : 'round'
  const hasNumbers = typeof o.corner_radius === 'number' || typeof o.edge_sharpness === 'number'
  if (!presetId && !hasNumbers) return null // truly empty → nothing to coerce
  const derived = typeof o.derived_from_preset === 'string' && getGeometryPreset(o.derived_from_preset) ? o.derived_from_preset : presetId
  return {
    schema_version: typeof o.schema_version === 'number' && o.schema_version > 0 ? o.schema_version : GEOMETRY_SCHEMA_VERSION,
    preset_id: presetId ?? 'squared',
    corner_style,
    corner_radius: clampRadius(o.corner_radius),
    edge_sharpness: clampSharpness(o.edge_sharpness),
    source: o.source === 'custom' ? 'custom' : 'preset',
    derived_from_preset: derived,
  }
}

/** Human-readable summary for the brief card / tooltips. */
export function geometrySummary(geo: LogoGeometry): string {
  const preset = getGeometryPreset(geo.preset_id)
  const name = preset ? preset.label : geo.preset_id
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const tuned = geo.source === 'custom' ? ' (custom)' : ''
  return `${name}${tuned} · ${geo.corner_style} · radius ${pct(geo.corner_radius)}${sharpnessApplies(geo.corner_style) ? ` · sharpness ${pct(geo.edge_sharpness)}` : ''}`
}

/* ---------------------------- SVG specimen render ------------------------ */

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The SVG path `d` for a w×h rect (at 0,0) with the given corner treatment.
 * `radiusPx` is the corner size in px (already resolved + clamped to ≤ min/2).
 */
export function cornerPathD(style: CornerStyle, w: number, h: number, radiusPx: number, sharpness: number): string {
  const c = Math.max(0, Math.min(radiusPx, Math.min(w, h) / 2))
  if (c <= 0.5) {
    // Effectively square corners.
    return `M0,0 H${round(w)} V${round(h)} H0 Z`
  }
  if (style === 'bevel') {
    const cut = round(c * (0.6 + 0.4 * clamp01(sharpness)))
    const k = Math.min(cut, Math.min(w, h) / 2)
    return [
      `M${round(k)},0`,
      `H${round(w - k)}`,
      `L${round(w)},${round(k)}`,
      `V${round(h - k)}`,
      `L${round(w - k)},${round(h)}`,
      `H${round(k)}`,
      `L0,${round(h - k)}`,
      `V${round(k)}`,
      'Z',
    ].join(' ')
  }
  if (style === 'notch') {
    // Concave inward square cut at each corner (distinct from the outward bevel).
    const cut = round(c * (0.6 + 0.4 * clamp01(sharpness)))
    const k = Math.min(cut, Math.min(w, h) / 2)
    return [
      `M${round(k)},0`,
      `H${round(w - k)}`,
      `L${round(w - k)},${round(k)}`,
      `L${round(w)},${round(k)}`,
      `V${round(h - k)}`,
      `L${round(w - k)},${round(h - k)}`,
      `L${round(w - k)},${round(h)}`,
      `H${round(k)}`,
      `L${round(k)},${round(h - k)}`,
      `L0,${round(h - k)}`,
      `V${round(k)}`,
      `L${round(k)},${round(k)}`,
      'Z',
    ].join(' ')
  }
  // round
  const r = round(c)
  return [
    `M${r},0`,
    `H${round(w - r)}`,
    `A${r},${r} 0 0 1 ${round(w)},${r}`,
    `V${round(h - r)}`,
    `A${r},${r} 0 0 1 ${round(w - r)},${round(h)}`,
    `H${r}`,
    `A${r},${r} 0 0 1 0,${round(h - r)}`,
    `V${r}`,
    `A${r},${r} 0 0 1 ${r},0`,
    'Z',
  ].join(' ')
}

export interface GeometryRenderOptions {
  /** Square canvas side (default 400). */
  size?: number
  /** Container fill (hex). */
  bg?: string
  /** Stroke / text colour (hex). */
  ink?: string
  /** Optional label under the specimen (escaped). */
  label?: string
}

/**
 * Render the geometry SPECIMEN as an inline SVG string — a shaped container in the
 * brand colour with an optional labelled param readout. This is the exported asset
 * (saved as SVG, rasterised to PNG). Pure + XML-escaped; never accepts user SVG.
 */
export function renderGeometrySvg(geo: LogoGeometry, opts: GeometryRenderOptions = {}): string {
  const S = typeof opts.size === 'number' && opts.size > 0 ? opts.size : 400
  const bg = opts.bg || '#1f2937'
  const ink = opts.ink || '#111827'
  const label = opts.label ? escapeXmlAttr(opts.label) : ''

  // Centered specimen box (leave room for a label strip at the bottom).
  const boxW = round(S * 0.6)
  const boxH = round(S * 0.42)
  const x = round((S - boxW) / 2)
  const y = round((S - boxH) / 2 - S * 0.04)
  const radiusPx = clampRadius(geo.corner_radius) * (Math.min(boxW, boxH) / 2)
  const d = cornerPathD(geo.corner_style, boxW, boxH, radiusPx, geo.edge_sharpness)

  const labelTag = label
    ? `<text x="${round(S / 2)}" y="${round(S - S * 0.06)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${round(S * 0.045)}" fill="${escapeXmlAttr(ink)}" opacity="0.75">${label}</text>`
    : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<rect x="0" y="0" width="${S}" height="${S}" fill="#ffffff" />`,
    `<g transform="translate(${x},${y})">`,
    `<path d="${d}" fill="${escapeXmlAttr(bg)}" />`,
    `</g>`,
    labelTag,
    `</svg>`,
  ].join('')
}

/** File-name stem for a saved/exported specimen. Folds accents (café → cafe). */
export function geometryFileName(brand: string, geo: LogoGeometry, ext: 'svg' | 'png'): string {
  const safe =
    (brand || 'brand')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'brand'
  return `${safe}-geometry-${geo.preset_id}${geo.source === 'custom' ? '-custom' : ''}.${ext}`
}
