import { describe, it, expect } from 'vitest'
import { sanitizeForPdf } from '@/lib/form-to-drive'

describe('sanitizeForPdf', () => {
  it('passes through plain ASCII unchanged', () => {
    expect(sanitizeForPdf('Tony Durante LLC')).toBe('Tony Durante LLC')
  })

  it('passes through full Latin-1 range (U+00 – U+FF)', () => {
    expect(sanitizeForPdf('Ñoño café über naïve')).toBe('Ñoño café über naïve')
  })

  it('maps Maltese h-bar (ħ / Ħ) to ASCII h / H', () => {
    expect(sanitizeForPdf('Ħal Safi')).toBe('Hal Safi')
    expect(sanitizeForPdf('id-daħla')).toBe('id-dahla')
  })

  it('maps Maltese g-dot (ġ / Ġ)', () => {
    expect(sanitizeForPdf('Ġorġ')).toBe('Gorg')
  })

  it('maps Maltese c-dot (ċ / Ċ)', () => {
    expect(sanitizeForPdf('Ċittadin')).toBe('Cittadin')
    expect(sanitizeForPdf('tieġċ')).toBe('tiegc')
  })

  it('maps Maltese z-dot (ż / Ż)', () => {
    expect(sanitizeForPdf('Żebbuġ')).toBe('Zebbug')
    expect(sanitizeForPdf('żwieġ')).toBe('zwieg')
  })

  it('replaces any other non-Latin-1 char with "?"', () => {
    expect(sanitizeForPdf('hello 中文 world')).toBe('hello ?? world')
    expect(sanitizeForPdf('emoji 😀')).toBe('emoji ??')  // surrogate pair → 2 replacements
  })

  it('handles empty string', () => {
    expect(sanitizeForPdf('')).toBe('')
  })
})
