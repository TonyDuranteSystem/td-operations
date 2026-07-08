import { describe, it, expect } from 'vitest'
import { escapeHtml, splitQuotedText } from '@/lib/inbox/email-quote'
import { encodeAddressHeader, extractBodyWithType } from '@/lib/gmail'

describe('escapeHtml', () => {
  it('escapes the HTML metacharacters', () => {
    expect(escapeHtml('a <b> & "c"')).toBe('a &lt;b&gt; &amp; &quot;c&quot;')
  })
  it('passes plain text through', () => {
    expect(escapeHtml('Hi Tamás,\nline two')).toBe('Hi Tamás,\nline two')
  })
})

describe('splitQuotedText', () => {
  it('splits at the "On ... wrote:" attribution followed by quote lines', () => {
    const text =
      'Thanks, will do.\n\nOn Jul 8, 2026, 11:35 AM, "Tamás" <t@x.com> wrote:\n> Hi Tony,\n> question here'
    const r = splitQuotedText(text)
    expect(r.main).toBe('Thanks, will do.')
    expect(r.quoted).toContain('> Hi Tony,')
  })
  it('splits a trailing bare "> " block', () => {
    const r = splitQuotedText('New content.\n> old line 1\n> old line 2')
    expect(r.main).toBe('New content.')
    expect(r.quoted).toBe('> old line 1\n> old line 2')
  })
  it('keeps everything in main when quotes are mid-message', () => {
    const r = splitQuotedText('He said:\n> quoted\nand I disagree.')
    expect(r.quoted).toBeNull()
    expect(r.main).toContain('and I disagree.')
  })
  it('handles messages with no quoting', () => {
    const r = splitQuotedText('Just a plain reply.\n\nBest,\nAntonio')
    expect(r.quoted).toBeNull()
  })
  it('supports the Italian attribution', () => {
    const r = splitQuotedText('Va bene.\n\nIl 8 lug 2026, Mario Rossi ha scritto:\n> Ciao')
    expect(r.main).toBe('Va bene.')
    expect(r.quoted).toContain('> Ciao')
  })
})

describe('encodeAddressHeader', () => {
  it('passes ASCII addresses through unchanged', () => {
    expect(encodeAddressHeader('"John Smith" <j@x.com>')).toBe('"John Smith" <j@x.com>')
    expect(encodeAddressHeader('j@x.com')).toBe('j@x.com')
  })
  it('RFC 2047-encodes a non-ASCII display name', () => {
    const out = encodeAddressHeader('"Tamás Fazekas" <fazekastamas28@gmail.com>')
    expect(out).toBe(
      `=?utf-8?B?${Buffer.from('Tamás Fazekas', 'utf-8').toString('base64')}?= <fazekastamas28@gmail.com>`
    )
    expect(/^[\x20-\x7E]+$/.test(out)).toBe(true) // pure ASCII header
  })
  it('encodes unquoted non-ASCII names too', () => {
    const out = encodeAddressHeader('Tamás <t@x.com>')
    expect(out).toContain('=?utf-8?B?')
    expect(out.endsWith('<t@x.com>')).toBe(true)
  })
})

describe('extractBodyWithType', () => {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  it('reports html when the html part is chosen', () => {
    const r = extractBodyWithType({
      headers: [],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain') } },
        { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
      ],
    })
    expect(r).toEqual({ body: '<p>html</p>', isHtml: true })
  })
  it('reports plain when only text/plain exists — even if it contains <angle brackets>', () => {
    const r = extractBodyWithType({
      headers: [],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('reply quoting "X" <x@y.com>') } },
      ],
    })
    expect(r.isHtml).toBe(false)
    expect(r.body).toContain('<x@y.com>')
  })
  it('uses the message mimeType for direct single-part bodies', () => {
    expect(
      extractBodyWithType({ headers: [], mimeType: 'text/plain', body: { data: b64('hi') } })
    ).toEqual({ body: 'hi', isHtml: false })
    expect(
      extractBodyWithType({ headers: [], mimeType: 'text/html', body: { data: b64('<b>hi</b>') } })
        .isHtml
    ).toBe(true)
  })
})
