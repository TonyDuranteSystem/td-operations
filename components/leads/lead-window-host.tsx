'use client'

/**
 * The floating lead window (dev job 6fc63c52, phase A) — read-only.
 *
 * Click a lead on the Leads page (table row or board card) and it opens in a
 * window over the list: movable, up to four at once, minimizes to a pill at
 * the bottom, remembers where you left it. It shows the lead's calls, offer,
 * notes and one story, and reads a call's transcript in place. A plain click
 * opens the window; Ctrl/Cmd/Shift-click, middle-click, and any screen under
 * 1024px keep the old behaviour (go to the full page), so no link is lost.
 *
 * Nothing in here writes. Every action that changes a lead stays on the full page.
 *
 * Stacking: the notes layer is z-45 and the team chat z-46, modals 70/80. These
 * windows stay at 40–43 (stack order = array order) so they can never cover
 * the chat or trap a modal's buttons.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import {
  X, Minus, GripVertical, ExternalLink, Phone, Mail, FileText, CheckCircle2, UserPlus, Zap, Search, RefreshCw, CalendarPlus, ArrowRightLeft, MessageCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { STAGE_STEPS, type WindowData, type WindowStoryEvent, type WindowCall, type TranscriptLine } from '@/lib/leads/window-data'
import { LEAD_OWNERS, addDaysYmd, FOLLOW_UP_DAYS_AFTER_CALL } from '@/lib/leads/owners'
import type { MessageEvent } from '@/lib/leads/window-messages'

interface OpenWin { id: string; name: string; minimized: boolean; x: number; y: number; seq: number }

const POS_KEY = 'td-lead-window-pos'
const MAX_WINDOWS = 4
const WIN_W = 1040
const WIN_H = 760

function readPos(): { x: number; y: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    return typeof p?.x === 'number' && typeof p?.y === 'number' ? p : null
  } catch { return null }
}
function savePos(p: { x: number; y: number }) {
  try { window.localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* private mode / quota */ }
}
function clampPos(p: { x: number; y: number }, w: number): { x: number; y: number } {
  const vw = window.innerWidth, vh = window.innerHeight
  // The whole window stays inside the screen sideways; it may be dragged down until only its title bar shows.
  return { x: Math.min(Math.max(0, p.x), Math.max(0, vw - w)), y: Math.min(Math.max(0, p.y), Math.max(0, vh - 56)) }
}
function winSize() {
  return { w: Math.min(WIN_W, window.innerWidth - 48), h: Math.min(WIN_H, window.innerHeight - 48) }
}

// ── context ──────────────────────────────────────────────────────────────

const Ctx = createContext<{ open: (id: string, name: string) => void } | null>(null)

/** Returns a click handler factory for a lead link; null-safe outside the provider. */
export function useLeadWindowOpener() {
  const ctx = useContext(Ctx)
  return useCallback((id: string, name: string) => (e: React.MouseEvent) => {
    if (!ctx) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 1024px)').matches) return
    e.preventDefault()
    ctx.open(id, name)
  }, [ctx])
}

