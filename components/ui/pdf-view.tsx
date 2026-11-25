'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import { PDF_PHONE_QUERY, pdfModeFor } from '@/lib/ui/pdf-view-rules'

/**
 * A PDF inside a CRM window. On a computer: the same frame as always (`<iframe src className>` — nothing changes). On a touch phone or tablet: a card with
 * an "Open PDF" button that opens the file as a page of its own, because the phone's engine shows a framed PDF as page 1 only (lib/ui/pdf-view-rules.ts).
 * Inside the TD Social phone app the same link opens the PDF in the iPhone's own viewer (Quick Look) — the app already does that for any PDF page.
 */
export function PdfView({ src, title, className }: { src: string; title: string; className?: string }) {
  const [touchOnly, setTouchOnly] = useState<boolean | null>(null)
  useEffect(() => {
    const mq = window.matchMedia(PDF_PHONE_QUERY)
    setTouchOnly(mq.matches)
    const on = (e: MediaQueryListEvent) => setTouchOnly(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const mode = pdfModeFor(touchOnly)
  if (mode === 'checking') return <div className={className} data-testid="pdf-checking" />
  if (mode === 'frame') return <iframe src={src} title={title} className={className} />
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="pdf-open-card">
      <FileText className="h-10 w-10 text-zinc-400" />
      <p className="max-w-full break-words text-sm font-medium text-zinc-800">{title}</p>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-5 py-3 text-base font-semibold text-white active:bg-zinc-700"
        data-testid="pdf-open-link"
      >
        <ExternalLink className="h-4 w-4" /> Open PDF
      </a>
      <p className="max-w-xs text-xs text-zinc-500">Opens the PDF with every page. When you are done, close it or go back to return here.</p>
    </div>
  )
}
