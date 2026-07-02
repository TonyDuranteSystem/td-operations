import { describe, it, expect } from 'vitest'
import {
  SOCIAL_PRESETS,
  FAVICON_SIZES,
  backgroundHex,
  backgroundLabel,
  kitSlug,
  socialFileName,
  faviconFileName,
  FAVICON_SVG_PATH,
  resolveBackgrounds,
  buildManifest,
  countKitFiles,
  WHITE_BG_HEX,
  DARK_BG_HEX,
} from '@/lib/td-communication/asset-kit'

describe('registry', () => {
  it('social presets are unique with positive dims', () => {
    const ids = SOCIAL_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of SOCIAL_PRESETS) {
      expect(p.width).toBeGreaterThan(0)
      expect(p.height).toBeGreaterThan(0)
    }
  })
  it('favicon sizes include apple-touch 180', () => {
    expect(FAVICON_SIZES).toContain(180)
    expect(FAVICON_SIZES).toContain(32)
  })
})

describe('backgrounds', () => {
  it('hex mapping', () => {
    expect(backgroundHex('white')).toBe(WHITE_BG_HEX)
    expect(backgroundHex('dark')).toBe(DARK_BG_HEX)
    expect(backgroundHex('transparent')).toBeNull()
  })
  it('labels', () => {
    expect(backgroundLabel('transparent')).toBe('Transparent')
    expect(backgroundLabel('white')).toBe('White')
    expect(backgroundLabel('dark')).toBe('Dark')
  })
})

describe('resolveBackgrounds — honest transparency', () => {
  it('keeps transparent when the source has alpha', () => {
    expect(resolveBackgrounds(['transparent', 'white'], true)).toEqual(['transparent', 'white'])
  })
  it('drops transparent when the source is opaque', () => {
    expect(resolveBackgrounds(['transparent', 'white'], false)).toEqual(['white'])
  })
  it('falls back to white if only transparent was asked but source is opaque', () => {
    expect(resolveBackgrounds(['transparent'], false)).toEqual(['white'])
  })
  it('dedupes', () => {
    expect(resolveBackgrounds(['white', 'white', 'dark'], false)).toEqual(['white', 'dark'])
  })
})

describe('naming', () => {
  it('slugifies the brand name with a fallback', () => {
    expect(kitSlug('Origin Coffee Co')).toBe('origin-coffee-co')
    expect(kitSlug('  ')).toBe('brand')
    expect(kitSlug(null)).toBe('brand')
    expect(kitSlug('Ács & Tóth!!')).toBe('cs-t-th')
  })
  it('social + favicon paths', () => {
    const preset = SOCIAL_PRESETS[0]
    expect(socialFileName(preset, 'white', 'acme')).toBe(
      `social/${preset.folder}/acme-${preset.id}-white.png`,
    )
    expect(faviconFileName(32, 'acme')).toBe('favicons/acme-favicon-32x32.png')
    expect(FAVICON_SVG_PATH('acme')).toBe('favicons/acme-favicon.svg')
  })
  it('paths are unique across every preset × background combination', () => {
    const brand = 'acme'
    const bgs = ['transparent', 'white', 'dark'] as const
    const paths = SOCIAL_PRESETS.flatMap((p) => bgs.map((b) => socialFileName(p, b, brand)))
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('countKitFiles', () => {
  it('counts presets×backgrounds + favicons + svg', () => {
    expect(countKitFiles([...SOCIAL_PRESETS], ['white', 'dark'], [16, 32], true)).toBe(
      SOCIAL_PRESETS.length * 2 + 2 + 1,
    )
    expect(countKitFiles([...SOCIAL_PRESETS], ['white'], [16, 32, 48, 180], false)).toBe(
      SOCIAL_PRESETS.length + 4,
    )
  })
})

describe('buildManifest', () => {
  it('summarises brand, contents and sizes', () => {
    const md = buildManifest({
      brandName: 'Origin Coffee',
      generatedAtLabel: 'Jul 2, 2026',
      presets: [...SOCIAL_PRESETS],
      backgrounds: ['transparent', 'white', 'dark'],
      faviconSizes: [16, 32, 48, 180],
      includeSvgFavicon: true,
    })
    expect(md).toContain('Origin Coffee — Brand Asset Kit')
    expect(md).toContain('Jul 2, 2026')
    expect(md).toContain('Transparent, White, Dark')
    expect(md).toContain('16×16, 32×32, 48×48, 180×180 PNG + SVG')
    expect(md).toContain(SOCIAL_PRESETS[0].label)
  })
  it('falls back to "Brand" and omits SVG when not included', () => {
    const md = buildManifest({
      brandName: '   ',
      generatedAtLabel: 'today',
      presets: [],
      backgrounds: ['white'],
      faviconSizes: [32],
      includeSvgFavicon: false,
    })
    expect(md).toContain('Brand — Brand Asset Kit')
    expect(md).toContain('32×32 PNG')
    expect(md).not.toContain('+ SVG')
  })
})
