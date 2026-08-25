import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildPrintDocument, printEmailThread, type PrintMessage } from '@/lib/inbox/print-email'

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

// The frame's `load` event doesn't fire until every subresource it references
// (including invisible tracking-pixel <img> requests real email HTML embeds)
// has settled — a single slow/dead one can hold that up well past a minute
// (Antonio, 2026-08-25: the print button was taking ~2 minutes to open).
// This suite pins the fix: printEmailThread must open the dialog on whichever
// comes first, the frame's own load or a bounded ceiling, and never twice.
describe('printEmailThread', () => {
  const messages: PrintMessage[] = [
    { sender: 's', direction: 'inbound', createdAt: 'd', content: 'hi', isHtml: false },
  ]

  function stubDocument() {
    const win = {
      focus: vi.fn(),
      print: vi.fn(),
      addEventListener: vi.fn(),
    }
    const iframe = {
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove: vi.fn(),
      contentWindow: win,
      onload: null as (() => void) | null,
      srcdoc: '',
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => iframe),
      body: { appendChild: vi.fn() },
    })
    return { iframe, win }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens the dialog shortly after the frame loads, when loading is fast', () => {
    const { iframe, win } = stubDocument()
    printEmailThread({ subject: 'S', messages, formatTime: (s) => s })
    iframe.onload?.()
    expect(win.print).not.toHaveBeenCalled()
    vi.advanceTimersByTime(350)
    expect(win.print).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('opens the dialog after a bounded ceiling even if the frame never finishes loading', () => {
    const { win } = stubDocument()
    printEmailThread({ subject: 'S', messages, formatTime: (s) => s })
    // onload never fires — simulates a hanging tracking-pixel request (in
    // production, HubSpot "engagement duration" beacons that stay pending by
    // design and would never fire onload at all, no matter how long we wait).
    vi.advanceTimersByTime(399)
    expect(win.print).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(win.print).toHaveBeenCalledTimes(1)
  })

  it('never opens the dialog twice when the ceiling fires first and the frame loads late', () => {
    const { iframe, win } = stubDocument()
    printEmailThread({ subject: 'S', messages, formatTime: (s) => s })
    vi.advanceTimersByTime(400)
    expect(win.print).toHaveBeenCalledTimes(1)
    iframe.onload?.() // fires late, after the ceiling already opened it
    vi.advanceTimersByTime(350)
    expect(win.print).toHaveBeenCalledTimes(1)
  })

  it('registers an afterprint handler that removes the frame', () => {
    const { iframe, win } = stubDocument()
    printEmailThread({ subject: 'S', messages, formatTime: (s) => s })
    vi.advanceTimersByTime(400)
    expect(win.addEventListener).toHaveBeenCalledWith(
      'afterprint',
      expect.any(Function),
      { once: true }
    )
    const afterprintHandler = win.addEventListener.mock.calls[0][1] as () => void
    afterprintHandler()
    expect(iframe.remove).toHaveBeenCalledTimes(1)
  })
})
