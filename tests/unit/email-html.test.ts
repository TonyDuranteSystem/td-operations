import { describe, it, expect } from 'vitest'
import {
  rewriteCidSources,
  decodeHtmlEntities,
  displayNameFromHeader,
  htmlToPlainText,
  emailSnippet,
  safeEmailDate,
  insertLineBreaksForBlockTags,
} from '@/lib/inbox/email-html'
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
      { contentId: 'img001', attachmentId: 'att-123', mimeType: 'image/png', size: 100 },
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
      { contentId: 'photo@mail', attachmentId: 'att-9', mimeType: 'image/jpeg', size: 0 },
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

describe('htmlToPlainText', () => {
  it('drops style/script/head CONTENT, not just the tags (styled newsletter)', () => {
    const newsletter =
      '<head><title>x</title></head><style>body{margin:0}.wrapper{color:red}</style>' +
      '<script>alert(1)</script><div><p>Hello <b>Antonio</b>,</p><p>your invoice is ready.</p></div>'
    expect(htmlToPlainText(newsletter)).toBe('Hello Antonio, your invoice is ready.')
  })

  it('decodes entities once and collapses whitespace', () => {
    expect(htmlToPlainText('<p>Q&amp;A&nbsp;&nbsp;time</p>\n\n<p>ok</p>')).toBe('Q&A time ok')
    // double-encoded marketing mail must not double-decode
    expect(htmlToPlainText('<p>&amp;nbsp;</p>')).toBe('&nbsp;')
  })

  it('caps multi-MB hostile input instead of regexing all of it', () => {
    const huge = '<p>lead</p>' + 'x'.repeat(5_000_000)
    const out = htmlToPlainText(huge)
    expect(out.startsWith('lead')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(20_000)
  })

  it('handles empty and tag-free input', () => {
    expect(htmlToPlainText('')).toBe('')
    expect(htmlToPlainText('just text')).toBe('just text')
  })
})

describe('emailSnippet', () => {
  it('one line with ellipsis past the cap, honoring the real isHtml flag', () => {
    const s = emailSnippet('line one\nline two\nline three', false, 15)
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(15)
    expect(s).not.toContain('\n')
  })

  it('plain replies quoting an address are NOT treated as HTML when flag says plain', () => {
    // content sniff would call this HTML; the explicit flag must win
    expect(emailSnippet('reply to <a@b.com> ok', false)).toBe('reply to <a@b.com> ok')
  })

  it('sniffs only when the flag is absent (cached payloads)', () => {
    expect(emailSnippet('<p>hi</p>', undefined)).toBe('hi')
  })

  it('empty content → empty snippet', () => {
    expect(emailSnippet('', true)).toBe('')
  })
})

describe('safeEmailDate', () => {
  it('parses a valid Date header', () => {
    expect(safeEmailDate('Tue, 28 Jul 2026 10:00:00 +0000', '123')).toBe(
      '2026-07-28T10:00:00.000Z'
    )
  })

  it('falls back to internalDate on a hostile header instead of throwing', () => {
    expect(safeEmailDate('Never', '1753700000000')).toBe(
      new Date(1753700000000).toISOString()
    )
  })

  it('missing header uses internalDate; both bad → epoch 0, never a throw', () => {
    expect(safeEmailDate('', '1753700000000')).toBe(new Date(1753700000000).toISOString())
    expect(safeEmailDate('Never', 'garbage')).toBe(new Date(0).toISOString())
    expect(safeEmailDate(null, null)).toBe(new Date(0).toISOString())
  })
})

describe('insertLineBreaksForBlockTags', () => {
  // This is a PRE-PROCESSING step run before DOM-based tag stripping (see
  // stripEmailHtml in components/inbox/inbox-shell.tsx) — it only needs to
  // turn closing/self-closing block tags into newlines; opening tags are
  // stripped afterward by innerHTML/textContent, not by this function.

  it('turns adjacent divs into separate lines (the Forward bug, 2026-08-27/28)', () => {
    const html = '<div>Ciao Antonio, come stai?</div><div>ho controllato lo stato...</div>'
    expect(insertLineBreaksForBlockTags(html)).toBe(
      '<div>Ciao Antonio, come stai?\n<div>ho controllato lo stato...\n'
    )
  })

  it('converts <br> to a real newline', () => {
    expect(insertLineBreaksForBlockTags('line one<br>line two')).toBe('line one\nline two')
    expect(insertLineBreaksForBlockTags('line one<br/>line two')).toBe('line one\nline two')
    expect(insertLineBreaksForBlockTags('line one<br />line two')).toBe('line one\nline two')
  })

  it('breaks on </p>, </tr>, </li>, </h1>-</h6>, </blockquote>', () => {
    expect(insertLineBreaksForBlockTags('<p>A</p><p>B</p>')).toBe('<p>A\n<p>B\n')
    expect(insertLineBreaksForBlockTags('<tr><td>A</td></tr><tr><td>B</td></tr>')).toBe(
      '<tr><td>A</td>\n<tr><td>B</td>\n'
    )
    expect(insertLineBreaksForBlockTags('<li>A</li><li>B</li>')).toBe('<li>A\n<li>B\n')
    expect(insertLineBreaksForBlockTags('<h1>Title</h1>body')).toBe('<h1>Title\nbody')
    expect(insertLineBreaksForBlockTags('<blockquote>quoted</blockquote>')).toBe('<blockquote>quoted\n')
  })

  it('leaves inline tags alone (they are not line-break boundaries)', () => {
    expect(insertLineBreaksForBlockTags('<span>A</span><b>B</b>')).toBe('<span>A</span><b>B</b>')
  })

  it('handles empty/undefined input without throwing', () => {
    expect(insertLineBreaksForBlockTags('')).toBe('')
  })
})
