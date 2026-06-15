import { describe, it, expect } from 'vitest'
import {
  normalizeStateCode,
  resolveSecretaryOfStateLink,
} from '@/lib/flows/state-links'
import { formatBytes, formatUploadDate } from '@/lib/flows/workspace-format'

describe('normalizeStateCode', () => {
  it('maps full names to codes (case-insensitive, trimmed)', () => {
    expect(normalizeStateCode('Wyoming')).toBe('WY')
    expect(normalizeStateCode('  florida ')).toBe('FL')
    expect(normalizeStateCode('DELAWARE')).toBe('DE')
    expect(normalizeStateCode('New Mexico')).toBe('NM')
    expect(normalizeStateCode('Massachusetts')).toBe('MA')
  })

  it('passes through 2-letter codes', () => {
    expect(normalizeStateCode('WY')).toBe('WY')
    expect(normalizeStateCode('nm')).toBe('NM')
  })

  it('returns null for unknown / empty / nullish', () => {
    expect(normalizeStateCode('California')).toBeNull()
    expect(normalizeStateCode('')).toBeNull()
    expect(normalizeStateCode('   ')).toBeNull()
    expect(normalizeStateCode(null)).toBeNull()
    expect(normalizeStateCode(undefined)).toBeNull()
  })
})

describe('resolveSecretaryOfStateLink', () => {
  it('resolves portal URLs for states with annual reports', () => {
    expect(resolveSecretaryOfStateLink('Wyoming').url).toBe('https://wyobiz.wyo.gov/')
    expect(resolveSecretaryOfStateLink('FL').url).toBe('https://dos.fl.gov/sunbiz/')
    expect(resolveSecretaryOfStateLink('Delaware').url).toBe(
      'https://icis.corp.delaware.gov/ecorp/logintax.aspx',
    )
  })

  it('flags New Mexico as having no annual report (no URL)', () => {
    const nm = resolveSecretaryOfStateLink('New Mexico')
    expect(nm.stateCode).toBe('NM')
    expect(nm.url).toBeNull()
    expect(nm.noAnnualReport).toBe(true)
  })

  it('returns no URL for recognized-but-unmapped and unknown states', () => {
    const ma = resolveSecretaryOfStateLink('Massachusetts')
    expect(ma.stateCode).toBe('MA')
    expect(ma.url).toBeNull()
    expect(ma.noAnnualReport).toBe(false)

    const unknown = resolveSecretaryOfStateLink('California')
    expect(unknown.stateCode).toBeNull()
    expect(unknown.url).toBeNull()
    expect(unknown.noAnnualReport).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('returns null for invalid input', () => {
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes(undefined)).toBeNull()
    expect(formatBytes(-1)).toBeNull()
    expect(formatBytes(NaN)).toBeNull()
  })
})

describe('formatUploadDate', () => {
  it('formats an ISO timestamp to a short US date', () => {
    expect(formatUploadDate('2026-06-14T12:00:00Z')).toBe('Jun 14, 2026')
  })

  it('returns null for nullish / invalid', () => {
    expect(formatUploadDate(null)).toBeNull()
    expect(formatUploadDate(undefined)).toBeNull()
    expect(formatUploadDate('not-a-date')).toBeNull()
  })
})
