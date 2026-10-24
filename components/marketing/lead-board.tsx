'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import {
  BOARD_VIEWS, boardCards, cardsInColumn, columnsFor, columnTitle, hiddenCount, parseBoardView,
  type BoardCard, type BoardRole, type BoardView,
} from '@/lib/marketing/board'
import {
  DOCK_H, EMPTY_WINDOWS, FRAME_CHANGED, TITLEBAR_H, WINDOW_H, WINDOW_W, closeWindow, focusWindow, frontWindowId, minimizeWindow, moveWindow, openWindow, windowSrc,
  type Viewport, type WindowsState,
} from '@/lib/marketing/lead-windows'

const VIEW_KEY = 'tdm_board_view'
const VIEW_LABEL: Record<BoardView, string> = { pipeline: 'Pipeline', cards: 'Cards', list: 'List' }
const TONE = { ok: 'border-emerald-200 bg-emerald-50 text-emerald-800', warn: 'border-amber-200 bg-amber-50 text-amber-800', info: 'border-sky-200 bg-sky-50 text-sky-800' } as const

function readView(): BoardView {
  try { return parseBoardView(window.localStorage.getItem(VIEW_KEY)) } catch { return 'pipeline' }
}

/**
 * TD Marketing — the lead board (dev job 9aec66fa, Addendum G): Pipeline | Cards | List, and a click on a lead opens it in a floating window (max 3, drag, minimize,
 * close) instead of a new page. A window shows the lead's own page in a frame, so it has exactly the buttons and the privacy of the lead page itself.
 */
