import { describe, it, expect } from 'vitest'
import { buildReplyMime } from '@/lib/inbox/reply-mime'

const base = {
  asUser: 'support@tonydurante.us',
  replyTo: '"Tamás Fazekas" <fazekastamas28@gmail.com>',
  subject: 'Re: LLC',
  inReplyTo: '<msg-1@mail.gmail.com>',
  references: '<msg-0@mail.gmail.com>',
  message: 'Hi Tamás,\n\nHere is the answer.\n\nBest,\nAntonio',
  lastBody: 'Hi Tony,\n\nCould you explain the difference?',
  lastDate: 'Tue, 8 Jul 2026 11:35:00 -0400',
  lastFrom: '"Tamás Fazekas" <fazekastamas28@gmail.com>',
  boundary: 'td_test',
}

function decodePart(raw: string, contentType: string): string {
  const marker = `Content-Type: ${contentType}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
  const start = raw.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const rest = raw.slice(start + marker.length)
  const b64 = rest.slice(0, rest.indexOf('\r\n--td_test'))
  return Buffer.from(b64, 'base64').toString('utf-8')
}

describe('buildReplyMime', () => {
  const raw = buildReplyMime(base)
  const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'))

  it('produces pure-ASCII headers (no mojibake for accented names)', () => {
    expect(/^[\x20-\x7E\r\n]+$/.test(headerBlock)).toBe(true)
    expect(headerBlock).toContain(
      `To: =?utf-8?B?${Buffer.from('Tamás Fazekas', 'utf-8').toString('base64')}?= <fazekastamas28@gmail.com>`
    )
  })

  it('threads correctly (In-Reply-To + accumulated References)', () => {
    expect(headerBlock).toContain('In-Reply-To: <msg-1@mail.gmail.com>')
    expect(headerBlock).toContain('References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>')
  })

  it('is multipart/alternative with both parts decoding back to the content', () => {
    expect(headerBlock).toContain('Content-Type: multipart/alternative; boundary="td_test"')
    const plain = decodePart(raw, 'text/plain')
    expect(plain).toContain('Hi Tamás,')
    expect(plain).toContain('> Could you explain the difference?')
    expect(plain).toContain('wrote:')
    const html = decodePart(raw, 'text/html')
    expect(html).toContain('Here is the answer.<br />')
    expect(html).toContain('gmail_quote')
    expect(html).toContain('<blockquote')
    // Quoted history is HTML-escaped (attacker-controlled text)
    expect(html).not.toContain('<fazekastamas28@gmail.com>')
    expect(raw.trimEnd().endsWith('--td_test--')).toBe(true)
  })

  it('omits the quote blocks when there is no last body', () => {
    const noQuote = buildReplyMime({ ...base, lastBody: '' })
    const plain = decodePart(noQuote, 'text/plain')
    expect(plain).not.toContain('wrote:')
    const html = decodePart(noQuote, 'text/html')
    expect(html).not.toContain('gmail_quote')
  })

  it('handles empty references (first reply in a thread)', () => {
    const first = buildReplyMime({ ...base, references: '' })
    expect(first).toContain('References: <msg-1@mail.gmail.com>')
  })
})
