'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@/components/marketing/lang-provider'
import { useLeadWindows } from '@/components/marketing/lead-windows-host'
import { romeLocalToIso } from '@/lib/marketing/rome-time'
import type { CalendarItem } from '@/lib/marketing/calendar'
import {
  BUCKETS, HOUR_FROM, HOUR_TO, addDays, bucketDrop, bucketOf, layoutDay, monthGrid, monthKey, moveToDay, romeLocalValue, romeParts, shiftMonth, slotIso, timeFromFraction, weekDays,
  type Bucket,
} from '@/lib/marketing/calendar-grid'

type View = 'day' | 'week' | 'month' | 'pipeline'
const VIEWS: readonly View[] = ['day', 'week', 'month', 'pipeline']
const VIEW_LABEL: Record<View, string> = { day: 'Day', week: 'Week', month: 'Month', pipeline: 'Pipeline' }
const VIEW_KEY = 'tdm_cal_view'
const PX = 52
const REASONS = ['The lead asked to move', 'The seller is not available', 'The setter is not available', 'The lead did not answer', 'A mix-up in the time', 'Other'] as const
const BUCKET_LABEL: Record<Bucket, string> = { late: 'Late', today: 'Today', tomorrow: 'Tomorrow', week: 'This week', later: 'Later' }
const STAGES: Array<{ key: CalendarItem['stage']; label: string }> = [{ key: 'back', label: 'Call back later' }, { key: 'booked', label: 'Call booked' }, { key: 'done', label: 'Call done' }, { key: 'paid', label: 'Paid' }]

const keyOf = (it: CalendarItem) => `${it.leadId}-${it.kind}`
const pad = (n: number) => String(n).padStart(2, '0')
const timeText = (iso: string) => { const p = romeParts(iso); return p ? `${pad(p.h)}:${pad(p.m)}` : '' }
const TONE = { appointment: 'border-sky-300 bg-sky-50 text-sky-900', callback: 'border-amber-300 bg-amber-50 text-amber-900' } as const

interface Pending { item: CalendarItem; at: string | null; suggest: string }

/**
 * TD Marketing — the Calendar (dev job 9aec66fa, round 2 step 2): Day, Week, Month and Pipeline. A call back and a booked call can be dragged to another day or time (or moved with the
 * "Move…" button, which works from the keyboard); a reason is ALWAYS asked, and the seller and the setter are told. Every day and hour is Rome time (lib/marketing/calendar-grid.ts).
 */
