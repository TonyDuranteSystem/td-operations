'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Renders untrusted email HTML inside a sandboxed iframe.
 *
 * Why an iframe (security audit H8/H9 follow-up):
 *  - script execution is structurally impossible (`sandbox` without
 *    `allow-scripts`), regardless of sanitizer gaps;
 *  - the email's own CSS cannot leak into the dashboard and vice versa, so
 *    emails designed as fixed-width tables render as the sender intended.
 *
 * `allow-same-origin` is required so (a) the parent can measure the document
 * height and (b) same-origin /api/inbox/attachment image requests carry the
 * auth cookie. It is safe here ONLY because `allow-scripts` is absent — never
 * add both. `allow-popups` + escape lets links (forced to target=_blank via
 * <base>) open in a normal, un-sandboxed tab.
 */
export function EmailHtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(60)

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument
    if (doc?.documentElement) {
      setHeight(Math.max(24, doc.documentElement.scrollHeight + 8))
    }
  }, [])

  // Images load after the document's load event — re-measure a few times.
  useEffect(() => {
    const timers = [300, 1000, 2500].map((ms) => setTimeout(measure, ms))
    return () => timers.forEach(clearTimeout)
  }, [html, measure])

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      body { margin: 0; padding: 2px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #18181b; word-break: break-word; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      table { max-width: 100%; }
    </style></head><body>${html}</body></html>`

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={measure}
      style={{ height }}
      className="w-full border-0 bg-white"
      title="Email content"
    />
  )
}
