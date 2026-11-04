'use client'

/**
 * A floating window that shows ONE document (PDF or image) over whatever screen is open — Antonio 2026-11-04: "the document will open,
 * everything in a floating window". It is not a modal: the screen behind stays usable, the window moves by its title bar, resizes from
 * its bottom-right corner and closes with the X (or Escape). Used by the State Filing ID check on the formation upload window and on
 * the onboarding review screen, so the person can read the number on the real document beside the card they are confirming.
 *
 * Stacking: z-[60] — above the upload window's own overlay (z-50), below the design-system dialogs (70/80).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileQuestion, GripVertical, Loader2, X } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { previewKind } from '@/lib/crm-storage/preview-kind'
import { mimeTypeFromFileName } from '@/lib/flows/onboarding-articles'

export interface FloatingDocumentWindowProps {
  /** Where the document can be read: a blob: URL of a file the person just picked, or a signed storage link. */
  url: string
  /** Shown in the title bar and used to tell the file type when the mime type is missing. */
  fileName: string
  mimeType: string | null
  /** Called once, when the document has really SHOWN — the PDF / image finished loading, or the person opened it in a new tab. Opening the
   *  window alone does not count: a file this browser cannot draw, or a link that no longer works, leaves the window showing a message. */
  onShown?: () => void
  onClose: () => void
}

const DEFAULT_W = 720
const DEFAULT_H = 820
const MIN_W = 380
const MIN_H = 300

// The last place the window was left, kept for the next time one opens in this page session.
let lastPosition: { x: number; y: number } | null = null

/**
 * Where the window first opens. Beside the panel it belongs to when that panel is marked `data-floating-anchor` (the upload window's
 * dialog) — so the number to check and the document are side by side, not one on top of the other — on whichever side has more room;
 * otherwise where it was last left, else at the right of the screen.
 */
function initialGeometry(): { x: number; y: number; w: number; h: number } {
  if (typeof window === 'undefined') return { x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const h = Math.min(DEFAULT_H, vh - 96)
  let w = Math.min(DEFAULT_W, vw - 32)
  const anchor = document.querySelector('[data-floating-anchor]')
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    const roomRight = vw - r.right - 32
    const roomLeft = r.left - 32
    if (roomRight >= MIN_W && roomRight >= roomLeft) return { x: r.right + 16, y: 72, w: Math.min(DEFAULT_W, roomRight), h }
    if (roomLeft >= MIN_W) {
      w = Math.min(DEFAULT_W, roomLeft)
      return { x: r.left - 16 - w, y: 72, w, h }
    }
  }
  return { x: lastPosition?.x ?? vw - w - 24, y: lastPosition?.y ?? 72, w, h }
}

function clamp(p: { x: number; y: number }, w: number): { x: number; y: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // sideways the whole window stays on the screen; downwards it may be dragged until only the title bar shows
  return { x: Math.min(Math.max(0, p.x), Math.max(0, vw - Math.min(w, vw))), y: Math.min(Math.max(0, p.y), Math.max(0, vh - 48)) }
}

export function FloatingDocumentWindow({ url, fileName, mimeType, onShown, onClose }: FloatingDocumentWindowProps) {
  const [mounted, setMounted] = useState(false)
  const [geo] = useState(initialGeometry)
  const size = { w: geo.w, h: geo.h }
  const [pos, setPos] = useState<{ x: number; y: number }>(() => (typeof window === 'undefined' ? { x: 0, y: 0 } : clamp({ x: geo.x, y: geo.y }, geo.w)))
  const drag = useRef<{ sx: number; sy: number; x0: number; y0: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // "the document was seen" is reported once, whichever of load / new-tab comes first
  const shown = useRef(false)
  const markShown = useCallback(() => {
    if (shown.current) return
    shown.current = true
    onShown?.()
  }, [onShown])

  useEffect(() => {
    rootRef.current?.focus()
  }, [mounted])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { sx: e.clientX, sy: e.clientY, x0: pos.x, y0: pos.y }
  }, [pos.x, pos.y])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const width = rootRef.current?.offsetWidth ?? size.w
    setPos(clamp({ x: d.x0 + e.clientX - d.sx, y: d.y0 + e.clientY - d.sy }, width))
  }, [size.w])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    lastPosition = pos
  }, [pos])

  const effectiveMime = mimeType && mimeType !== 'application/octet-stream' ? mimeType : mimeTypeFromFileName(fileName)
  const kind = previewKind(effectiveMime)
  // a file the person just picked on this computer is already a local blob; a client's upload arrives as a link to the storage origin
  const isLocalBlob = url.startsWith('blob:')
  // A client's PDF is fetched and shown from a local blob typed application/pdf: the browser's PDF viewer does not run inside a sandboxed
  // frame (the window stays blank), and a frame without a sandbox must never load a stranger's file straight from its link. The blob's
  // type is OURS, so a file that is really HTML is never run as a page.
  const needsFetch = kind === 'pdf' && !isLocalBlob
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  useEffect(() => {
    if (!needsFetch) return
    let cancelled = false
    let made: string | null = null
    setPdfBlobUrl(null)
    setPdfFailed(false)
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.blob()
      })
      .then((b) => {
        if (cancelled) return
        made = URL.createObjectURL(new Blob([b], { type: 'application/pdf' }))
        setPdfBlobUrl(made)
      })
      .catch(() => { if (!cancelled) setPdfFailed(true) })
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [needsFetch, url])

  if (!mounted) return null

  // an image type the browser cannot draw (HEIC, TIFF) falls back to "open it in a new tab"
  const showAsImage = kind === 'image' && !imageFailed && !/heic|heif|tiff/i.test(effectiveMime ?? '')
  // the browser's own PDF viewer, without its thumbnail strip, fitted to the window's width (the number is on page 1)
  const withViewerOptions = (u: string) => `${u}${u.includes('#') ? '&' : '#'}navpanes=0&view=FitH`
  const noPreview = (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-zinc-600">
      <FileQuestion className="h-8 w-8" />
      <p className="text-sm">This browser cannot show this file inside the window.</p>
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={markShown} className="rounded-md border border-zinc-400 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
        Open it in a new tab
      </a>
    </div>
  )

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Document: ${fileName}`}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      data-testid="floating-document-window"
      className="fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-2xl outline-none"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, minWidth: MIN_W, minHeight: MIN_H, maxWidth: '100vw', maxHeight: '100vh', resize: 'both' }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-zinc-200 bg-zinc-100 px-2.5 py-2"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800" title={fileName}>{fileName}</span>
        <FastTooltip label="Open in a new tab">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={markShown}
            aria-label="Open in a new tab"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </FastTooltip>
        <FastTooltip label="Close">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the document"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </FastTooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-200">
        {kind === 'pdf' ? (
          isLocalBlob ? (
            <iframe src={withViewerOptions(url)} title={fileName} onLoad={markShown} className="h-full w-full bg-white" />
          ) : pdfFailed ? (
            noPreview
          ) : pdfBlobUrl ? (
            <iframe src={withViewerOptions(pdfBlobUrl)} title={fileName} onLoad={markShown} className="h-full w-full bg-white" />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-500"><Loader2 className="h-6 w-6 animate-spin" /></div>
          )
        ) : showAsImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob or signed storage link, not a Next-optimizable remote URL
          <img src={url} alt={fileName} onLoad={markShown} onError={() => setImageFailed(true)} className="mx-auto block max-w-full" />
        ) : (
          noPreview
        )}
      </div>
    </div>,
    document.body,
  )
}
