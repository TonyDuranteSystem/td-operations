import { describe, it, expect } from 'vitest'
import {
  buildRenewalFilename,
  buildAccountNoteEntry,
  yearFromFiledDate,
  isItalianLang,
  buildNotificationContent,
} from '@/lib/operations/file-renewal'

describe('buildRenewalFilename', () => {
  it('builds RA Renewal filename per SOP v7.0', () => {
    expect(buildRenewalFilename('ra', 2027)).toBe('RA Renewal 2027.pdf')
  })
  it('builds Annual Report filename per SOP v7.0', () => {
    expect(buildRenewalFilename('ar', 2027)).toBe('Annual Report 2027.pdf')
  })
  it('different years produce different filenames', () => {
    expect(buildRenewalFilename('ra', 2026)).toBe('RA Renewal 2026.pdf')
    expect(buildRenewalFilename('ar', 2028)).toBe('Annual Report 2028.pdf')
  })
})

describe('yearFromFiledDate', () => {
  it('extracts year from valid YYYY-MM-DD', () => {
    expect(yearFromFiledDate('2027-03-09')).toBe(2027)
    expect(yearFromFiledDate('2026-12-31')).toBe(2026)
    expect(yearFromFiledDate('2030-01-01')).toBe(2030)
  })
  it('rejects malformed input', () => {
    expect(() => yearFromFiledDate('27-03-09')).toThrow()
    expect(() => yearFromFiledDate('2027/03/09')).toThrow()
    expect(() => yearFromFiledDate('not a date')).toThrow()
    expect(() => yearFromFiledDate('')).toThrow()
  })
  it('rejects non-numeric year segment', () => {
    expect(() => yearFromFiledDate('abcd-03-09')).toThrow()
  })
})

describe('isItalianLang', () => {
  it('matches ISO and full-name forms (case-insensitive)', () => {
    expect(isItalianLang('it')).toBe(true)
    expect(isItalianLang('IT')).toBe(true)
    expect(isItalianLang('italian')).toBe(true)
    expect(isItalianLang('Italian')).toBe(true)
  })
  it('returns false for null / undefined / empty / other languages', () => {
    expect(isItalianLang(null)).toBe(false)
    expect(isItalianLang(undefined)).toBe(false)
    expect(isItalianLang('')).toBe(false)
    expect(isItalianLang('en')).toBe(false)
    expect(isItalianLang('English')).toBe(false)
    expect(isItalianLang('es')).toBe(false)
  })
})

describe('buildAccountNoteEntry', () => {
  it('appends a dated entry when prior notes exist', () => {
    const result = buildAccountNoteEntry('ra', 2027, '2027-03-09', 'https://drive/x', 'old note')
    expect(result).toBe('old note\n2027-03-09: RA Renewal 2027 filed → https://drive/x')
  })
  it('creates a fresh note when no prior notes', () => {
    const result = buildAccountNoteEntry('ar', 2027, '2027-05-01', 'https://drive/y', null)
    expect(result).toBe('2027-05-01: Annual Report 2027 filed → https://drive/y')
  })
  it('uses kind-specific label', () => {
    expect(buildAccountNoteEntry('ra', 2027, '2027-01-01', 'L', null)).toContain('RA Renewal')
    expect(buildAccountNoteEntry('ar', 2027, '2027-01-01', 'L', null)).toContain('Annual Report')
  })
  it('preserves multi-line existing notes', () => {
    const prior = 'line 1\nline 2'
    const result = buildAccountNoteEntry('ra', 2027, '2027-03-09', 'L', prior)
    expect(result).toBe('line 1\nline 2\n2027-03-09: RA Renewal 2027 filed → L')
  })
})

describe('buildNotificationContent — RA renewal', () => {
  it('uses English copy for non-Italian client', () => {
    const r = buildNotificationContent('ra', 'Florida', 2027, false)
    expect(r.title).toBe('Registered Agent Renewed')
    expect(r.body).toBe('Your Registered Agent has been renewed for another year.')
  })
  it('uses Italian copy for Italian client', () => {
    const r = buildNotificationContent('ra', 'Florida', 2027, true)
    expect(r.title).toBe('Registered Agent rinnovato')
    expect(r.body).toBe('Il tuo Registered Agent è stato rinnovato per un altro anno.')
  })
  it('does not depend on state for RA copy (RA is state-agnostic in the message)', () => {
    const a = buildNotificationContent('ra', 'Florida', 2027, false)
    const b = buildNotificationContent('ra', 'Wyoming', 2027, false)
    expect(a.body).toBe(b.body)
  })
})

describe('buildNotificationContent — Annual Report', () => {
  it('English copy includes state and year', () => {
    const r = buildNotificationContent('ar', 'Florida', 2027, false)
    expect(r.title).toBe('Annual Report Florida Filed')
    expect(r.body).toBe('Your Annual Report for Florida has been filed for 2027.')
  })
  it('Italian copy includes state and year', () => {
    const r = buildNotificationContent('ar', 'Florida', 2027, true)
    expect(r.title).toBe('Annual Report Florida archiviato')
    expect(r.body).toBe('Il tuo Annual Report per Florida è stato archiviato per 2027.')
  })
  it('falls back to placeholder when state is empty', () => {
    const en = buildNotificationContent('ar', '', 2027, false)
    expect(en.body).toContain('your state')
    const it = buildNotificationContent('ar', '', 2027, true)
    expect(it.body).toContain('il tuo stato')
  })
  it('different states produce different titles', () => {
    const fl = buildNotificationContent('ar', 'Florida', 2027, false)
    const de = buildNotificationContent('ar', 'Delaware', 2027, false)
    expect(fl.title).not.toBe(de.title)
  })
})
