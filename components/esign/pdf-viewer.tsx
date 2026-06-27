"use client"

/**
 * Shared PDF renderer for the e-sign editor + signer screens.
 *
 * Renders each page to a <canvas> at a fit-to-width scale and overlays an
 * absolutely-positioned layer sized to the page's CSS box, so normalized field
 * coordinates (0..1) map directly to pixels via lib/esign/coordinates. pdfjs is
 * imported lazily inside effects (never on the server); the worker is served
 * from /esign/pdf.worker.min.mjs (version-matched, copied at build).
 */

import { useEffect, useRef, useState, type ReactNode } from "react"

export interface PdfPageInfo {
  index: number // 0-based, matches esign_fields.page_index + pdf-lib getPage
  widthCss: number
  heightCss: number
}

interface Props {
  /** A URL (signer view) or PDF bytes (editor, after upload). */
  src: string | Uint8Array
  /** Render an overlay over each page (placed/interactive fields). */
  renderOverlay?: (page: PdfPageInfo) => ReactNode
  onLoaded?: (pageCount: number) => void
  maxWidth?: number
}

export function PdfViewer({ src, renderOverlay, onLoaded, maxWidth = 800 }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docRef = useRef<any>(null)
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({})
  const [pages, setPages] = useState<PdfPageInfo[]>([])
  const [dpr, setDpr] = useState(1)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  // Load the document and compute each page's CSS dimensions.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setStatus("loading")
      setPages([])
      canvasRefs.current = {}
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfjs: any = await import("pdfjs-dist")
        pdfjs.GlobalWorkerOptions.workerSrc = "/esign/pdf.worker.min.mjs"
        const params = typeof src === "string" ? { url: src } : { data: src }
        const doc = await pdfjs.getDocument(params).promise
        if (cancelled) return
        docRef.current = doc
        const ratio = Math.max(window.devicePixelRatio || 1, 1)
        const fit = Math.max(320, maxWidth)
        const infos: PdfPageInfo[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          const base = page.getViewport({ scale: 1 })
          const scale = fit / base.width
          infos.push({ index: i - 1, widthCss: base.width * scale, heightCss: base.height * scale })
        }
        if (cancelled) return
        setDpr(ratio)
        setPages(infos)
        setStatus("ready")
        onLoaded?.(doc.numPages)
      } catch {
        if (!cancelled) setStatus("error")
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // onLoaded intentionally omitted — caller passes a stable or inline fn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, maxWidth])

  // Paint each page into its canvas once dimensions + refs exist.
  useEffect(() => {
    if (status !== "ready" || !docRef.current) return
    let cancelled = false
    async function render() {
      for (const info of pages) {
        const canvas = canvasRefs.current[info.index]
        if (!canvas) continue
        const page = await docRef.current.getPage(info.index + 1)
        const base = page.getViewport({ scale: 1 })
        const vp = page.getViewport({ scale: (info.widthCss / base.width) * dpr })
        canvas.width = vp.width
        canvas.height = vp.height
        const ctx = canvas.getContext("2d")
        if (!ctx) continue
        await page.render({ canvasContext: ctx, viewport: vp }).promise
        if (cancelled) return
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [status, pages, dpr])

  if (status === "loading") return <div className="py-10 text-center text-sm text-zinc-400">Loading PDF…</div>
  if (status === "error") return <div className="py-10 text-center text-sm text-red-500">Could not render the PDF.</div>

  return (
    <div className="flex flex-col items-center gap-4">
      {pages.map(info => (
        <div
          key={info.index}
          className="relative rounded-sm bg-white shadow-sm"
          style={{ width: info.widthCss, height: info.heightCss }}
          data-page={info.index}
        >
          <canvas
            ref={el => {
              canvasRefs.current[info.index] = el
            }}
            style={{ width: info.widthCss, height: info.heightCss, display: "block" }}
          />
          {renderOverlay && (
            <div className="absolute inset-0" style={{ width: info.widthCss, height: info.heightCss }}>
              {renderOverlay(info)}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
