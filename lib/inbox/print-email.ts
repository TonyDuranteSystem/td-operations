import { sanitizeEmailHtml } from '@/lib/html-escape'

/**
 * Print / Save-as-PDF for an inbox email thread (Luca request 2026-07-08).
 *
 * SECURITY — this MUST preserve the inbox's core invariant: inbound email HTML
 * is attacker-controlled (anyone can email support@). It is NEVER rendered in a
 * privileged, same-origin, un-sandboxed context. The print view is built as a
 * document string and loaded into a SANDBOXED iframe WITHOUT `allow-scripts`
 * (same rule as `email-html-frame.tsx`), so a missed sanitizer gap still cannot
 * run code. Header fields (sender, subject) are attacker-influenced too and are
 * HTML-escaped. `allow-same-origin` is present ONLY so the parent can call
 * `contentWindow.print()` and so `/api/inbox/attachment` inline images carry the
 * auth cookie — safe precisely because `allow-scripts` is absent. `allow-modals`
 * lets the framed document surface the browser print dialog. Never add
 * `allow-scripts`.
 */

export interface PrintMessage {
  sender: string
  direction: 'inbound' | 'outbound' | string
  createdAt: string
  content: string
  isHtml?: boolean
}

export interface BuildPrintDocumentOptions {
  subject?: string
  messages: PrintMessage[]
  /** Formats a message timestamp for display (injected so the builder stays pure). */
  formatTime: (dateStr: string) => string
}

function escapeHtml(value: string): string {
  return (value || '').replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return ch
    }
  })
}

/** True when the body should be treated as HTML (mirrors message-thread.tsx). */
function isHtmlBody(msg: PrintMessage): boolean {
  return msg.isHtml ?? (!!msg.content && msg.content.includes('<') && msg.content.includes('>'))
}

/**
 * Pure: builds the full self-contained HTML document printed for a thread.
 * Messages are laid out oldest-first (chronological), Gmail-print style.
 */
export function buildPrintDocument(opts: BuildPrintDocumentOptions): string {
  const { subject, messages, formatTime } = opts

  const sections = messages
    .map((msg) => {
      const who =
        msg.direction === 'outbound'
          ? `To: ${escapeHtml(msg.sender)}`
          : escapeHtml(msg.sender)
      const when = escapeHtml(formatTime(msg.createdAt))
      const body = isHtmlBody(msg)
        ? sanitizeEmailHtml(msg.content || '')
        : `<pre class="plain">${escapeHtml(msg.content || '')}</pre>`
      return `<section class="msg"><div class="hdr"><span class="who">${who}</span><span class="when">${when}</span></div><div class="body">${body}</div></section>`
    })
    .join('')

  const heading = subject ? `<h1>${escapeHtml(subject)}</h1>` : ''

  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><title>${escapeHtml(
    subject || 'Email'
  )}</title><style>
    body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #18181b; }
    h1 { font-size: 18px; margin: 0 0 14px; }
    .msg { border: 1px solid #d4d4d8; border-radius: 8px; margin: 0 0 12px; overflow: hidden; page-break-inside: avoid; }
    .hdr { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; background: #f4f4f5; border-bottom: 1px solid #e4e4e7; font-size: 12px; }
    .who { font-weight: 600; color: #27272a; }
    .when { color: #71717a; white-space: nowrap; }
    .body { padding: 10px 12px; }
    .plain { white-space: pre-wrap; word-break: break-word; font: inherit; margin: 0; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #2563eb; }
  </style></head><body>${heading}${sections}</body></html>`
}

/**
 * Renders the print document into an off-screen sandboxed iframe and triggers
 * the browser print / Save-as-PDF dialog. Browser-only. The iframe is removed
 * after printing (afterprint) with a long fallback timeout.
 */
export function printEmailThread(opts: BuildPrintDocumentOptions): void {
  if (typeof document === 'undefined') return

  const iframe = document.createElement('iframe')
  // No allow-scripts — email HTML can never execute. allow-same-origin: parent
  // can call print() + inline-image auth cookie. allow-modals: the print dialog.
  iframe.setAttribute('sandbox', 'allow-same-origin allow-modals')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.opacity = '0'
  iframe.srcdoc = buildPrintDocument(opts)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    iframe.remove()
  }

  iframe.onload = () => {
    const win = iframe.contentWindow
    if (!win) {
      cleanup()
      return
    }
    // Remove the frame once the user closes the print dialog. Fallback timeout
    // covers browsers that don't fire afterprint on the framed window.
    try {
      win.addEventListener('afterprint', cleanup, { once: true })
    } catch {
      /* same-origin guaranteed by allow-same-origin, but stay defensive */
    }
    // Give inline images a moment to load before opening the dialog.
    setTimeout(() => {
      try {
        win.focus()
        win.print()
      } catch {
        cleanup()
      }
    }, 350)
    setTimeout(cleanup, 120_000)
  }

  document.body.appendChild(iframe)
}
