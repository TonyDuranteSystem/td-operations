// CRM dark mode — the colour mapping, in ONE place.
//
// The CRM is painted almost entirely with Tailwind's stock palette (zinc/gray + the green/red/amber/blue
// badge shades). Instead of editing ~450 screens, tailwind.config.ts routes every one of those colours
// through a CSS variable: `rgb(var(--c-bg-zinc-100, 244 244 245) / <alpha-value>)`. The fallback IS the
// stock light value, so with no variable defined (every page that is not the CRM dashboard) nothing
// changes at all. Only inside `.crm-dark` (set on <html> by the dashboard layout) do the variables exist,
// and they point at a darker shade of the same family.
//
// Background / text / border are mapped separately on purpose: `bg-blue-600 text-white` buttons must stay
// as they are, while `bg-green-100 text-green-800` badges must flip together.

import colors from 'tailwindcss/colors'

export const NEUTRAL_FAMILIES = ['gray', 'slate', 'zinc', 'neutral', 'stone'] as const
export const COLORED_FAMILIES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const
export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

export type Shade = (typeof SHADES)[number]
export type Kind = 'bg' | 'text' | 'border'

// shade used in LIGHT mode -> shade of the same family used in DARK mode. Missing = unchanged.
const BG_NEUTRAL: Partial<Record<Shade, Shade>> = { 50: 950, 100: 800, 200: 700, 300: 600 }
const BG_COLORED: Partial<Record<Shade, Shade>> = { 50: 950, 100: 900, 200: 800, 300: 700 }
const TEXT_NEUTRAL: Partial<Record<Shade, Shade>> = { 500: 400, 600: 300, 700: 200, 800: 100, 900: 50, 950: 50 }
const TEXT_COLORED: Partial<Record<Shade, Shade>> = { 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 }
// Borders sit one step closer to the surface than fills so lines stay subtle.
const BORDER_NEUTRAL: Partial<Record<Shade, Shade>> = { 50: 900, 100: 800, 200: 700, 300: 600 }
const BORDER_COLORED: Partial<Record<Shade, Shade>> = { 50: 950, 100: 900, 200: 800, 300: 700 }

const MAPS: Record<'neutral' | 'colored', Record<Kind, Partial<Record<Shade, Shade>>>> = {
  neutral: { bg: BG_NEUTRAL, text: TEXT_NEUTRAL, border: BORDER_NEUTRAL },
  colored: { bg: BG_COLORED, text: TEXT_COLORED, border: BORDER_COLORED },
}

// `bg-white` is the CRM's card/modal/surface colour. Dark = zinc-900 (the CRM is zinc-based).
export const DARK_WHITE_FAMILY = 'zinc'
export const DARK_WHITE_SHADE: Shade = 900

type Palette = Record<string, Record<string, string>>
const palette = colors as unknown as Palette

/** "#f4f4f5" -> "244 244 245" (space-separated channels, what `rgb(... / alpha)` needs). */
export function hexToChannels(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

export function varName(kind: Kind, family: string, shade: Shade | 'white'): string {
  return shade === 'white' ? `--c-${kind}-white` : `--c-${kind}-${family}-${shade}`
}

function familyKind(family: string): 'neutral' | 'colored' {
  return (NEUTRAL_FAMILIES as readonly string[]).includes(family) ? 'neutral' : 'colored'
}

/** The dark shade for a light shade, or the same shade when this kind does not remap it. */
export function darkShade(kind: Kind, family: string, shade: Shade): Shade {
  return MAPS[familyKind(family)][kind][shade] ?? shade
}

/** Tailwind colour object for one utility kind: every shade routed through its variable. */
export function buildKindColors(kind: Kind): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {}
  for (const family of [...NEUTRAL_FAMILIES, ...COLORED_FAMILIES]) {
    const scale: Record<string, string> = {}
    for (const shade of SHADES) {
      scale[String(shade)] = `rgb(var(${varName(kind, family, shade)}, ${hexToChannels(palette[family][shade])}) / <alpha-value>)`
    }
    out[family] = scale
  }
  // Only fills and borders have a white that changes; text-white stays white (it sits on coloured buttons).
  if (kind === 'bg' || kind === 'border') {
    out.white = `rgb(var(${varName(kind, '', 'white')}, 255 255 255) / <alpha-value>)`
  }
  return out
}

/** Every variable that differs in dark mode -> its dark channels. Only differing ones are emitted. */
export function buildDarkVariables(): Record<string, string> {
  const vars: Record<string, string> = {}
  const surface = hexToChannels(palette[DARK_WHITE_FAMILY][DARK_WHITE_SHADE])
  vars[varName('bg', '', 'white')] = surface
  vars[varName('border', '', 'white')] = surface
  for (const kind of ['bg', 'text', 'border'] as const) {
    for (const family of [...NEUTRAL_FAMILIES, ...COLORED_FAMILIES]) {
      for (const shade of SHADES) {
        const dark = darkShade(kind, family, shade)
        if (dark === shade) continue
        vars[varName(kind, family, shade)] = hexToChannels(palette[family][dark])
      }
    }
  }
  return vars
}