export function CalendarViews({ items, lateMore, nowIso, canMove, told, locale }: { items: CalendarItem[]; lateMore: number; nowIso: string; canMove: boolean; told: boolean; locale: string }) {
  const t = useT()
  const router = useRouter()
  const { open } = useLeadWindows()
  const today = romeParts(nowIso)?.key ?? '1970-01-01'
  const [view, setView] = useState<View>('week')
  const [anchor, setAnchor] = useState(today)
  const [byWhen, setByWhen] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // a move that was saved shows at its new time at once, until the refreshed page arrives
  const [moved, setMoved] = useState<Record<string, string>>({})
  const drag = useRef<CalendarItem | null>(null)
  useEffect(() => { try { const v = window.localStorage.getItem(VIEW_KEY); if (VIEWS.includes(v as View)) setView(v as View) } catch { /* only a convenience */ } }, [])
  useEffect(() => { setMoved({}) }, [items])
  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(null), 4000); return () => clearTimeout(h) }, [toast])
  const pick = (v: View) => { setView(v); try { window.localStorage.setItem(VIEW_KEY, v) } catch { /* only a convenience */ } }

  const shown = useMemo(() => items.map(it => (moved[keyOf(it)] ? { ...it, at: moved[keyOf(it)], late: false } : it)), [items, moved])
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...o })
  const utc = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
  const dayHead = (key: string) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(utc(key)).replace(',', '')
  const dayLong = (key: string) => fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(utc(key)).replace(',', '')
  const whenText = (iso: string) => { const p = romeParts(iso); return p ? `${dayHead(p.key)} ${pad(p.h)}:${pad(p.m)}` : '' }
  const byDay = (key: string) => shown.filter(i => romeParts(i.at)?.key === key).sort((a, b) => a.at.localeCompare(b.at))
  const movable = (it: CalendarItem) => canMove && !it.done

  const ask = (item: CalendarItem, at: string | null, suggest?: string) => {
    if (at !== null && new Date(at).getTime() < new Date(nowIso).getTime() - 5 * 60_000) { setToast(t('That time has already passed. Pick a day and time in the future.')); return }
    if (at !== null && new Date(at).getTime() === new Date(item.at).getTime()) return
    setPending({ item, at, suggest: suggest ?? at ?? item.at })
  }
  const dropOnDay = (key: string) => { const it = drag.current; drag.current = null; if (!it || !canMove) return; const at = moveToDay(it.at, key); if (at) ask(it, at) }
  const dropOnHour = (key: string, e: React.DragEvent<HTMLElement>) => {
    const it = drag.current; drag.current = null
    if (!it || !canMove) return
    const r = e.currentTarget.getBoundingClientRect()
    const { h, m } = timeFromFraction((e.clientY - r.top) / r.height)
    const at = slotIso(key, h, m)
    if (at) ask(it, at)
  }
  const dropOnBucket = (b: Bucket) => {
    const it = drag.current; drag.current = null
    if (!it || !canMove) return
    const d = bucketDrop(b, it.at, nowIso)
    if (d.kind === 'refuse') { setToast(b === 'late' ? t('A call cannot be moved into Late. Pick Today or later.') : t('That time is not possible.')); return }
    if (d.kind === 'move') ask(it, d.at)
    else ask(it, null, d.suggest)
  }

  const block = (it: CalendarItem, style?: React.CSSProperties, compact = false) => (
    <div key={keyOf(it)} role="button" tabIndex={0} draggable={movable(it)} data-testid="cal-item" data-lead={it.leadId}
      onClick={() => open({ id: it.leadId, name: it.name })} onKeyDown={e => { if (e.key === 'Enter') open({ id: it.leadId, name: it.name }) }}
      onDragStart={e => { drag.current = it; e.dataTransfer.setData('text/plain', keyOf(it)); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { drag.current = null }}
      className={`${compact ? 'relative mt-1' : 'absolute'} overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-xs ${TONE[it.kind]} ${it.late ? 'ring-2 ring-red-400' : ''} ${it.done ? 'opacity-70' : ''} ${movable(it) ? 'cursor-grab' : 'cursor-pointer'}`} style={style}>
      <span className="flex items-start justify-between gap-1">
        <b className="min-w-0 truncate font-medium">{it.name}</b>
        {movable(it) && <button type="button" aria-label={t('Move…')} data-testid="cal-move" onClick={e => { e.stopPropagation(); ask(it, null) }} className="shrink-0 rounded px-1 leading-none hover:bg-white/60">⇄</button>}
      </span>
      <span className="block truncate opacity-80">{timeText(it.at)} · {it.kind === 'appointment' ? t('Call with the seller') : t('Call back')}{it.late ? ` · ${t('Late')}` : ''}{it.done ? ` · ${t('done')}` : ''}</span>
    </div>
  )

  const hourGrid = (keys: string[]) => {
    const rows = HOUR_TO - HOUR_FROM
    const outside = keys.map(k => byDay(k).filter(i => { const p = romeParts(i.at); return !p || p.h < HOUR_FROM || p.h >= HOUR_TO }))
    return (
      <div className="min-w-[44rem] overflow-x-auto">
        <div className="grid" style={{ gridTemplateColumns: `3.5rem repeat(${keys.length}, minmax(0, 1fr))` }}>
          <div />
          {keys.map(k => <div key={k} className={`border-b border-l px-2 py-2 text-center text-sm font-medium ${k === today ? 'text-sky-700' : ''}`}>{dayHead(k)}</div>)}
          {outside.some(o => o.length > 0) && <>
            <div className="px-1 py-1 text-[11px] text-slate-500">{t('Outside {from}:00–{to}:00', { from: pad(HOUR_FROM), to: pad(HOUR_TO) })}</div>
            {outside.map((o, i) => <div key={keys[i]} className="border-b border-l p-1">{o.map(it => block(it, undefined, true))}</div>)}
          </>}
          <div>{Array.from({ length: rows }, (_, i) => <div key={i} className="border-t px-1 text-[11px] text-slate-500" style={{ height: PX }}>{pad(HOUR_FROM + i)}:00</div>)}</div>
          {keys.map(k => {
            const list = byDay(k)
            const placed = layoutDay(list.map(i => { const p = romeParts(i.at); return { h: p?.h ?? 0, m: p?.m ?? 0 } }))
            return (
              <div key={k} className="relative border-l" style={{ height: rows * PX }} data-day={k} data-testid="cal-col"
                onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); dropOnHour(k, e) }}>
                {Array.from({ length: rows }, (_, i) => <div key={i} className="border-t" style={{ height: PX }} />)}
                {placed.map(p => block(list[p.index], { top: p.top * PX, height: PX * 0.62, left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`, width: `calc(${100 / p.lanes}% - 4px)` }))}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const monthView = () => {
    const keys = monthGrid(anchor)
    const names = weekDays(today).map(k => fmt({ weekday: 'short' }).format(utc(k)))
    return (
      <div className="min-w-[44rem]">
        <div className="grid grid-cols-7">{names.map(n => <div key={n} className="border-b px-2 py-2 text-center text-sm font-medium">{n}</div>)}</div>
        <div className="grid grid-cols-7">
          {keys.map(k => {
            const list = byDay(k)
            return (
              <div key={k} data-day={k} data-testid="cal-cell" onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); dropOnDay(k) }}
                className={`min-h-[6.5rem] border-l border-t p-1 ${monthKey(k) !== monthKey(anchor) ? 'bg-slate-50' : ''} ${k === today ? 'ring-2 ring-inset ring-sky-400' : ''}`}>
                <span className="text-xs text-slate-500">{Number(k.slice(8))}</span>
                {list.slice(0, 3).map(it => block(it, undefined, true))}
                {list.length > 3 && <button type="button" onClick={() => { setAnchor(k); pick('day') }} className="mt-1 block text-xs text-slate-600 underline">{t('{n} more', { n: list.length - 3 })}</button>}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const card = (it: CalendarItem, draggable: boolean) => (
    <div key={keyOf(it)} draggable={draggable && movable(it)} data-testid="cal-card" data-lead={it.leadId}
      onDragStart={e => { drag.current = it; e.dataTransfer.setData('text/plain', keyOf(it)); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { drag.current = null }}
      className={`mb-2 rounded-lg border bg-white p-2 text-sm ${draggable && movable(it) ? 'cursor-grab' : ''}`}>
      <button type="button" onClick={() => open({ id: it.leadId, name: it.name })} className="block max-w-full truncate text-left font-medium hover:underline">{it.name}</button>
      <span className="block text-xs text-slate-500">{whenText(it.at)}{it.late ? ` · ${t('Late')}` : ''} · {it.kind === 'appointment' ? t('Call with the seller') : t('Call back')}</span>
      {movable(it) && <button type="button" onClick={() => ask(it, null)} data-testid="cal-move" className="mt-1.5 rounded border px-2 py-0.5 text-xs hover:bg-slate-50">{t('Move…')}</button>}
    </div>
  )

  const pipeline = () => {
    const open_ = shown.filter(i => !i.done)
    return (
      <div className="p-3">
        <div className="mb-3 flex overflow-hidden rounded-lg border bg-white text-sm" role="group" aria-label={t('Group by')} style={{ width: 'fit-content' }}>
          {[true, false].map(v => <button key={String(v)} type="button" aria-pressed={byWhen === v} onClick={() => setByWhen(v)} data-testid={v ? 'pipe-when' : 'pipe-stage'}
            className={`px-4 py-1.5 ${byWhen === v ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{v ? t('By when') : t('By stage')}</button>)}
        </div>
        {byWhen ? (
          <>
            <p className="mb-2 text-xs text-slate-500">{canMove ? t('Drag a card to another group: Today and Tomorrow keep its time of day; This week and Later ask you for the day and time. You cannot drop into Late. A reason is always asked.') : ''}</p>
            <div className="grid gap-3 overflow-x-auto" style={{ gridTemplateColumns: 'repeat(5, minmax(11rem, 1fr))' }}>
              {BUCKETS.map(b => {
                const list = open_.filter(i => bucketOf(i.at, nowIso) === b)
                return (
                  <section key={b} data-bucket={b} aria-label={t(BUCKET_LABEL[b])} className="min-w-0 rounded-xl bg-slate-100 p-2"
                    onDragOver={e => { if (drag.current) e.preventDefault() }} onDrop={e => { e.preventDefault(); dropOnBucket(b) }}>
                    <h2 className={`px-1 pb-2 text-xs font-semibold ${b === 'late' ? 'text-red-700' : 'text-slate-600'}`}>{t(BUCKET_LABEL[b])} · {list.length}</h2>
                    {list.length === 0 ? <p className="px-1 py-3 text-xs text-slate-400">{t('Nothing here.')}</p> : list.map(i => card(i, true))}
                  </section>
                )
              })}
            </div>
          </>
        ) : (
          <div className="grid gap-3 overflow-x-auto" style={{ gridTemplateColumns: 'repeat(4, minmax(11rem, 1fr))' }}>
            {STAGES.map(s => {
              const list = shown.filter(i => i.stage === s.key)
              return (
                <section key={s.key} data-stage={s.key} aria-label={t(s.label)} className="min-w-0 rounded-xl bg-slate-100 p-2">
                  <h2 className="px-1 pb-2 text-xs font-semibold text-slate-600">{t(s.label)} · {list.length}</h2>
                  {list.length === 0 ? <p className="px-1 py-3 text-xs text-slate-400">{t('Nothing here.')}</p> : list.map(i => card(i, false))}
                </section>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const nav = (n: number) => setAnchor(a => (view === 'month' ? shiftMonth(a, n) : addDays(a, view === 'day' ? n : 7 * n)))
  const keys = view === 'day' ? [anchor] : weekDays(anchor)
  const title = view === 'pipeline' ? t('Open calls') : view === 'month' ? fmt({ month: 'long', year: 'numeric' }).format(utc(anchor)) : view === 'day' ? dayLong(anchor) : `${dayHead(keys[0])} – ${dayLong(keys[6])}`
  const late = shown.filter(i => i.late).sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border bg-white text-sm" role="group" aria-label={t('View')}>
          {VIEWS.map(v => <button key={v} type="button" onClick={() => pick(v)} aria-pressed={view === v} data-testid={`cal-view-${v}`} className={`px-4 py-1.5 ${view === v ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{t(VIEW_LABEL[v])}</button>)}
        </div>
        {view !== 'pipeline' && (
          <div className="flex items-center gap-1.5 text-sm">
            <button type="button" aria-label={t('Earlier')} onClick={() => nav(-1)} data-testid="cal-prev" className="rounded-lg border bg-white px-3 py-1.5 hover:bg-slate-50">◀</button>
            <button type="button" onClick={() => setAnchor(today)} data-testid="cal-today" className="rounded-lg border bg-white px-3 py-1.5 hover:bg-slate-50">{t('Today')}</button>
            <button type="button" aria-label={t('Later')} onClick={() => nav(1)} data-testid="cal-next" className="rounded-lg border bg-white px-3 py-1.5 hover:bg-slate-50">▶</button>
          </div>
        )}
        <b className="text-sm" data-testid="cal-title">{title}</b>
        <span className="ml-auto flex gap-3 text-xs text-slate-500">
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-sky-300 bg-sky-50" />{t('Call with the seller')}</span>
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50" />{t('Call back')}</span>
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-red-400" />{t('Late')}</span>
        </span>
      </div>
      {!canMove && <p className="text-xs text-slate-500">{t('You can look at the calendar but not move calls.')}</p>}
      {canMove && view !== 'pipeline' && <p className="text-xs text-slate-500">{t('Drag a call to another time or day, or press ⇄ to choose. A reason is always asked.')}</p>}

      <div className="overflow-x-auto rounded-xl border bg-white" data-testid="cal-area">
        {view === 'month' ? monthView() : view === 'pipeline' ? pipeline() : hourGrid(keys)}
      </div>

      {late.length > 0 && view !== 'pipeline' && (
        <section aria-label={t('Late call backs')} data-testid="cal-late" className="rounded-xl border border-red-300 bg-white p-3">
          <h2 className="mb-2 text-sm font-medium text-red-700">{t('Late · {n}', { n: late.length + lateMore })}</h2>
          <ul className="divide-y">
            {late.map(it => (
              <li key={keyOf(it)} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate"><button type="button" onClick={() => open({ id: it.leadId, name: it.name })} className="font-medium hover:underline">{it.name}</button> <span className="text-xs text-slate-500">· {t('was')} {whenText(it.at)}</span></span>
                {movable(it) && <button type="button" onClick={() => ask(it, null)} data-testid="cal-move" className="shrink-0 rounded border px-2 py-0.5 text-xs hover:bg-slate-50">{t('Move…')}</button>}
              </li>
            ))}
          </ul>
          {lateMore > 0 && <p className="mt-1.5 text-xs text-slate-500">{t('…and {n} more, less overdue than these.', { n: lateMore })}</p>}
        </section>
      )}

      {pending && <MoveDialog pending={pending} nowIso={nowIso} told={told} whenText={whenText} onClose={() => setPending(null)}
        onDone={(item, at, message) => { setMoved(m => ({ ...m, [keyOf(item)]: at })); setPending(null); setToast(message); router.refresh() }} />}
      {toast && <p role="status" className="fixed bottom-16 left-1/2 z-[400] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg" data-testid="cal-toast">{toast}</p>}
    </div>
  )
}

function MoveDialog({ pending, nowIso, told, whenText, onClose, onDone }: { pending: Pending; nowIso: string; told: boolean; whenText: (iso: string) => string; onClose: () => void; onDone: (item: CalendarItem, at: string, message: string) => void }) {
  const t = useT()
  const { item } = pending
  const [local, setLocal] = useState(romeLocalValue(pending.suggest))
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const at = pending.at ?? romeLocalToIso(local)
  const past = at !== null && new Date(at).getTime() < new Date(nowIso).getTime() - 5 * 60_000
  const needsNote = reason === 'Other' && note.trim() === ''
  const ready = !!reason && !!at && !past && !needsNote && !busy
  // Escape closes the box wherever the focus is
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const save = async () => {
    if (!ready || !at || !reason) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/marketing/leads/${item.leadId}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reschedule', target: item.kind === 'appointment' ? 'appointment' : 'callback', at, reason, note: note.trim() || undefined, from: item.at }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('Could not move the call. Please try again.')) }
      onDone(item, at, told ? t('Moved. The seller and the setter were told.') : t('Moved.'))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('Could not move the call. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('Why is this call moving?')} data-testid="move-dialog">
      <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold">{t('Why is this call moving?')}</h2>
        <p className="text-xs text-slate-500">{t('A reason is required. The seller and the setter are told.')}</p>
        <p className="rounded-lg bg-slate-100 p-2.5 text-sm"><b>{item.name}</b> · {item.kind === 'appointment' ? t('Call with the seller') : t('Call back')}<br />{whenText(item.at)} → {at ? whenText(at) : '…'}</p>
        {pending.at === null && (
          <label className="block text-xs text-slate-600">{t('New day and time (Rome time)')}
            <input type="datetime-local" value={local} onChange={e => setLocal(e.target.value)} data-testid="move-when" className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" />
          </label>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Reason')}>
          {REASONS.map(r => <button key={r} type="button" aria-pressed={reason === r} onClick={() => setReason(r)} data-testid="move-reason"
            className={`rounded-full border px-3 py-1 text-sm ${reason === r ? 'border-slate-900 bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{t(r)}</button>)}
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} data-testid="move-note" placeholder={reason === 'Other' ? t('Tell us why (required)') : t('Anything else to add? (optional)')} className="w-full rounded-lg border px-2 py-1.5 text-sm" />
        {past && <p role="alert" className="text-sm text-red-700">{t('That time has already passed. Pick a day and time in the future.')}</p>}
        {error && <p role="alert" className="text-sm text-red-700" data-testid="move-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">{t('Cancel')}</button>
          <button type="button" onClick={save} disabled={!ready} data-testid="move-save" className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-40">{busy ? t('Saving…') : t('Move the call')}</button>
        </div>
      </div>
    </div>
  )
}