export function LeadBoard({ role, cards, truncated }: { role: BoardRole; cards: BoardCard[]; truncated: boolean }) {
  const t = useT()
  const router = useRouter()
  const [view, setView] = useState<BoardView>('pipeline')
  const [wins, setWins] = useState<WindowsState>(EMPTY_WINDOWS)
  const [dragging, setDragging] = useState(false)
  const vpRef = useRef<Viewport>({ w: 1280, h: 800 })
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  useEffect(() => {
    setView(readView())
    const measure = () => { vpRef.current = { w: window.innerWidth, h: window.innerHeight } }
    measure()
    window.addEventListener('resize', measure)
    // a save inside a lead window: read the leads again so the board shows it (waits a moment so several saves in a row make one read)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || (e.data as { type?: string } | null)?.type !== FRAME_CHANGED) return
      clearTimeout(timer)
      timer = setTimeout(() => router.refresh(), 400)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('message', onMessage); clearTimeout(timer) }
  }, [router])

  const pick = (v: BoardView) => {
    setView(v)
    try { window.localStorage.setItem(VIEW_KEY, v) } catch { /* the choice is only a convenience */ }
  }
  const open = useCallback((c: BoardCard) => setWins(s => openWindow(s, { id: c.id, name: c.name }, vpRef.current)), [])

  const onDown = (e: React.PointerEvent, id: string, x: number, y: number) => {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { id, dx: e.clientX - x, dy: e.clientY - y }
    setDragging(true)
    setWins(s => focusWindow(s, id))
  }
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => { const d = drag.current; if (d) setWins(s => moveWindow(s, d.id, e.clientX - d.dx, e.clientY - d.dy, vpRef.current)) }
    const up = () => { drag.current = null; setDragging(false) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [dragging])

  const front = frontWindowId(wins)
  const columns = columnsFor(role)
  const hidden = hiddenCount(role, cards)
  const cardButton = (c: BoardCard) => (
    <button key={c.id} type="button" onClick={() => open(c)} data-testid="board-card" data-lead={c.id}
      className="block w-full rounded-lg border bg-white p-3 text-left text-sm shadow-sm hover:border-slate-400">
      <span className="flex items-start justify-between gap-2"><b className="min-w-0 truncate font-medium">{c.name}</b>{c.existingClient && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-900" title={t('Existing TD client? Check before selling.')}>TD</span>}</span>
      {c.phone && <span className="mt-0.5 block truncate text-xs text-slate-500">{c.phone}</span>}
      {c.note && <span className="mt-1 block text-xs text-slate-700 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{c.note}</span>}
      {c.chips.length > 0 && <span className="mt-1.5 flex flex-wrap gap-1">{c.chips.map(ch => <span key={ch.key} className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE[ch.tone]}`}>{ch.text}</span>)}</span>}
      <span className="mt-1.5 block truncate text-[11px] text-slate-400">{c.filledIn}{c.ad ? ` · ${c.ad}` : ''}</span>
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex overflow-hidden rounded-lg border bg-white text-sm" role="group" aria-label={t('View')}>
          {BOARD_VIEWS.map(v => (
            <button key={v} type="button" onClick={() => pick(v)} aria-pressed={view === v} data-testid={`view-${v}`}
              className={`px-4 py-1.5 ${view === v ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{t(VIEW_LABEL[v])}</button>
          ))}
        </div>
        <p className="text-xs text-slate-500">{hidden > 0 && view !== 'list' ? t('{n} leads that are not on the board (for example "Not in target") are in the List view.', { n: hidden }) : ''}</p>
      </div>
      {truncated && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('Showing the newest 500 leads. Use the Leads page filters to find older ones.')}</p>}

      {view === 'pipeline' && (
        <div className="grid gap-3 overflow-x-auto pb-2" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(15rem, 1fr))` }} data-testid="pipeline">
          {columns.map(col => {
            const list = cardsInColumn(role, col.key, cards)
            return (
              <section key={col.key} aria-label={t(col.label)} className="min-w-0 rounded-xl bg-slate-100 p-2" data-column={col.key}>
                <h2 className="px-1 pb-2 text-xs font-semibold text-slate-600">{columnTitle(col, list.length, t)}</h2>
                <div className="space-y-2">{list.length === 0 ? <p className="px-1 py-3 text-xs text-slate-400">{t('Nothing here.')}</p> : list.map(cardButton)}</div>
              </section>
            )
          })}
        </div>
      )}

      {view === 'cards' && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="cards">
          {boardCards(role, cards).length === 0 ? <p className="text-sm text-slate-500">{t('Nothing here.')}</p> : boardCards(role, cards).map(cardButton)}
        </div>
      )}

      {view === 'list' && (
        <div className="overflow-x-auto rounded-xl border bg-white" data-testid="list">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-slate-500"><tr><th className="px-3 py-2">{t('Lead')}</th><th className="px-3">{t('Stage')}</th><th className="px-3">{t('What happened')}</th><th className="px-3">{t('Filled in')}</th><th className="px-3">{t('Picked by')}</th></tr></thead>
            <tbody className="divide-y">
              {[...cards].sort((a, b) => b.arrivedMs - a.arrivedMs).map(c => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => open(c)} data-lead={c.id}>
                  <td className="px-3 py-2 font-medium">{c.name}<span className="block text-xs font-normal text-slate-500">{c.phone ?? ''}</span></td>
                  <td className="px-3"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t(c.stageLabel)}</span></td>
                  <td className="px-3"><span className="flex flex-wrap gap-1">{c.chips.map(ch => <span key={ch.key} className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE[ch.tone]}`}>{ch.text}</span>)}</span></td>
                  <td className="px-3 text-xs text-slate-500">{c.filledIn}</td>
                  <td className="px-3 text-xs text-slate-500">{c.pickedText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wins.list.filter(w => !w.minimized).map(w => {
        const src = windowSrc(w.id)
        return (
          <div key={w.id} role="dialog" aria-label={w.name} data-testid="lead-window" data-lead={w.id}
            className={`fixed flex flex-col overflow-hidden rounded-xl border bg-white shadow-2xl ${front === w.id ? 'border-slate-500' : 'border-slate-300'}`}
            style={{ left: w.x, top: w.y, zIndex: 40 + w.z, width: WINDOW_W, height: Math.min(WINDOW_H, Math.max(320, vpRef.current.h - w.y - DOCK_H - 8)) }}
            onPointerDownCapture={() => { if (front !== w.id) setWins(s => focusWindow(s, w.id)) }}>
            <div className="flex shrink-0 cursor-move select-none items-center justify-between gap-2 border-b bg-slate-100 px-3 text-sm font-medium" style={{ height: TITLEBAR_H, touchAction: 'none' }}
              onPointerDown={e => onDown(e, w.id, w.x, w.y)}>
              <span className="min-w-0 truncate">{w.name}</span>
              <span className="flex shrink-0 gap-1">
                <button type="button" aria-label={t('Minimize')} data-testid="win-min" onClick={() => setWins(s => minimizeWindow(s, w.id))} className="rounded px-2 py-0.5 text-lg leading-none hover:bg-slate-200">−</button>
                <button type="button" aria-label={t('Close')} data-testid="win-close" onClick={() => setWins(s => closeWindow(s, w.id))} className="rounded px-2 py-0.5 text-lg leading-none hover:bg-slate-200">×</button>
              </span>
            </div>
            {src ? <iframe title={w.name} src={src} className="min-h-0 w-full flex-1 border-0 bg-slate-50" style={dragging ? { pointerEvents: 'none' } : undefined} /> : null}
          </div>
        )
      })}

      {wins.list.length > 0 && (
        <div className="fixed bottom-0 left-60 right-0 z-[200] flex items-center gap-2 border-t bg-white/95 px-4 text-xs shadow-[0_-2px_8px_rgba(0,0,0,.06)]" style={{ height: DOCK_H }} data-testid="window-dock">
          <span className="text-slate-400">{t('Windows')}</span>
          {wins.list.map(w => (
            <span key={w.id} className={`flex items-center overflow-hidden rounded-full border ${w.minimized ? 'bg-white' : 'bg-slate-100'}`}>
              <button type="button" onClick={() => setWins(s => (w.minimized ? openWindow(s, { id: w.id, name: w.name }, vpRef.current) : focusWindow(s, w.id)))} className="max-w-[10rem] truncate px-3 py-1 hover:bg-slate-50" data-testid="dock-item">{w.name}</button>
              <button type="button" aria-label={t('Close')} onClick={() => setWins(s => closeWindow(s, w.id))} className="px-2 py-1 text-slate-400 hover:text-slate-900">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