export function LeadWindowProvider({ children }: { children: React.ReactNode }) {
  const [wins, setWins] = useState<OpenWin[]>([])
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Stack order is a counter, not the array order: re-ordering the elements on a
  // click would move them in the page and drop the drag that is just starting.
  const seqRef = useRef(0)
  const open = useCallback((id: string, name: string) => {
    setWins(prev => {
      const seq = ++seqRef.current
      const existing = prev.find(w => w.id === id)
      if (existing) return prev.map(w => (w.id === id ? { ...w, minimized: false, seq } : w))
      const base = readPos() ?? { x: 260, y: 40 }
      const pos = clampPos({ x: base.x + 28 * prev.length, y: base.y + 28 * prev.length }, winSize().w)
      const next = [...prev, { id, name, minimized: false, x: pos.x, y: pos.y, seq }]
      return next.length > MAX_WINDOWS ? [...next].sort((a, b) => a.seq - b.seq).slice(next.length - MAX_WINDOWS) : next
    })
  }, [])
  const close = useCallback((id: string) => setWins(prev => prev.filter(w => w.id !== id)), [])
  const setMin = useCallback((id: string, minimized: boolean) =>
    setWins(prev => prev.map(w => (w.id === id ? { ...w, minimized, seq: minimized ? w.seq : ++seqRef.current } : w))), [])
  const focus = useCallback((id: string) =>
    setWins(prev => {
      const top = Math.max(...prev.map(w => w.seq))
      const w = prev.find(x => x.id === id)
      if (!w || w.seq === top) return prev
      return prev.map(x => (x.id === id ? { ...x, seq: ++seqRef.current } : x))
    }), [])
  const move = useCallback((id: string, x: number, y: number) =>
    setWins(prev => prev.map(w => (w.id === id ? { ...w, x, y } : w))), [])

  const value = useMemo(() => ({ open }), [open])
  const minimized = wins.filter(w => w.minimized)

  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted && createPortal(
        <>
          {wins.map(w => (
            <LeadWindow
              key={w.id}
              win={w}
              z={40 + [...wins].sort((a, b) => a.seq - b.seq).findIndex(x => x.id === w.id)}
              onClose={() => close(w.id)}
              onMinimize={() => setMin(w.id, true)}
              onFocus={() => focus(w.id)}
              onMove={(x, y) => move(w.id, x, y)}
            />
          ))}
          {minimized.length > 0 && (
            <div className="fixed bottom-4 left-4 lg:left-72 flex gap-2 z-[45]">
              {minimized.map(w => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setMin(w.id, false)}
                  className="flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-medium shadow-lg hover:bg-zinc-50"
                  aria-label={`Open ${w.name}`}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-[10px] font-semibold text-white">{initials(w.name)}</span>
                  {w.name}
                </button>
              ))}
            </div>
          )}
        </>,
        document.body,
      )}
    </Ctx.Provider>
  )
}

// ── small helpers ────────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try { return format(parseISO(iso), 'd MMM yyyy') } catch { return iso.slice(0, 10) }
}

const CALL_CHIP: Record<WindowCall['state'], string> = {
  done: 'bg-emerald-50 text-emerald-800',
  scheduled: 'bg-blue-50 text-blue-800',
  due_today: 'bg-amber-50 text-amber-800',
  not_confirmed: 'bg-red-50 text-red-700',
  no_show: 'bg-zinc-100 text-zinc-700',
  moved: 'bg-zinc-100 text-zinc-700',
  cancelled: 'bg-zinc-100 text-zinc-700',
}
const COLOR_DOT: Record<string, string> = {
  gray: 'bg-zinc-100 text-zinc-600', blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600',
  amber: 'bg-amber-50 text-amber-600', purple: 'bg-violet-50 text-violet-600', indigo: 'bg-indigo-50 text-indigo-600',
  emerald: 'bg-emerald-50 text-emerald-600', sky: 'bg-sky-50 text-sky-600', red: 'bg-red-50 text-red-600',
}
function storyIcon(type: WindowStoryEvent['type']) {
  if (type === 'call_completed') return Phone
  if (type === 'call_booked') return CalendarPlus
  if (type === 'status_moved') return ArrowRightLeft
  if (type.startsWith('offer') || type === 'activation_created') return FileText
  if (type.startsWith('email')) return Mail
  if (type === 'contract_signed' || type === 'payment_confirmed') return CheckCircle2
  if (type === 'lead_created') return UserPlus
  return Zap
}

async function readError(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}))
  return (d && typeof d.error === 'string' && d.error) || fallback
}

function fmtStart(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }) + ' New York'
  } catch { return iso }
}

async function postJson(url: string, body: unknown, fallback: string): Promise<{ message: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || d?.ok === false) throw new Error((d && (d.message || d.error)) || fallback)
  return { message: d?.message ?? '' }
}

// ── one window ───────────────────────────────────────────────────────────

