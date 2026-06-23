import { describe, it, expect } from 'vitest'
import { parseExport, phonesMatch, personName, digitsOnly } from '../../scripts/whatsapp-parse'

const FIRM = '17274521093'

describe('parseExport', () => {
  it('assigns direction from the firm number and parses timestamps', () => {
    const text = [
      '2026/06/10, 07:48:13 - 393332903858: Good morning',
      '2026/06/10, 07:48:15 - 17274521093: Thank you for contacting Tony Durante!',
    ].join('\n')
    const msgs = parseExport(text, '393332903858', FIRM)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].direction).toBe('inbound')
    expect(msgs[0].senderPhone).toBe('393332903858')
    expect(msgs[0].content).toBe('Good morning')
    expect(msgs[1].direction).toBe('outbound')
    expect(msgs[0].timestamp.getFullYear()).toBe(2026)
  })

  it('appends continuation lines to the previous message', () => {
    const text = [
      '2026/06/10, 14:55:22 - 17274521093: Line one',
      'Line two continues',
      'Line three',
    ].join('\n')
    const msgs = parseExport(text, 'x', FIRM)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('Line one\nLine two continues\nLine three')
  })

  it('skips a leading system line with no digit sender (e2e notice)', () => {
    const text = [
      'Messages and calls are end-to-end encrypted. Tap to learn more.e2e_notification',
      '2026/05/17, 17:00:53 - 15813822116: Hi',
    ].join('\n')
    const msgs = parseExport(text, '15813822116', FIRM)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('Hi')
  })

  it('detects omitted media as content_type media', () => {
    const text = '2026/06/10, 07:48:13 - 393332903858: ‎image omitted'
    const msgs = parseExport(text, '393332903858', FIRM)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].contentType).toBe('media')
  })

  it('returns nothing for content with no parseable message lines', () => {
    expect(parseExport('just a name with no timestamps', '', FIRM)).toEqual([])
  })
})

describe('phonesMatch', () => {
  it('matches identical digit strings regardless of formatting', () => {
    expect(phonesMatch('+39 327 215 4878', '393272154878')).toBe(true)
  })

  it('matches across country-code differences via shared trailing digits', () => {
    // national stored vs full international from the export
    expect(phonesMatch('327 215 4878', '393272154878')).toBe(true)
  })

  it('does not suffix-match short numbers (avoids false client attachment)', () => {
    expect(phonesMatch('4878', '393272154878')).toBe(false)
    expect(phonesMatch('1234567', '393272154878')).toBe(false)
  })

  it('returns false for null/empty inputs', () => {
    expect(phonesMatch(null, '393272154878')).toBe(false)
    expect(phonesMatch('+39 327 215 4878', '')).toBe(false)
    expect(phonesMatch('not a number', '393272154878')).toBe(false)
  })

  it('does not match two different long numbers', () => {
    expect(phonesMatch('+39 333 290 3858', '393272154878')).toBe(false)
  })
})

describe('personName', () => {
  it('prefers full_name', () => {
    expect(personName({ full_name: 'Christian Pozza', first_name: 'C', last_name: 'P' })).toBe('Christian Pozza')
  })

  it('falls back to first + last', () => {
    expect(personName({ full_name: null, first_name: 'Marco', last_name: 'Boschi' })).toBe('Marco Boschi')
  })

  it('returns empty string when nothing is available', () => {
    expect(personName({})).toBe('')
    expect(personName({ full_name: '   ' })).toBe('')
  })
})

describe('digitsOnly', () => {
  it('strips all non-digit characters', () => {
    expect(digitsOnly('+1 (727) 452-1093')).toBe('17274521093')
  })
})
