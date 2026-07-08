import { describe, it, expect } from 'vitest'
import { rewriteCidSources, decodeHtmlEntities, displayNameFromHeader } from '@/lib/inbox/email-html'
import { extractInlineImages, type GmailAPIMessage } from '@/lib/gmail'

describe('decodeHtmlEntities', () => {
  it('decodes the entities Gmail snippets actually contain', () => {
    expect(decodeHtmlEntities('Hi Tony, I hope you&#39;re doing well')).toBe(
      "Hi Tony, I hope you're doing well"
    )
    expect(decodeHtmlEntities('Q&amp;A &quot;quoted&quot; &lt;tag&gt;&nbsp;x')).toBe(
      'Q&A "quoted" <tag> x'
    )
    expect(decodeHtmlEntities('hex: &#x27;ok&#x27;')).toBe("hex: 'ok'")
  })

  it('does not double-decode (&amp; handled last) and survives bad codes', () => {
    expect(decodeHtmlEntities('&amp;#39;')).toBe('&#39;')
    expect(decodeHtmlEntities('&#99999999; stays')).toBe('&#99999999; stays')
    expect(decodeHtmlEntities('')).toBe('')
  })
})

describe('displayNameFromHeader', () => {
  it('strips the address part and RFC 2822 quotes', () => {
    expect(displayNameFromHeader('"Tamás Fazekas" <tamas@x.com>')).toBe('Tamás Fazekas')
    expect(displayNameFromHeader('Mario Rossi <mario@x.com>')).toBe('Mario Rossi')
  })

  it('returns empty for bare addresses and handles empty input', () => {
    expect(displayNameFromHeader('<bare@x.com>')).toBe('')
    expect(displayNameFromHeader('')).toBe('')
  })
})

describe('rewriteCidSources', () => {
  const resolve = (cid: string) =>
    cid === 'img001' ? '/api/inbox/attachment?attachmentId=abc' : null

  it('rewrites double-quoted cid src to the resolved URL', () => {
    const html = '<p>hi</p><img src="cid:img001" alt="x">'
    expect(rewriteCidSources(html, resolve)).toBe(
      '<p>hi</p><img src="/api/inbox/attachment?attachmentId=abc" alt="x">'
    )
  })

  it('rewrites single-quoted and unquoted cid src', () => {
    expect(rewriteCidSources("<img src='cid:img001'>", resolve)).toContain(
      "src='/api/inbox/attachment?attachmentId=abc'"
    )
    expect(rewriteCidSources('<img src=cid:img001 width=10>', resolve)).toContain(
      'src="/api/inbox/attachment?attachmentId=abc"'
    )
  })

  it('is case-insensitive on SRC and CID scheme', () => {
    expect(rewriteCidSources('<IMG SRC="CID:img001">', resolve)).toContain(
      'attachmentId=abc'
    )
  })

  it('leaves unresolvable cids untouched', () => {
    const html = '<img src="cid:unknown999">'
    expect(rewriteCidSources(html, resolve)).toBe(html)
  })

  it('does not touch normal http/https/data sources', () => {
    const html = '<img src="https://x.com/a.png"><img src="data:image/png;base64,AAA">'
    expect(rewriteCidSources(html, resolve)).toBe(html)
  })

  it('handles empty input', () => {
    expect(rewriteCidSources('', resolve)).toBe('')
  })
})

describe('extractInlineImages', () => {
  function payload(parts: unknown): GmailAPIMessage['payload'] {
    return { headers: [], mimeType: 'multipart/related', parts } as GmailAPIMessage['payload']
  }

  it('extracts Content-ID parts with attachmentId, stripping angle brackets', () => {
    const p = payload([
      {
        mimeType: 'text/html',
        body: { data: 'PGI+aGk8L2I+' },
      },
      {
        mimeType: 'image/png',
        filename: 'screenshot.png',
        headers: [{ name: 'Content-ID', value: '<img001>' }],
        body: { attachmentId: 'att-123', size: 100 },
      },
    ])
    expect(extractInlineImages(p)).toEqual([
      { contentId: 'img001', attachmentId: 'att-123', mimeType: 'image/png' },
    ])
  })

  it('walks nested parts and matches Content-ID case-insensitively', () => {
    const p = payload([
      {
        mimeType: 'multipart/related',
        parts: [
          {
            mimeType: 'image/jpeg',
            headers: [{ name: 'content-id', value: 'photo@mail' }],
            body: { attachmentId: 'att-9' },
          },
        ],
      },
    ])
    expect(extractInlineImages(p)).toEqual([
      { contentId: 'photo@mail', attachmentId: 'att-9', mimeType: 'image/jpeg' },
    ])
  })

  it('ignores non-image parts and parts without attachmentId', () => {
    const p = payload([
      {
        mimeType: 'application/pdf',
        headers: [{ name: 'Content-ID', value: '<doc1>' }],
        body: { attachmentId: 'att-pdf' },
      },
      {
        mimeType: 'image/png',
        headers: [{ name: 'Content-ID', value: '<inline-no-att>' }],
        body: { data: 'AAAA' },
      },
    ])
    expect(extractInlineImages(p)).toEqual([])
  })

  it('returns empty for payloads without parts', () => {
    expect(
      extractInlineImages({ headers: [], mimeType: 'text/html', body: { data: 'x' } })
    ).toEqual([])
  })
})
