import { describe, it, expect } from 'vitest'
import { mergeCommSettings, DEFAULT_COMM_SETTINGS } from '@/lib/td-communication/comm-settings'

describe('mergeCommSettings', () => {
  it('returns defaults for null/empty stored value', () => {
    expect(mergeCommSettings(null)).toEqual(DEFAULT_COMM_SETTINGS)
    expect(mergeCommSettings(undefined)).toEqual(DEFAULT_COMM_SETTINGS)
    expect(mergeCommSettings({})).toEqual(DEFAULT_COMM_SETTINGS)
  })

  it('default enabled is true (preserves current teaser visibility)', () => {
    expect(DEFAULT_COMM_SETTINGS.enabled).toBe(true)
    expect(mergeCommSettings({}).enabled).toBe(true)
  })

  it('applies stored overrides', () => {
    const r = mergeCommSettings({ enabled: false, disclaimer_en: 'Hi', default_sla_days: 14 })
    expect(r.enabled).toBe(false)
    expect(r.disclaimer_en).toBe('Hi')
    expect(r.default_sla_days).toBe(14)
    expect(r.disclaimer_it).toBe('') // untouched → default
  })

  it('ignores malformed types and falls back to defaults', () => {
    const r = mergeCommSettings({
      // @ts-expect-error bad types on purpose
      enabled: 'yes',
      // @ts-expect-error bad types on purpose
      default_sla_days: 'soon',
    })
    expect(r.enabled).toBe(true)
    expect(r.default_sla_days).toBe(7)
  })

  it('rejects a negative sla', () => {
    expect(mergeCommSettings({ default_sla_days: -3 }).default_sla_days).toBe(7)
  })

  it('allows zero sla', () => {
    expect(mergeCommSettings({ default_sla_days: 0 }).default_sla_days).toBe(0)
  })
})
