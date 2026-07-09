import { describe, it, expect } from 'vitest'
import { buildPrintDocument, type PrintMessage } from '@/lib/inbox/print-email'

const fmt = (s: string) => (s ? `TIME(${s})` : '')

describe('buildPrintDocument', () => {
  it('renders the subject as an escaped heading and <title>', () => {
    const doc = buildPrintDocument({
      subject: 'Q3 <report> & "notes"',
      messages: [],
      formatTime: fmt,
    })
    expect(doc).toContain('<title>Q3 &lt;report&gt; &amp; &quot;notes&quot;</title>')
    expect(doc).toContain('<h1>Q3 &lt;report&gt; &amp; &quot;notes&quot;</h1>')
  })

  it('falls back to "Email" title and omits the heading when no subject', () => {
    const doc = buildPrintDocument({ subject: '', messages: [], formatTime: fmt })
    expect(doc).toContain('<title>Email</title>')
    expect(doc).not.toContain('<h1>')
  })

  it('escapes the sender and labels outbound messages with "To:"', () => {
    const messages: PrintMessage[] = [
      { sender: 'Ann <a@b.com>', direction: 'inbound', createdAt: '2026-07-08', content: 'hi', isHtml: false },
      { sender: 'client@x.com', direction: 'outbound', createdAt: '2026-07-09', content: 'reply', isHtml: false },
    ]
    const doc = buildPrintDocument({ subject: 'S', messages, formatTime: fmt })
    expect(doc).toContain('Ann &lt;a@b.com&gt;')
    expect(doc).toContain('To: client@x.com')
    expect(doc).toContain('TIME(2026-07-08)')
    expect(doc).toContain('TIME(2026-07-09)')
  })

  it('wraps plain-text bodies in a pre block with escaping', () => {
    const messages: PrintMessage[] = [
      { sender: 's', direction: 'inbound', createdAt: 'd', content: 'line1\n<b>not bold</b>', isHtml: false },
    ]
    const doc = buildPrintDocument({ subject: 'S', messages, formatTime: fmt })
    expect(doc).toContain('<pre class="plain">line1\n&lt;b&gt;not bold&lt;/b&gt;</pre>')
  })

  it('sanitizes HTML bodies (strips scripts) but keeps safe markup', () => {
    const messages: PrintMessage[] = [
      {
        sender: 's',
        direction: 'inbound',
        createdAt: 'd',
        content: '<p>Hello</p><script>alert(1)</script>',
        isHtml: true,
      },
    ]
    const doc = buildPrintDocument({ subject: 'S', messages, formatTime: fmt })
    expect(doc).toContain('<p>Hello</p>')
    expect(doc).not.toContain('<script>alert(1)</script>')
  })

  it('treats bodies containing angle brackets as HTML when isHtml is undefined', () => {
    const messages: PrintMessage[] = [
      { sender: 's', direction: 'inbound', createdAt: 'd', content: '<p>auto</p>' },
    ]
    const doc = buildPrintDocument({ subject: 'S', messages, formatTime: fmt })
    expect(doc).toContain('<p>auto</p>')
    expect(doc).not.toContain('<pre class="plain">')
  })

  it('renders one <section class="msg"> per message', () => {
    const messages: PrintMessage[] = [
      { sender: 'a', direction: 'inbound', createdAt: 'd', content: 'x', isHtml: false },
      { sender: 'b', direction: 'inbound', createdAt: 'd', content: 'y', isHtml: false },
    ]
    const doc = buildPrintDocument({ subject: 'S', messages, formatTime: fmt })
    expect(doc.match(/<section class="msg">/g)).toHaveLength(2)
  })
})
