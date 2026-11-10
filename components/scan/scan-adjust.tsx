'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTalkI18n } from '@/components/talk/talk-i18n'
import type { ScanLook } from '@/lib/scan/enhance'
import { isConvexQuad, type Quad, type Raster } from '@/lib/scan/geometry'
import { decodePicture, renderPage } from '@/lib/scan/browser'
import type { ScanPage } from '@/components/scan/scan-types'

/** Order on screen; Colour is the one that starts selected (see DEFAULT_SCAN_LOOK). */
const LOOKS: ReadonlyArray<{ key: ScanLook; label: string }> = [
  { key: 'document', label: 'Document' },
  { key: 'colour', label: 'Colour' },
  { key: 'grey', label: 'Grey' },
]

/**
 * One page after the picture: the straightened, cleaned-up result with the three looks, and — behind "Adjust corners" — the
 * original photo with four handles to drag when the outline was off.
 */
export function ScanAdjust({ page, pageNumber, onChange, onRetake, onUse }: {
  page: ScanPage
  pageNumber: number
  onChange: (next: { corners: Quad; look: ScanLook; preview: Blob }) => void
  onRetake: () => void
  onUse: () => void
}) {
  const { t } = useTalkI18n()
  const [mode, setMode] = useState<'result' | 'corners'>('result')
  const [corners, setCorners] = useState<Quad>(page.corners)
  const [look, setLook] = useState<ScanLook>(page.look)
  const [busy, setBusy] = useState(false)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const raster = useRef<Raster | null>(null)
  const cornersRef = useRef(corners); cornersRef.current = corners
  const request = useRef(0)
  const dragging = useRef<number | null>(null)

  // a different page: start from its own corners and look
  useEffect(() => { setCorners(page.corners); setLook(page.look); setMode('result'); raster.current = null }, [page.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // the original photo is only put on screen while the corners are being adjusted
  useEffect(() => {
    if (mode !== 'corners') return
    const url = URL.createObjectURL(page.original)
    setOriginalUrl(url)
    return () => { URL.revokeObjectURL(url); setOriginalUrl(null) }
  }, [mode, page.original])

  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [mode])

  const apply = useCallback(async (nextCorners: Quad, nextLook: ScanLook) => {
    const mine = ++request.current
    setBusy(true)
    try {
      if (!raster.current) raster.current = (await decodePicture(page.original, 2400)).raster
      const out = await renderPage(raster.current, nextCorners, nextLook, 900, 0.8)
      if (mine === request.current) onChange({ corners: nextCorners, look: nextLook, preview: out.blob })
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('Could not redraw the page. Please try again.'))
    } finally {
      if (mine === request.current) setBusy(false)
    }
  }, [page.original, onChange, t])

  const chooseLook = (next: ScanLook) => {
    if (next === look) return
    setLook(next)
    void apply(cornersRef.current, next)
  }

  // where the picture sits inside the box (it is shown whole, never cropped)
  const fit = box.w > 0 && box.h > 0
    ? (() => { const s = Math.min(box.w / page.width, box.h / page.height); return { s, ox: (box.w - page.width * s) / 2, oy: (box.h - page.height * s) / 2 } })()
    : null

  const moveHandle = (i: number, e: React.PointerEvent) => {
    if (dragging.current !== i || !fit || !boxRef.current) return
    const r = boxRef.current.getBoundingClientRect()
    const x = Math.min(page.width, Math.max(0, (e.clientX - r.left - fit.ox) / fit.s))
    const y = Math.min(page.height, Math.max(0, (e.clientY - r.top - fit.oy) / fit.s))
    const next = cornersRef.current.map((p, k) => (k === i ? { x, y } : p)) as Quad
    if (isConvexQuad(next)) setCorners(next)
  }
  const endDrag = (i: number) => {
    if (dragging.current !== i) return
    dragging.current = null
    void apply(cornersRef.current, look)
  }

  return (
    <div className="flex h-full flex-col bg-white text-zinc-900" data-testid="scan-adjust">
      <div className="flex h-11 shrink-0 items-center border-b border-zinc-200 px-3" style={{ marginTop: 'env(safe-area-inset-top, 0px)' }}>
        <button type="button" onClick={onRetake} aria-label={t('Throw this picture away')} data-testid="scan-adjust-close" className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 active:bg-zinc-100"><X className="h-5 w-5" /></button>
        <div className="flex-1 text-center text-sm font-semibold">{t('Page {n}', { n: pageNumber })}</div>
        <button type="button" onClick={() => setMode(m => (m === 'result' ? 'corners' : 'result'))} data-testid="scan-adjust-toggle" className="rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-700 active:bg-zinc-200">
          {mode === 'result' ? t('Adjust corners') : t('Show result')}
        </button>
      </div>

      <div ref={boxRef} className="relative min-h-0 flex-1 touch-none select-none bg-zinc-800" data-testid="scan-adjust-area">
        {mode === 'result' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={page.previewUrl} alt={t('Page {n}', { n: pageNumber })} draggable={false} className="absolute inset-0 h-full w-full object-contain p-3" data-testid="scan-preview" />
        )}
        {mode === 'corners' && originalUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={originalUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
        )}
        {mode === 'corners' && fit && (
          <svg className="absolute inset-0 h-full w-full" width={box.w} height={box.h} data-testid="scan-corners">
            <polygon points={corners.map(p => `${p.x * fit.s + fit.ox},${p.y * fit.s + fit.oy}`).join(' ')} fill="rgba(37,99,235,0.10)" stroke="#2563eb" strokeWidth={2.5} strokeLinejoin="round" />
            {corners.map((p, i) => {
              const cx = p.x * fit.s + fit.ox, cy = p.y * fit.s + fit.oy
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={22} fill="transparent" style={{ touchAction: 'none', cursor: 'grab' }}
                    onPointerDown={e => { dragging.current = i; try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* the drag still works while the finger stays on the handle */ } }}
                    onPointerMove={e => moveHandle(i, e)}
                    onPointerUp={() => endDrag(i)} onPointerCancel={() => endDrag(i)} data-testid={`scan-handle-${i}`} />
                  <circle cx={cx} cy={cy} r={9} fill="#fff" stroke="#2563eb" strokeWidth={3} pointerEvents="none" />
                </g>
              )
            })}
          </svg>
        )}
        {busy && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25"><Loader2 className="h-7 w-7 animate-spin text-white" data-testid="scan-busy" /></div>}
      </div>

      <div className="flex shrink-0 justify-center gap-2 px-3 pb-1 pt-2.5">
        {LOOKS.map(l => (
          <button key={l.key} type="button" onClick={() => chooseLook(l.key)} aria-pressed={look === l.key} data-testid={`scan-look-${l.key}`}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${look === l.key ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-800'}`}>
            {t(l.label)}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 gap-2.5 px-3 pb-4 pt-2" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}>
        <button type="button" onClick={onRetake} data-testid="scan-retake" className="flex-1 rounded-xl bg-zinc-100 py-3 text-sm font-semibold text-zinc-900 active:bg-zinc-200">{t('Retake')}</button>
        <button type="button" onClick={onUse} disabled={busy} data-testid="scan-use-page" className="flex-1 rounded-xl bg-[#BE1E2D] py-3 text-sm font-semibold text-white active:opacity-80 disabled:opacity-50">{t('Use this page')}</button>
      </div>
    </div>
  )
}
