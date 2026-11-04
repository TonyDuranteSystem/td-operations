'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppMode } from '@/lib/app-mode/app-mode-context'
import { fitScale } from '@/lib/inbox/fit-scale'

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
  const appMode = useAppMode()

  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument
    if (!doc?.documentElement) return
    // Inside the TD Social phone app an email wider than the phone is SHRUNK to fit (Step 1b, fix-list item 4) instead of
    // being cut off at the right edge. Everywhere else the email is shown exactly as before.
    const fit = appMode ? doc.getElementById('td-fit') : null
    if (fit) {
      fit.style.transform = ''
      fit.style.width = ''
      doc.documentElement.style.overflowY = ''
      const available = doc.documentElement.clientWidth
      const natural = fit.scrollWidth
      const k = fitScale(natural, available)
      if (k < 1) {
        fit.style.width = `${natural}px`
        fit.style.transformOrigin = '0 0'
        fit.style.transform = `scale(${k})`
        // A transform shrinks what you SEE, not the room the email takes up: the document stays as tall as the full-size email while
        // the frame is only as tall as the shrunk one. Without this the frame scrolls through a blank white band below the email.
        doc.documentElement.style.overflowY = 'hidden'
        setHeight(Math.max(24, Math.ceil(fit.getBoundingClientRect().height) + 12))
        return
      }
    }
    setHeight(Math.max(24, doc.documentElement.scrollHeight + 8))
  }, [appMode])

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
      ${appMode ? 'html, body { overflow-x: hidden; }' : ''}
    </style></head><body>${appMode ? `<div id="td-fit">${html}</div>` : html}</body></html>`

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={measure}
      style={{ height }}
      className="w-full border-0 bg-white"
      title="Email content"
      // Lets the Capture tool find this iframe and render it separately
      // (lib/captures/email-frame-composite.ts) — html2canvas's own
      // cross-frame clone-and-paint silently produces a near-blank render
      // for some emails' HTML otherwise. Must be a dedicated attribute, not
      // the `title` above: that's decorative copy with no contract, and a
      // future wording change to it must never silently break detection.
      data-capture-email-frame="true"
    />
  )
}
