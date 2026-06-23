import { describe, it, expect } from 'vitest'
import { countryToTimeZone } from '@/lib/portal/client-timezone'

describe('countryToTimeZone', () => {
  it('maps clean country names', () => {
    expect(countryToTimeZone('Italy')).toEqual({ tz: 'Europe/Rome', label: 'Italy' })
    expect(countryToTimeZone('Portugal')).toEqual({ tz: 'Europe/Lisbon', label: 'Portugal' })
    expect(countryToTimeZone('Malta')).toEqual({ tz: 'Europe/Malta', label: 'Malta' })
    expect(countryToTimeZone('United Arab Emirates')).toEqual({ tz: 'Asia/Dubai', label: 'UAE' })
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(countryToTimeZone('PORTUGAL')?.tz).toBe('Europe/Lisbon')
    expect(countryToTimeZone('  italy  ')?.tz).toBe('Europe/Rome')
    expect(countryToTimeZone('Italy\n')?.tz).toBe('Europe/Rome')
  })

  it('handles native spellings / aliases', () => {
    expect(countryToTimeZone('Italia')?.tz).toBe('Europe/Rome') // IT spelling
    expect(countryToTimeZone('UAE')?.tz).toBe('Asia/Dubai')
    expect(countryToTimeZone('UK')?.tz).toBe('Europe/London')
    expect(countryToTimeZone('USA')?.tz).toBe('America/New_York')
    expect(countryToTimeZone('Brasil')?.tz).toBe('America/Sao_Paulo')
    expect(countryToTimeZone('Deutschland')?.tz).toBe('Europe/Berlin')
  })

  it('strips accents (España → Spain)', () => {
    expect(countryToTimeZone('España')?.tz).toBe('Europe/Madrid')
  })

  it('multi-timezone countries resolve to their main timezone', () => {
    expect(countryToTimeZone('United States')?.tz).toBe('America/New_York')
    expect(countryToTimeZone('Canada')?.tz).toBe('America/Toronto')
    expect(countryToTimeZone('Australia')?.tz).toBe('Australia/Sydney')
    expect(countryToTimeZone('Mexico')?.tz).toBe('America/Mexico_City')
  })

  it('returns null for empty / unknown (caller falls back to browser)', () => {
    expect(countryToTimeZone(null)).toBeNull()
    expect(countryToTimeZone(undefined)).toBeNull()
    expect(countryToTimeZone('')).toBeNull()
    expect(countryToTimeZone('   ')).toBeNull()
    expect(countryToTimeZone('Atlantis')).toBeNull()
    expect(countryToTimeZone('123')).toBeNull()
  })

  it('every mapped timezone is a valid IANA zone (Intl accepts it)', () => {
    const samples = ['Italy', 'Portugal', 'UAE', 'Hungary', 'Albania', 'Thailand', 'Paraguay', 'United States', 'Australia', 'Brazil', 'India', 'Japan']
    for (const c of samples) {
      const z = countryToTimeZone(c)!
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: z.tz }).format(new Date(0))).not.toThrow()
    }
  })
})
