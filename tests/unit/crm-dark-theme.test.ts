import { describe, it, expect } from 'vitest'
import colors from 'tailwindcss/colors'
import {
  buildDarkVariables,
  buildKindColors,
  darkShade,
  hexToChannels,
  varName,
} from '@/lib/theme/crm-dark-palette'
import {
  THEME_PRE_PAINT_SCRIPT,
  nextThemePref,
  normalizeThemePref,
  resolveIsDark,
} from '@/lib/theme/crm-theme'

const stock = colors as unknown as Record<string, Record<string, string>>

describe('hexToChannels', () => {
  it('converts 6 and 3 digit hex', () => {
    expect(hexToChannels('#f4f4f5')).toBe('244 244 245')
    expect(hexToChannels('#fff')).toBe('255 255 255')
  })
})

describe('light mode is untouched', () => {
  it('every colour carries the stock light value as its fallback', () => {
    const bg = buildKindColors('bg') as Record<string, Record<string, string>>
    expect(bg.zinc['100']).toBe('rgb(var(--c-bg-zinc-100, 244 244 245) / <alpha-value>)')
    expect(bg.green['100']).toContain(hexToChannels(stock.green['100']))
  })
  it('white falls back to 255 for fills and borders; text-white has no remap', () => {
    expect(buildKindColors('bg').white).toBe('rgb(var(--c-bg-white, 255 255 255) / <alpha-value>)')
    expect(buildKindColors('border').white).toContain('255 255 255')
    expect(buildKindColors('text').white).toBeUndefined()
  })
})

describe('dark mapping', () => {
  it('flips surfaces and text, keeps solid button shades', () => {
    expect(darkShade('bg', 'zinc', 50)).toBe(950)
    expect(darkShade('bg', 'green', 100)).toBe(900)
    expect(darkShade('text', 'green', 800)).toBe(200)
    expect(darkShade('text', 'zinc', 900)).toBe(50)
    // bg-blue-600 / hover:bg-blue-700 buttons must not change
    expect(darkShade('bg', 'blue', 600)).toBe(600)
    expect(darkShade('bg', 'blue', 700)).toBe(700)
    expect(darkShade('text', 'zinc', 400)).toBe(400)
  })
  it('only emits variables that differ, and sets the white surface', () => {
    const v = buildDarkVariables()
    expect(v['--c-bg-white']).toBe(hexToChannels(stock.zinc['900']))
    expect(v[varName('bg', 'zinc', 50)]).toBe(hexToChannels(stock.zinc['950']))
    expect(v[varName('bg', 'blue', 600)]).toBeUndefined()
    expect(v[varName('text', 'zinc', 400)]).toBeUndefined()
  })
})

describe('theme preference', () => {
  it('normalises junk to auto', () => {
    expect(normalizeThemePref(null)).toBe('auto')
    expect(normalizeThemePref('purple')).toBe('auto')
    expect(normalizeThemePref('dark')).toBe('dark')
    expect(normalizeThemePref('light')).toBe('light')
  })
  it('resolves explicit choices over the system, auto follows the system', () => {
    expect(resolveIsDark('dark', false)).toBe(true)
    expect(resolveIsDark('light', true)).toBe(false)
    expect(resolveIsDark('auto', true)).toBe(true)
    expect(resolveIsDark('auto', false)).toBe(false)
  })
  it('cycles auto -> light -> dark -> auto', () => {
    expect(nextThemePref('auto')).toBe('light')
    expect(nextThemePref('light')).toBe('dark')
    expect(nextThemePref('dark')).toBe('auto')
  })
  it('pre-paint script is valid JS and uses the shared key/class', () => {
    expect(() => new Function(THEME_PRE_PAINT_SCRIPT)).not.toThrow()
    expect(THEME_PRE_PAINT_SCRIPT).toContain('"td-theme"')
    expect(THEME_PRE_PAINT_SCRIPT).toContain('"crm-dark"')
  })
})
