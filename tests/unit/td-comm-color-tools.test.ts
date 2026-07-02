import { describe, it, expect } from 'vitest'
import {
  normalizeHex,
  isValidHex,
  hexToRgb,
  rgbToHex,
  rgbString,
  rgbToHsl,
  hslToRgb,
  hexToHsl,
  hslToHex,
  relativeLuminance,
  contrastRatio,
  wcagRating,
  bestTextColor,
  rotateHue,
  complementary,
  analogous,
  triadic,
  tints,
  shades,
  colorSlug,
  formatExports,
} from '@/lib/td-communication/color-tools'

describe('normalizeHex / isValidHex', () => {
  it('expands 3-digit shorthand and lowercases', () => {
    expect(normalizeHex('#FFF')).toBe('#ffffff')
    expect(normalizeHex('#0aF')).toBe('#00aaff')
  })
  it('accepts 6-digit with or without #', () => {
    expect(normalizeHex('6F4E37')).toBe('#6f4e37')
    expect(normalizeHex('#6F4E37')).toBe('#6f4e37')
  })
  it('rejects malformed input (no NaN downstream)', () => {
    expect(normalizeHex('nope')).toBeNull()
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('#1234')).toBeNull()
    expect(normalizeHex('#gggggg')).toBeNull()
    expect(normalizeHex(null as unknown as string)).toBeNull()
    expect(isValidHex('#abc')).toBe(true)
    expect(isValidHex('xyz')).toBe(false)
  })
})

describe('hex <-> rgb', () => {
  it('round-trips', () => {
    expect(hexToRgb('#6f4e37')).toEqual({ r: 111, g: 78, b: 55 })
    expect(rgbToHex({ r: 111, g: 78, b: 55 })).toBe('#6f4e37')
  })
  it('clamps out-of-range channels', () => {
    expect(rgbToHex({ r: 300, g: -5, b: 128 })).toBe('#ff0080')
  })
  it('rgbString formats, empty on invalid', () => {
    expect(rgbString('#ffffff')).toBe('rgb(255, 255, 255)')
    expect(rgbString('zzz')).toBe('')
  })
  it('hexToRgb rejects invalid', () => {
    expect(hexToRgb('zzz')).toBeNull()
  })
})

describe('hsl conversions', () => {
  it('pure colours', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 })
    expect(rgbToHsl({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, l: 50 })
    expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 })
  })
  it('greys have zero saturation', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 }).s).toBe(0)
  })
  it('hslToRgb inverts pure red', () => {
    expect(hslToRgb({ h: 0, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 })
  })
  it('hue wraps (negative + >360)', () => {
    expect(hslToHex({ h: -120, s: 100, l: 50 })).toBe(hslToHex({ h: 240, s: 100, l: 50 }))
    expect(hslToHex({ h: 480, s: 100, l: 50 })).toBe(hslToHex({ h: 120, s: 100, l: 50 }))
  })
  it('hexToHsl guards invalid', () => {
    expect(hexToHsl('zzz')).toBeNull()
  })
  it('round-trips a mid colour within rounding tolerance', () => {
    const hsl = hexToHsl('#3b82f6')!
    const back = hexToRgb(hslToHex(hsl))!
    expect(Math.abs(back.r - 59)).toBeLessThanOrEqual(2)
    expect(Math.abs(back.g - 130)).toBeLessThanOrEqual(2)
    expect(Math.abs(back.b - 246)).toBeLessThanOrEqual(2)
  })
})

describe('WCAG contrast', () => {
  it('black on white is exactly 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
  })
  it('same colour is 1', () => {
    expect(contrastRatio('#123456', '#123456')).toBe(1)
  })
  it('is symmetric', () => {
    const a = contrastRatio('#777777', '#ffffff')!
    const b = contrastRatio('#ffffff', '#777777')!
    expect(a).toBeCloseTo(b, 10)
  })
  it('returns null on invalid input', () => {
    expect(contrastRatio('zzz', '#ffffff')).toBeNull()
  })
  it('relativeLuminance endpoints', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
  })
  it('rating thresholds', () => {
    expect(wcagRating(21)).toMatchObject({ AA: true, AAA: true, AALarge: true, AAALarge: true })
    const r = wcagRating(4.5)
    expect(r.AA).toBe(true)
    expect(r.AAA).toBe(false)
    expect(r.AAALarge).toBe(true)
    const low = wcagRating(3)
    expect(low.AA).toBe(false)
    expect(low.AALarge).toBe(true)
  })
  it('bestTextColor picks the higher-contrast option', () => {
    expect(bestTextColor('#ffffff')).toBe('#000000')
    expect(bestTextColor('#000000')).toBe('#ffffff')
    expect(bestTextColor('#1a1a1a')).toBe('#ffffff')
  })
})

