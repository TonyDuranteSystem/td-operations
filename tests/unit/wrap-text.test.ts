import { describe, it, expect } from 'vitest'
import { wrapPdfText, wrapPdfParagraphs, type TextMeasurer } from '@/lib/pdf/wrap-text'

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

  it('wraps a long no-newline message onto multiple lines (locks in the fixed under-count bug)', () => {
    // A single long sentence with no line breaks at all — the common case.
    // 100+ chars at charWidth 5, maxWidth 240 => ~48 chars/line => 3+ lines.
    const message =
      'Please remit payment within 30 days of the invoice date to avoid a late fee being applied to your account balance.'
    const lines = wrapPdfText(message, fakeFont(), 9, 240)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ').split(/\s+/)).toEqual(message.split(/\s+/))
  })
})

describe('wrapPdfParagraphs', () => {
  it('returns empty array for empty/null-ish text', () => {
    expect(wrapPdfParagraphs('', fakeFont(), 9, 100)).toEqual([])
  })

  it('behaves identically to wrapPdfText for a message with no line breaks (no regression)', () => {
    const message = 'Net 30 — please pay by the due date shown above.'
    expect(wrapPdfParagraphs(message, fakeFont(), 9, 100)).toEqual(
      wrapPdfText(message, fakeFont(), 9, 100),
    )
  })

  it('pins the real INV-002516 message: preserves the blank line and never merges lines across a break', () => {
    // The exact stored payments.message value that produced the reported
    // overlapping-text bug (dev job 9eb541a5) — verified live 2026-09-06.
    const message =
      'Bank Transfer:\nBeneficiary: TONY DURANTE L.L.C.\nAccount: 200000306770\nRouting: 064209588\nBank: Relay Financial\n\nCard payment available upon request.'
    const lines = wrapPdfParagraphs(message, fakeFont(1000), 9, 100000) // charWidth huge so nothing word-wraps, isolating the paragraph split
    expect(lines).toEqual([
      'Bank Transfer:',
      'Beneficiary: TONY DURANTE L.L.C.',
      'Account: 200000306770',
      'Routing: 064209588',
      'Bank: Relay Financial',
      '', // the blank line from \n\n — must be preserved, not dropped
      'Card payment available upon request.',
    ])
  })

  it('treats \\r\\n as one break, not two, so a CRLF message gets no spurious blank line', () => {
    const message = 'Line one\r\nLine two'
    expect(wrapPdfParagraphs(message, fakeFont(1000), 9, 100000)).toEqual(['Line one', 'Line two'])
  })

  it('treats a form-feed as a break too, matching pdf-lib\'s own newline set', () => {
    const message = 'Line one\fLine two'
    expect(wrapPdfParagraphs(message, fakeFont(1000), 9, 100000)).toEqual(['Line one', 'Line two'])
  })

  it('treats a whitespace-only line the same as a fully blank line', () => {
    const message = 'A\n   \nB'
    expect(wrapPdfParagraphs(message, fakeFont(1000), 9, 100000)).toEqual(['A', '', 'B'])
  })

  it('word-wraps a long paragraph within a multi-paragraph message independently per paragraph', () => {
    // Paragraph 1 is short (fits on one line); paragraph 2 is long enough to
    // itself wrap into 2 lines — confirms wrapPdfText still runs per-paragraph.
    const message = 'Hi.\naaaa bbbb cccc'
    const lines = wrapPdfParagraphs(message, fakeFont(), 9, 50) // maxWidth 50 => 10 chars/line
    expect(lines).toEqual(['Hi.', 'aaaa bbbb', 'cccc'])
  })
})