function LeadWindow({ win, z, onClose, onMinimize, onFocus, onMove }: {
  win: OpenWin; z: number; onClose: () => void; onMinimize: () => void; onFocus: () => void; onMove: (x: number, y: number) => void
}) {
  const [data, setData] = useState<WindowData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'calls' | 'messages' | 'offer'>('all')
  const [messages, setMessages] = useState<MessageEvent[]>([])
  const [messagesError, setMessagesError] = useState('')
  const [reading, setReading] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const drag = useRef<{ sx: number; sy: number; x0: number; y0: number } | null>(null)
  const size = useRef(winSize())

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/crm/leads/${win.id}/window`)
      if (!res.ok) throw new Error(await readError(res, 'Could not load this lead — please try again.'))
      const d = await res.json()
      setData(d.data as WindowData)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load this lead — please try again.')
    } finally {
      setLoading(false)
    }
  }, [win.id])
  useEffect(() => { load() }, [load])

  // Emails and WhatsApp come in their own call so a slow inbox never holds the window back.
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`/api/crm/leads/${win.id}/window/messages`)
        if (!res.ok) throw new Error(await readError(res, 'Could not load the messages — please try again.'))
        const d = await res.json()
        if (live) { setMessages((d.events ?? []) as MessageEvent[]); setMessagesError('') }
      } catch (err) {
        if (live) setMessagesError(err instanceof Error && err.message ? err.message : 'Could not load the messages — please try again.')
      }
    })()
    return () => { live = false }
  }, [win.id])

  async function act(run: () => Promise<{ message: string }>, fallback: string) {
    setBusy(true)
    setNotice(null)
    try {
      const r = await run()
      setNotice({ ok: true, text: r.message || 'Done.' })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error && err.message ? err.message : fallback })
    } finally {
      setBusy(false)
      load()
    }
  }
  const answerCall = (rowId: string, action: 'happened' | 'no_show' | 'rebook') =>
    act(() => postJson(`/api/crm/leads/${win.id}/calls/${rowId}`, { action }, 'Could not save your answer — please try again.'), 'Could not save your answer — please try again.')
  const undoMove = (moveId: string) =>
    act(() => postJson(`/api/crm/leads/${win.id}/moves/${moveId}/undo`, {}, 'Could not undo — please try again.'), 'Could not undo — please try again.')
  const saveField = (field: 'owner' | 'follow_up_date', value: string | null, expected: string | null) =>
    act(async () => {
      const res = await fetch(`/api/crm/leads/${win.id}/window/fields`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value, [`expected_${field}`]: expected }),
      })
      if (!res.ok) throw new Error(await readError(res, 'Could not save — please try again.'))
      return { message: 'Saved.' }
    }, 'Could not save — please try again.')

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,a')) return
    onFocus()
    drag.current = { sx: e.clientX, sy: e.clientY, x0: win.x, y0: win.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = clampPos({ x: d.x0 + e.clientX - d.sx, y: d.y0 + e.clientY - d.sy }, size.current.w)
    onMove(p.x, p.y)
  }
  const onPointerUp = () => {
    if (drag.current) { savePos({ x: win.x, y: win.y }); drag.current = null }
  }

  if (win.minimized) return null
  const stage = data?.lead.stageIndex ?? -1
  // One story: call/offer events from the window data plus the emails and chats, newest first.
  const messageEvents: WindowStoryEvent[] = messages.map(m => ({
    date: m.date,
    type: m.channel === 'email' ? 'email_sent' : 'call_booked',
    color: m.channel === 'email' ? 'sky' : 'green',
    title: m.title,
    detail: m.detail,
    group: 'messages',
    undo: null,
    channel: m.channel,
    direction: m.direction,
    matchReason: m.matchReason,
    count: m.count,
  }))
  const shownStory = data
    ? [...data.story, ...messageEvents]
        .filter(e => filter === 'all' || e.group === filter)
        .sort((a, b) => b.date.localeCompare(a.date))
    : []

  return (
    <div
      role="dialog"
      aria-label={`Lead ${win.name}`}
      tabIndex={-1}
      onMouseDown={onFocus}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      style={{ left: win.x, top: win.y, width: size.current.w, height: size.current.h, zIndex: z }}
      className="fixed flex flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl outline-none"
    >
      {/* title bar */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex cursor-move select-none items-center gap-3 border-b bg-zinc-50 px-4 py-3 touch-none"
      >
        <GripVertical className="h-4 w-4 text-zinc-400" />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white">{initials(win.name)}</div>
        <div className="min-w-0">
          <div className="truncate text-lg font-bold leading-tight">{data?.lead.name ?? win.name}</div>
          {data && (
            <div className="truncate text-xs text-zinc-500">
              {[data.lead.email, data.lead.phone, data.lead.language].filter(Boolean).join('  |  ')}
            </div>
          )}
        </div>
        {data?.lead.badges.map(b => (
          <span key={b} className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{b}</span>
        ))}
        <div className="flex-1" />
        <Link href={`/leads/${win.id}`} className="flex shrink-0 items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50">
          Open full page <ExternalLink className="h-3.5 w-3.5" />
        </Link>
        <button type="button" onClick={onMinimize} aria-label="Minimize" className="flex h-8 w-8 items-center justify-center rounded-lg border bg-white hover:bg-zinc-50"><Minus className="h-4 w-4" /></button>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg border bg-white hover:bg-zinc-50"><X className="h-4 w-4" /></button>
      </div>

      {loading && !data && <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>}
      {error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm text-red-600">{error}</p>
          <button type="button" onClick={load} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"><RefreshCw className="h-3.5 w-3.5" />Try again</button>
        </div>
      )}

      {data && !error && (
        <>
          {/* stage bar */}
          <div className="flex gap-1.5 border-b px-4 py-3">
            {STAGE_STEPS.map((label, i) => (
              <div
                key={label}
                className={cn(
                  'flex-1 rounded-lg py-1.5 text-center text-xs font-semibold',
                  stage < 0 ? 'bg-zinc-100 text-zinc-500' : i < stage ? 'bg-zinc-900 text-white' : i === stage ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-500',
                )}
              >
                {label}
              </div>
            ))}
          </div>
          {stage < 0 && data.lead.status && (
            <div className="border-b bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-700">Status: {data.lead.status}</div>
          )}

          {/* owner + follow-up */}
          <div className="flex flex-wrap items-center gap-4 border-b px-4 py-2.5 text-sm">
            <label className="flex items-center gap-2 text-zinc-500">
              Owner
              <select
                value={data.lead.owner ?? ''}
                disabled={busy}
                onChange={e => saveField('owner', e.target.value || null, data.lead.owner)}
                aria-label="Owner"
                className="rounded-lg border bg-white px-2 py-1 font-semibold text-zinc-900"
              >
                <option value="">No owner</option>
                {LEAD_OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-zinc-500">
              Follow-up
              <input
                type="date"
                value={data.lead.followUpDate ?? ''}
                disabled={busy}
                onChange={e => saveField('follow_up_date', e.target.value || null, data.lead.followUpDate)}
                aria-label="Follow-up date"
                className="rounded-lg border bg-white px-2 py-1 font-semibold text-zinc-900"
              />
            </label>
            {notice && <span className={cn('text-sm font-semibold', notice.ok ? 'text-emerald-700' : 'text-red-600')}>{notice.text}</span>}
          </div>

          {/* next action */}
          <div className="flex items-center gap-4 border-b border-blue-100 bg-blue-50 px-4 py-3">
            <span className="shrink-0 text-[11px] font-bold tracking-wider text-blue-700">NEXT ACTION</span>
            <span className="flex-1 text-[15px] font-semibold">{data.nextAction}</span>
            <button type="button" onClick={() => { setReading(null); setDrafting(true) }} className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Draft follow-up</button>
          </div>

          {drafting ? (
            <DraftPanel leadId={win.id} leadName={data.lead.name} onBack={() => setDrafting(false)} onSent={load} />
          ) : reading ? (
            <TranscriptReader leadId={win.id} callId={reading} onBack={() => setReading(null)} />
          ) : (
            <div className="flex min-h-0 flex-1">
              {/* left rail */}
              <div className="w-[380px] shrink-0 space-y-4 overflow-auto border-r p-5">
                <div>
                  <div className="mb-2 text-[11px] font-bold tracking-wider text-zinc-500">CALLS</div>
                  {data.calls.length === 0 && <p className="text-sm text-zinc-500">No call yet.</p>}
                  <div className="space-y-2.5">
                    {data.calls.map(c => (
                      <div key={c.key} className={cn('rounded-xl border p-3.5', c.state === 'not_confirmed' && 'border-red-200', c.state === 'scheduled' && 'border-blue-200 bg-blue-50/40', (c.state === 'moved' || c.state === 'cancelled') && 'bg-zinc-50 text-zinc-500')}>
                        <div className="flex items-center justify-between">
                          <span className={cn('font-bold', (c.state === 'moved' || c.state === 'cancelled') && 'line-through')}>{c.title}</span>
                          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', CALL_CHIP[c.state])}>{c.chip}</span>
                        </div>
                        <dl className="mt-2 grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 text-sm text-zinc-700">
                          {c.bookedAt && (<><dt className="text-zinc-500">Booked</dt><dd>{fmtDate(c.bookedAt)}</dd></>)}
                          {(c.scheduledStart || c.scheduledFor) && (<><dt className="text-zinc-500">Planned for</dt><dd>{c.scheduledStart ? fmtStart(c.scheduledStart) : fmtDate(c.scheduledFor)}</dd></>)}
                          {c.happenedAt && (<><dt className="text-zinc-500">Happened</dt><dd>{fmtDate(c.happenedAt)}{c.durationMin ? `, ${c.durationMin} min` : ''}</dd></>)}
                        </dl>
                        {c.summary && <p className="mt-2 text-sm leading-relaxed text-zinc-700"><span className="text-[11px] font-bold tracking-wide text-violet-700">SUMMARY </span>{c.summary}</p>}
                        {c.state === 'moved' && <p className="mt-2 text-sm">Moved to a later date. The new call is below.</p>}
                        {c.canConfirm && c.rowId && (
                          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                            <p className="text-sm font-semibold text-red-700">{c.state === 'due_today' ? 'This call is today. Did it happen?' : 'The date passed and no recording came back. Did it happen?'}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button type="button" disabled={busy} onClick={() => answerCall(c.rowId as string, 'happened')} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">Yes, it happened</button>
                              <button type="button" disabled={busy} onClick={() => answerCall(c.rowId as string, 'no_show')} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">No-show</button>
                              <button type="button" disabled={busy} onClick={() => answerCall(c.rowId as string, 'rebook')} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">Rebook</button>
                            </div>
                          </div>
                        )}
                        {(c.hasTranscript || c.recordingUrl) && (
                          <div className="mt-3 flex gap-2">
                            {c.hasTranscript && c.callId && (
                              <button type="button" onClick={() => setReading(c.callId)} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50">Read transcript</button>
                            )}
                            {c.recordingUrl && (
                              <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50">Recording</a>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border p-3.5">
                  <div className="mb-1.5 text-[11px] font-bold tracking-wider text-zinc-500">OFFER</div>
                  {data.offer ? (
                    <>
                      <div className="font-semibold">{data.offer.line}</div>
                      {data.offer.sub && <div className="mt-1 text-sm text-zinc-500">{data.offer.sub}</div>}
                    </>
                  ) : <p className="text-sm text-zinc-500">No offer yet.</p>}
                </div>

                <div className="rounded-xl border p-3.5">
                  <div className="mb-1.5 text-[11px] font-bold tracking-wider text-zinc-500">NOTES</div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{data.notes ?? 'No notes.'}</p>
                </div>
                <p className="text-sm text-zinc-500">Source: {data.lead.source ?? 'unknown'}. Referrer: {data.lead.referrer ?? 'none'}.</p>
              </div>

              {/* story */}
              <div className="min-w-0 flex-1 space-y-4 overflow-auto p-5">
                <div className="flex items-center gap-2">
                  <span className="mr-1 text-[11px] font-bold tracking-wider text-zinc-500">STORY</span>
                  {([['all', 'All'], ['calls', 'Calls'], ['messages', 'Messages'], ['offer', 'Offer and money']] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFilter(k)}
                      className={cn('rounded-full border px-3 py-1 text-sm font-semibold', filter === k ? 'border-zinc-900 bg-zinc-900 text-white' : 'bg-white text-zinc-700 hover:bg-zinc-50')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {messagesError && <p className="text-sm text-red-600">{messagesError}</p>}
                <ol className="relative space-y-4 pl-9">
                  <span className="absolute bottom-2 left-[13px] top-2 w-0.5 bg-zinc-200" />
                  {shownStory.map((e, i) => {
                    const Icon = e.channel === 'whatsapp' ? MessageCircle : e.channel === 'email' ? Mail : storyIcon(e.type)
                    return (
                      <li key={`${e.date}-${e.type}-${i}`} className="relative">
                        <span className={cn('absolute -left-9 top-0 flex h-7 w-7 items-center justify-center rounded-full', COLOR_DOT[e.color] ?? COLOR_DOT.gray)}><Icon className="h-3.5 w-3.5" /></span>
                        <div className="flex flex-wrap items-baseline gap-2"><span className="font-bold">{e.title}</span><span className="text-sm text-zinc-500">{fmtDate(e.date)}</span></div>
                        {e.channel && (
                          <div className="mt-0.5 text-xs text-zinc-500">
                            {e.channel === 'email' ? 'Email' : 'WhatsApp'}, {e.direction === 'in' ? 'from them' : 'from us'}
                            {e.count && e.count > 1 && e.channel === 'email' ? `, ${e.count} messages in the thread` : ''}. Matched: {e.matchReason}.
                          </div>
                        )}
                        {e.detail && <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-zinc-700">{e.detail}</p>}
                        {e.undo && (
                          <button type="button" disabled={busy} onClick={() => undoMove(e.undo!.moveId)} className="mt-1.5 rounded-lg border bg-white px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
                            Undo, {e.undo.hoursLeft} {e.undo.hoursLeft === 1 ? 'hour' : 'hours'} left
                          </button>
                        )}
                      </li>
                    )
                  })}
                  {shownStory.length === 0 && <li className="text-sm text-zinc-500">Nothing here yet.</li>}
                </ol>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── follow-up draft + rewrite assistant ──────────────────────────────────

interface DraftInfo {
  basedOn: string[]
  notPromised: string[]
  language: string
  target: { to: string | null; canSend: boolean; conversationId: string | null; reason: string }
}

function DraftPanel({ leadId, leadName, onBack, onSent }: { leadId: string; leadName: string; onBack: () => void; onSent: () => void }) {
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp')
  const [texts, setTexts] = useState<Record<string, string>>({ whatsapp: '', email: '' })
  const [subject, setSubject] = useState('')
  const [info, setInfo] = useState<Record<string, DraftInfo | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [log, setLog] = useState<{ who: string; text: string }[]>([])
  const [instr, setInstr] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [sentMsg, setSentMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const text = texts[channel]
  const cur = info[channel]
  const placeholders = Array.from(new Set(text.match(/\[[^\]\n]{1,60}\]/g) ?? []))

  async function run(mode: 'draft' | 'rewrite' | 'check', instruction = '') {
    setBusy(true)
    setError('')
    setConfirm(false)
    try {
      const res = await fetch(`/api/crm/leads/${leadId}/draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, mode, instruction, current_text: text }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((d && d.error) || 'Could not reach the assistant — please try again.')
      if (mode === 'check') {
        setLog(l => [...l, { who: 'You', text: 'Check the draft against the story' }, { who: 'Worker', text: (d.review as string[] | undefined)?.join('\n') || 'Nothing to report.' }])
        if (d.target) setInfo(i => ({ ...i, [channel]: { ...(i[channel] as DraftInfo), target: d.target } }))
        return
      }
      setTexts(t => ({ ...t, [channel]: d.text as string }))
      if (d.subject) setSubject(d.subject as string)
      setInfo(i => ({ ...i, [channel]: { basedOn: d.based_on, notPromised: d.not_promised, language: d.language, target: d.target } }))
      if (mode === 'rewrite') setLog(l => [...l, { who: 'You', text: instruction }, { who: 'Worker', text: 'Rewritten. Read it before you send.' }])
      setInstr('')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not reach the assistant — please try again.')
    } finally {
      setBusy(false)
    }
  }

  // First draft for a channel is written when the person opens it.
  useEffect(() => { if (!texts[channel] && !info[channel]) run('draft') }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (!cur) return
    setBusy(true)
    setError('')
    try {
      const res = channel === 'email'
        ? await fetch('/api/inbox/compose', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: cur.target.to, subject: subject || 'Following up', message: text, lead_id: leadId, wrap_with_brand: true, mailbox: 'support' }),
          })
        : await fetch('/api/inbox/reply', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: cur.target.conversationId, channel: 'whatsapp', message: text, clientMsgId: crypto.randomUUID() }),
          })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((d && d.error) || 'The message was not sent — please try again.')
      // The next follow-up moves out by the usual days, so this lead leaves the "follow up today" list.
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      await fetch(`/api/crm/leads/${leadId}/window/fields`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ follow_up_date: addDaysYmd(today, FOLLOW_UP_DAYS_AFTER_CALL) }),
      }).catch(() => undefined)
      setSentMsg(channel === 'email' ? 'Email sent.' : (d && d.queued ? 'Queued on WhatsApp. It goes out through the WhatsApp line.' : 'Sent on WhatsApp.'))
      setConfirm(false)
      onSent()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The message was not sent — please try again.')
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  const blocked = busy || !text.trim() || placeholders.length > 0 || !cur?.target.canSend

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 space-y-3 overflow-auto p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onBack} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50">Back to story</button>
          <span className="font-bold">Follow-up for {leadName}</span>
          <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-700">Draft written by AI from the story</span>
        </div>
        <div className="flex items-center gap-2">
          {(['whatsapp', 'email'] as const).map(k => (
            <button key={k} type="button" onClick={() => { setChannel(k); setSentMsg('') }}
              className={cn('rounded-full border px-4 py-1.5 text-sm font-semibold', channel === k ? 'border-zinc-900 bg-zinc-900 text-white' : 'bg-white hover:bg-zinc-50')}>
              {k === 'whatsapp' ? 'WhatsApp' : 'Email'}
            </button>
          ))}
          {cur?.target.to && <span className="ml-2 text-sm text-zinc-500">To: <span className="font-semibold text-zinc-900">{cur.target.to}</span></span>}
        </div>
        {channel === 'email' && (
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" className="w-full rounded-lg border px-3 py-2 text-sm font-semibold" />
        )}
        <textarea
          value={text}
          onChange={e => { setTexts(t => ({ ...t, [channel]: e.target.value })); setConfirm(false); setSentMsg('') }}
          placeholder={busy && !text ? 'Writing the draft…' : 'The draft appears here. You can write or edit it yourself.'}
          aria-label="Message text"
          className="h-56 w-full resize-none rounded-xl border p-3.5 text-[15px] leading-relaxed"
        />
        {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
        {placeholders.length > 0 && <p className="text-sm font-semibold text-amber-700">Fill in {placeholders.join(', ')} before sending.</p>}
        {cur && !cur.target.canSend && cur.target.reason && <p className="text-sm text-zinc-600">{cur.target.reason}</p>}
        {sentMsg ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{sentMsg} The next follow-up is set for {FOLLOW_UP_DAYS_AFTER_CALL} days from now.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {confirm ? (
              <>
                <button type="button" disabled={blocked} onClick={send} className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                  Confirm: send to {cur?.target.to}
                </button>
                <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold hover:bg-zinc-50">Cancel</button>
              </>
            ) : (
              <button type="button" disabled={blocked} onClick={() => setConfirm(true)} className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
                {channel === 'email' ? 'Send by email' : 'Send on WhatsApp'}
              </button>
            )}
            <button type="button" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => undefined) }} disabled={!text.trim()} className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="text-xs text-zinc-500">Nothing is sent until you press the green button and confirm.</span>
          </div>
        )}

        <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3.5">
          <div className="flex items-center gap-2"><span className="text-[11px] font-bold tracking-wider text-violet-700">ASK THE WORKER</span><span className="text-xs text-zinc-500">It reads the story and rewrites or checks this text. It cannot send.</span></div>
          {log.map((m, i) => (
            <div key={i} className={cn('mt-2 whitespace-pre-line rounded-lg px-3 py-2 text-sm leading-relaxed', m.who === 'You' ? 'bg-zinc-100' : 'bg-violet-100 text-violet-950')}><span className="font-bold">{m.who}: </span>{m.text}</div>
          ))}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" disabled={busy || !text.trim()} onClick={() => run('rewrite', 'Make it shorter. Keep the question and any date.')} className="rounded-full border border-violet-300 bg-white px-3 py-1 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50">Shorter</button>
            <button type="button" disabled={busy || !text.trim()} onClick={() => run('rewrite', 'Make it a little warmer and more friendly. Add no new facts.')} className="rounded-full border border-violet-300 bg-white px-3 py-1 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50">Warmer</button>
            <button type="button" disabled={busy || !text.trim()} onClick={() => run('check')} className="rounded-full border border-violet-300 bg-white px-3 py-1 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50">Check it against the story</button>
          </div>
          <div className="mt-2.5 flex gap-2">
            <input value={instr} onChange={e => setInstr(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && instr.trim() && !busy && text.trim()) run('rewrite', instr.trim()) }}
              placeholder="Tell the worker what is wrong or what to change" aria-label="Tell the worker what to change" className="flex-1 rounded-lg border bg-white px-3 py-2 text-sm" />
            <button type="button" disabled={busy || !instr.trim() || !text.trim()} onClick={() => run('rewrite', instr.trim())} className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50">{busy ? 'Working…' : 'Rewrite'}</button>
          </div>
        </div>
      </div>

      <div className="w-[330px] shrink-0 space-y-4 overflow-auto border-l p-5">
        <div>
          <div className="mb-2 text-[11px] font-bold tracking-wider text-zinc-500">WHAT THE WORKER SAW</div>
          {cur?.basedOn.map((b, i) => <div key={i} className="mb-1.5 rounded-lg bg-zinc-100 px-2.5 py-2 text-sm leading-snug text-zinc-700">{b}</div>)}
          {!cur && <p className="text-sm text-zinc-500">{busy ? 'Reading the story…' : 'Nothing yet.'}</p>}
        </div>
        {cur && (
          <>
            <div>
              <div className="mb-1.5 text-[11px] font-bold tracking-wider text-zinc-500">LANGUAGE</div>
              <p className="text-sm text-zinc-700">Written in {cur.language} because that is the language in the CRM.</p>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-bold tracking-wider text-amber-800">WHAT IT DOES NOT PROMISE</div>
              {cur.notPromised.map((n, i) => <p key={i} className="mb-1 text-sm leading-snug text-zinc-700">{n}</p>)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── transcript reader ────────────────────────────────────────────────────

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="rounded bg-amber-200 px-0.5">{text.slice(i, i + q.length)}</mark><Highlight text={text.slice(i + q.length)} q={q} /></>
}

function TranscriptReader({ leadId, callId, onBack }: { leadId: string; callId: string; onBack: () => void }) {
  const [lines, setLines] = useState<TranscriptLine[] | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`/api/crm/leads/${leadId}/window/transcript?call=${callId}`)
        if (!res.ok) throw new Error(await readError(res, 'Could not load the transcript — please try again.'))
        const d = await res.json()
        if (!live) return
        setLines(d.lines as TranscriptLine[])
        setTitle(d.title ?? 'Call')
      } catch (err) {
        if (live) setError(err instanceof Error && err.message ? err.message : 'Could not load the transcript — please try again.')
      }
    })()
    return () => { live = false }
  }, [leadId, callId])

  const shown = (lines ?? []).filter(l => !q || l.text.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <div className="mb-3 flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold hover:bg-zinc-50">Back to story</button>
        <span className="font-bold">{title}</span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search this call" aria-label="Search this call" className="w-56 rounded-lg border py-1.5 pl-8 pr-3 text-sm" />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && lines === null && <p className="text-sm text-zinc-500">Loading…</p>}
        {lines && lines.length === 0 && <p className="text-sm text-zinc-500">This call has no saved transcript text.</p>}
        {shown.map((l, i) => (
          l.time || l.speaker ? (
            <div key={i} className="grid grid-cols-[56px_140px_1fr] gap-3 rounded-lg px-2 py-1.5 leading-relaxed">
              <span className="text-sm text-zinc-500">{l.time}</span>
              <span className="text-sm font-bold">{l.speaker}</span>
              <span className="text-sm"><Highlight text={l.text} q={q} /></span>
            </div>
          ) : (
            <p key={i} className="whitespace-pre-wrap rounded-lg px-2 py-1.5 text-sm leading-relaxed"><Highlight text={l.text} q={q} /></p>
          )
        ))}
        {lines && lines.length > 0 && shown.length === 0 && <p className="text-sm text-zinc-500">No line matches “{q}”.</p>}
      </div>
    </div>
  )
}