describe('palette generators', () => {
  it('complementary is 180° apart', () => {
    const [base, comp] = complementary('#ff0000')
    expect(base).toBe('#ff0000')
    expect(hexToHsl(comp)!.h).toBe(180)
  })
  it('analogous returns three around the base', () => {
    const out = analogous('#ff0000')
    expect(out).toHaveLength(3)
    expect(out[1]).toBe('#ff0000')
    expect(hexToHsl(out[0])!.h).toBe(330)
    expect(hexToHsl(out[2])!.h).toBe(30)
  })
  it('triadic returns base + 120 + 240', () => {
    const out = triadic('#ff0000')
    expect(out.map((h) => hexToHsl(h)!.h)).toEqual([0, 120, 240])
  })
  it('tints get lighter, shades get darker, both exclude base', () => {
    const t = tints('#3b82f6', 3)
    const s = shades('#3b82f6', 3)
    expect(t).toHaveLength(3)
    expect(s).toHaveLength(3)
    const baseL = hexToHsl('#3b82f6')!.l
    expect(hexToHsl(t[0])!.l).toBeGreaterThan(baseL)
    expect(hexToHsl(t[2])!.l).toBeGreaterThan(hexToHsl(t[0])!.l)
    expect(hexToHsl(s[0])!.l).toBeLessThan(baseL)
    expect(hexToHsl(s[2])!.l).toBeLessThan(hexToHsl(s[0])!.l)
  })
  it('generators return [] on invalid base', () => {
    expect(complementary('zzz')).toEqual([])
    expect(analogous('zzz')).toEqual([])
    expect(triadic('zzz')).toEqual([])
    expect(tints('zzz')).toEqual([])
    expect(shades('zzz')).toEqual([])
  })
  it('rotateHue on invalid returns the normalized/original', () => {
    expect(rotateHue('#abc', 60)).not.toBe('')
  })
  it('is deterministic', () => {
    expect(triadic('#6f4e37')).toEqual(triadic('#6f4e37'))
  })
})

describe('formatExports', () => {
  it('slugifies names and emits five formats', () => {
    const out = formatExports([
      { hex: '#6f4e37', name: 'Coffee Brown' },
      { hex: '#c9a227', name: 'Gold' },
    ])
    expect(out.css).toContain('--coffee-brown: #6f4e37;')
    expect(out.css).toContain('--gold: #c9a227;')
    expect(out.scss).toContain('$coffee-brown: #6f4e37;')
    expect(out.tailwind).toContain("'gold': '#c9a227',")
    expect(JSON.parse(out.json)).toEqual({ 'coffee-brown': '#6f4e37', gold: '#c9a227' })
    expect(out.list).toBe('#6f4e37, #c9a227')
  })
  it('drops invalid hexes', () => {
    const out = formatExports([
      { hex: 'zzz', name: 'Nope' },
      { hex: '#000', name: 'Black' },
    ])
    expect(out.list).toBe('#000000')
  })
  it('disambiguates duplicate slugs', () => {
    const out = formatExports([
      { hex: '#111111', name: 'Accent' },
      { hex: '#222222', name: 'Accent' },
    ])
    expect(out.css).toContain('--accent: #111111;')
    expect(out.css).toContain('--accent-2: #222222;')
  })
  it('falls back to color-N for unnameable colours', () => {
    expect(colorSlug('', 0)).toBe('color-1')
    expect(colorSlug('   ', 3)).toBe('color-4')
    const out = formatExports([{ hex: '#111111', name: '' }])
    expect(out.css).toContain('--color-1: #111111;')
  })
})
