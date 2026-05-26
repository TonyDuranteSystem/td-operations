import { describe, it, expect } from 'vitest'
import { wrapPdfText, type TextMeasurer } from '@/lib/pdf/wrap-text'

// Fake monospace font: every character is `charWidth` wide regardless of size.
function fakeFont(charWidth = 5): TextMeasurer {
  return {
    widthOfTextAtSize: (text: string) => text.length * charWidth,
  }
}

describe('wrapPdfText', () => {
  it('returns empty array for empty text', () => {
    expect(wrapPdfText('', fakeFont(), 9, 100)).toEqual([])
  })

  it('returns empty array when maxWidth is not positive', () => {
    expect(wrapPdfText('hello world', fakeFont(), 9, 0)).toEqual([])
  })

  it('keeps short text on a single line', () => {
    // "hello" = 5 chars * 5 = 25 <= 100
    expect(wrapPdfText('hello', fakeFont(), 9, 100)).toEqual(['hello'])
  })

  it('wraps onto multiple lines at word boundaries', () => {
    // maxWidth 50 => 10 chars per line. charWidth 5.
    // "aaaa bbbb cccc" : "aaaa bbbb" = 9 chars (45) fits; + " cccc" = 14 (70) overflow.
    const lines = wrapPdfText('aaaa bbbb cccc', fakeFont(), 9, 50)
    expect(lines).toEqual(['aaaa bbbb', 'cccc'])
  })

  it('wraps a realistic 192-char invoice description into several lines', () => {
    const desc =
      'Social media management services for @mastgloves - April 2026 (01/04/2026 – 30/04/2026): content strategy, content creation (reels, posts, stories), community management, performance analysis.'
    // description column ~240pt wide at size 9; approximate with charWidth 5 => 48 chars/line
    const lines = wrapPdfText(desc, fakeFont(), 9, 240)
    expect(lines.length).toBeGreaterThan(1)
    // No line exceeds the width budget.
    for (const line of lines) {
      expect(line.length * 5).toBeLessThanOrEqual(240)
    }
    // Rejoining the words reproduces the original word sequence (no data loss).
    expect(lines.join(' ').split(/\s+/)).toEqual(desc.split(/\s+/))
  })

  it('caps at maxLines and ellipsizes the last kept line', () => {
    // 8 words of 4 chars; maxWidth 50 => up to "aaaa bbbb" (9) per line.
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh'
    const lines = wrapPdfText(text, fakeFont(), 9, 50, { maxLines: 2 })
    expect(lines.length).toBe(2)
    expect(lines[1].endsWith('...')).toBe(true)
    // Ellipsized line still respects the width budget.
    expect(lines[1].length * 5).toBeLessThanOrEqual(50)
  })

  it('breaks a single token longer than maxWidth', () => {
    // 20-char token, maxWidth 50 => 10 chars per chunk.
    const lines = wrapPdfText('aaaaaaaaaaaaaaaaaaaa', fakeFont(), 9, 50)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.length * 5).toBeLessThanOrEqual(50)
    }
    expect(lines.join('')).toBe('aaaaaaaaaaaaaaaaaaaa')
  })
})
