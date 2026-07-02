import { describe, it, expect } from 'vitest'
import {
  MOCKUP_TEMPLATES,
  getMockupTemplate,
  clampScale,
  scaledPlacement,
  escapeXmlAttr,
  renderMockupSvg,
} from '@/lib/td-communication/mockup-templates'

describe('registry', () => {
  it('has the four expected templates with unique ids and positive dims', () => {
    const ids = MOCKUP_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(['business_card', 'letterhead', 'social_post', 'website'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of MOCKUP_TEMPLATES) {
      expect(t.width).toBeGreaterThan(0)
      expect(t.height).toBeGreaterThan(0)
      expect(t.logoArea.w).toBeGreaterThan(0)
      expect(t.logoArea.h).toBeGreaterThan(0)
    }
  })
  it('getMockupTemplate finds / misses', () => {
    expect(getMockupTemplate('social_post')?.label).toBe('Social Post')
    expect(getMockupTemplate('nope')).toBeUndefined()
  })
})

describe('clampScale', () => {
  it('clamps to [0.5, 1.5] and defaults to 1', () => {
    expect(clampScale(undefined)).toBe(1)
    expect(clampScale(NaN)).toBe(1)
    expect(clampScale(0.1)).toBe(0.5)
    expect(clampScale(9)).toBe(1.5)
    expect(clampScale(1.2)).toBe(1.2)
  })
})

describe('scaledPlacement', () => {
  it('keeps the centre fixed while scaling', () => {
    const base = { x: 100, y: 100, w: 200, h: 100 }
    const up = scaledPlacement(base, 1.5)
    const cxBase = base.x + base.w / 2
    const cyBase = base.y + base.h / 2
    expect(up.x + up.w / 2).toBeCloseTo(cxBase, 6)
    expect(up.y + up.h / 2).toBeCloseTo(cyBase, 6)
    expect(up.w).toBeCloseTo(300, 6)
    expect(up.h).toBeCloseTo(150, 6)
  })
  it('scale 1 is identity', () => {
    const base = { x: 10, y: 20, w: 30, h: 40 }
    expect(scaledPlacement(base, 1)).toEqual(base)
  })
})

describe('escapeXmlAttr', () => {
  it('escapes the dangerous characters', () => {
    expect(escapeXmlAttr('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })
  it('leaves a data URL intact enough to round-trip in an attribute', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo+/='
    // no &, <, >, " in a base64 data URL → unchanged
    expect(escapeXmlAttr(dataUrl)).toBe(dataUrl)
  })
})

describe('renderMockupSvg', () => {
  it('returns a well-formed svg with the right viewBox', () => {
    const svg = renderMockupSvg('business_card', { bg: '#ffffff', logoHref: null })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 1050 600"')
    expect(svg.trim().endsWith('</svg>')).toBe(true)
  })
  it('embeds the bg colour and the logo href', () => {
    const svg = renderMockupSvg('social_post', { bg: '#123456', logoHref: 'blob:xyz' })
    expect(svg).toContain('#123456')
    expect(svg).toContain('href="blob:xyz"')
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
  })
  it('omits the image tag when there is no logo', () => {
    const svg = renderMockupSvg('website', { bg: '#ffffff', logoHref: null })
    expect(svg).not.toContain('<image')
  })
  it('falls back to the recommended bg on an invalid colour', () => {
    const svg = renderMockupSvg('social_post', { bg: 'not-a-color', logoHref: null })
    // social_post recommendedBg = #111111
    expect(svg).toContain('#111111')
  })
  it('applies the logo scale to the image rect', () => {
    const big = renderMockupSvg('business_card', { bg: '#fff', logoHref: 'blob:x', logoScale: 1.5 })
    const small = renderMockupSvg('business_card', { bg: '#fff', logoHref: 'blob:x', logoScale: 0.5 })
    const wBig = Number(/width="(\d+\.?\d*)" height="[\d.]+" preserveAspectRatio/.exec(big)?.[1])
    const wSmall = Number(/width="(\d+\.?\d*)" height="[\d.]+" preserveAspectRatio/.exec(small)?.[1])
    expect(wBig).toBeGreaterThan(wSmall)
  })
  it('returns empty string for an unknown template', () => {
    expect(renderMockupSvg('nope', { bg: '#fff', logoHref: null })).toBe('')
  })
  it('escapes a logo href containing a quote (no attribute break-out)', () => {
    const svg = renderMockupSvg('website', { bg: '#fff', logoHref: 'blob:"onerror=' })
    expect(svg).not.toContain('href="blob:"onerror=')
    expect(svg).toContain('&quot;')
  })
})
