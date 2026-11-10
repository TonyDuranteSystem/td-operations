'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { useTalkI18n } from '@/components/talk/talk-i18n'
import type { ScanPage } from '@/components/scan/scan-types'

const HOLD_MS = 280
const MOVE_SLOP_PX = 10

/** All the pages of the scan: hold and drag to reorder, tap to adjust, the cross removes, then one button makes the PDF. */
export function ScanPages({ pages, name, onName, onOpen, onRemove, onMove, onAdd, onBack, onAttach, building, progress, atLimit }: {
  pages: ScanPage[]
  name: string
  onName: (value: string) => void
  onOpen: (id: string) => void
  onRemove: (id: string) => void
  onMove: (from: number, to: number) => void
  onAdd: () => void
  onBack: () => void
  onAttach: () => void
  building: boolean
  /** which page the PDF is being made from, 1-based (0 = not started) */
  progress: number
  atLimit: boolean
}) {
  const { t } = useTalkI18n()
  const tiles = useRef<Array<HTMLDivElement | null>>([])
  const press = useRef<{ index: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; dragging: boolean } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const blockScroll = useRef((e: TouchEvent) => { if (e.cancelable) e.preventDefault() }).current

  const finish = () => {
    const p = press.current
    if (p?.timer) clearTimeout(p.timer)
    press.current = null
    window.removeEventListener('touchmove', blockScroll)
    setDragIndex(null)
  }
  useEffect(() => () => { window.removeEventListener('touchmove', blockScroll) }, [blockScroll])

  const down = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (building || (e.pointerType === 'mouse' && e.button !== 0)) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not every browser lets a tile capture the pointer */ }
    press.current = {
      index, x: e.clientX, y: e.clientY, dragging: false,
      timer: setTimeout(() => {
        if (!press.current) return
        press.current.dragging = true
        window.addEventListener('touchmove', blockScroll, { passive: false }) // the page must not scroll while a page is being carried
        setDragIndex(press.current.index)
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(8)
      }, HOLD_MS),
    }
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p) return
    if (!p.dragging) {
      // moved before the hold finished: it is a scroll, not a drag
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP_PX) finish()
      return
    }
    const target = tiles.current.findIndex(el => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    })
    if (target >= 0 && target < pages.length && target !== p.index) {
      onMove(p.index, target)
      p.index = target
      setDragIndex(target)
    }
  }
  const up = () => {
    const p = press.current
    const wasTap = !!p && !p.dragging
    const index = p?.index ?? -1
    finish()
    if (wasTap && pages[index]) onOpen(pages[index].id)
  }

  const n = pages.length
  const label = n === 1 ? t('Attach PDF · 1 page') : t('Attach PDF · {n} pages', { n })

  return (
    <div className="flex h-full flex-col bg-white text-zinc-900" data-testid="scan-pages">
      <div className="flex h-11 shrink-0 items-center border-b border-zinc-200 px-3" style={{ marginTop: 'env(safe-area-inset-top, 0px)' }}>
        <button type="button" onClick={onBack} disabled={building} aria-label={t('Back to the camera')} data-testid="scan-pages-back" className="flex h-9 w-9 items-center justify-center rounded-full text-xl text-zinc-600 active:bg-zinc-100">‹</button>
        <div className="flex-1 text-center text-sm font-semibold" data-testid="scan-pages-title">{n === 1 ? t('1 page') : t('{n} pages', { n })}</div>
        <span className="w-9" />
      </div>

      <label className="mx-3 mt-3 block shrink-0 rounded-xl border border-zinc-200 px-3 py-2">
        <span className="block text-[10px] font-medium uppercase tracking-wide text-zinc-500">{t('File name')}</span>
        <input
          id="scan-name" value={name} onChange={e => onName(e.target.value)} disabled={building} maxLength={80} data-testid="scan-name"
          className="w-full bg-transparent text-[16px] text-zinc-900 outline-none"
        />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-100 p-3 pt-3" data-testid="scan-grid">
        <div className="grid grid-cols-2 gap-3">
          {pages.map((p, i) => (
            <div
              key={p.id}
              ref={el => { tiles.current[i] = el }}
              role="button" tabIndex={0} aria-label={t('Page {n}', { n: i + 1 })}
              onPointerDown={e => down(e, i)} onPointerMove={move} onPointerUp={up} onPointerCancel={finish}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id) } }}
              data-testid="scan-tile"
              className={`relative aspect-[3/4] select-none overflow-hidden rounded-lg border bg-white [-webkit-touch-callout:none] ${dragIndex === i ? 'z-10 scale-105 border-[#BE1E2D] opacity-90 shadow-lg ring-2 ring-[#BE1E2D]' : 'border-zinc-200'}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="" draggable={false} className="h-full w-full object-contain" />
              <span className="absolute bottom-1.5 left-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-black/65 px-1 text-[10px] font-semibold text-white">{i + 1}</span>
              <button
                type="button" aria-label={t('Remove page {n}', { n: i + 1 })} disabled={building} data-testid="scan-remove"
                onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onRemove(p.id) }}
                className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
              ><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <button
            type="button" onClick={onAdd} disabled={atLimit || building} data-testid="scan-add"
            className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-xs font-semibold text-zinc-500 disabled:opacity-40"
          >
            <Plus className="h-5 w-5" />
            {atLimit ? t('{n} pages is the most', { n }) : t('Add page')}
          </button>
        </div>
      </div>

      <div className="shrink-0 bg-white px-3 pt-2" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 0px))' }}>
        <button type="button" onClick={onAttach} disabled={building || n === 0} data-testid="scan-attach" className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#BE1E2D] py-3.5 text-sm font-semibold text-white active:opacity-80 disabled:opacity-60">
          {building && <Loader2 className="h-4 w-4 animate-spin" />}
          {building ? t('Making your PDF… {i} of {n}', { i: Math.max(1, progress), n }) : label}
        </button>
      </div>
    </div>
  )
}
