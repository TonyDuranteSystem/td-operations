'use client'

/**
 * Calendar view for the Notes tab. Each note sits on the day it COMES BACK.
 *
 * Desktop: a month grid (Mon-first), month + year with arrows, Today, today's cell highlighted,
 * click a day to see its notes underneath.
 * Mobile (<lg): the grid is unreadable at ~380px (7 columns ≈ 50px cells), so the default is a
 * plain upcoming LIST — the same information, one thumb-scroll. Same rule the floating layer
 * already follows (no dragging on a phone).
 */

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Building2, Lock, Share2, Users, AlertCircle } from 'lucide-react'
import {
  buildMonthGrid,
  groupNotesByDay,
  shiftMonth,
  monthLabel,
  localDayKey,
  isOverdue,
  type CalendarNoteLike,
} from '@/lib/notes/note-calendar'

export interface CalendarNote extends CalendarNoteLike {
  body: string
  color: string
  visibility: 'private' | 'shared' | 'team'
  shared_with_name: string | null
  author_name: string | null
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}

const DOT: Record<string, string> = {
  yellow: 'bg-amber-400',
  pink: 'bg-pink-400',
  blue: 'bg-sky-400',
  green: 'bg-emerald-400',
  purple: 'bg-violet-400',
}
const CARD: Record<string, string> = {
  yellow: 'bg-amber-100 border-amber-300',
  pink: 'bg-pink-100 border-pink-300',
  blue: 'bg-sky-100 border-sky-300',
  green: 'bg-emerald-100 border-emerald-300',
  purple: 'bg-violet-100 border-violet-300',
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function clientOf(n: CalendarNote): string | null {
  return n.accounts?.company_name || n.contacts?.full_name || null
}
function timeOf(n: CalendarNote): string {
  if (!n.snoozed_until) return ''
  return new Date(n.snoozed_until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function NotesCalendar({ notes }: { notes: CalendarNote[] }) {
  const today = useMemo(() => new Date(), [])
  const now = today
  const [cursor, setCursor] = useState(() => ({ year: today.getFullYear(), monthIndex: today.getMonth() }))
  const [selected, setSelected] = useState<string | null>(localDayKey(today))

  const { byDay, undated } = useMemo(() => groupNotesByDay(notes), [notes])
  const cells = useMemo(
    () => buildMonthGrid(cursor.year, cursor.monthIndex, today),
    [cursor, today],
  )

  const goToday = () => {
    setCursor({ year: today.getFullYear(), monthIndex: today.getMonth() })
    setSelected(localDayKey(today))
  }

  const selectedNotes = selected ? byDay.get(selected) ?? [] : []

  // Upcoming list (mobile default): every dated note from today onwards, soonest first.
  const upcoming = useMemo(() => {
    const todayKey = localDayKey(today)
    return [...notes]
      .filter((n) => !n.archived_at && n.snoozed_until)
      .filter((n) => localDayKey(new Date(n.snoozed_until as string)) >= todayKey)
      .sort((a, b) => new Date(a.snoozed_until as string).getTime() - new Date(b.snoozed_until as string).getTime())
  }, [notes, today])

  const overdue = useMemo(() => notes.filter((n) => isOverdue(n, now)), [notes, now])

  return (
    <div>
      {/* ── header: month, year, arrows, today ── */}
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => setCursor((c) => shiftMonth(c.year, c.monthIndex, -1))}
          className="rounded border border-zinc-300 p-1.5 hover:bg-zinc-100"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[10rem] text-center text-sm font-semibold capitalize">
          {monthLabel(cursor.year, cursor.monthIndex)}
        </span>
        <button
          onClick={() => setCursor((c) => shiftMonth(c.year, c.monthIndex, 1))}
          className="rounded border border-zinc-300 p-1.5 hover:bg-zinc-100"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button onClick={goToday} className="ml-1 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100">
          Today
        </button>
        {overdue.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-red-700">
            <AlertCircle className="h-3.5 w-3.5" />{overdue.length} overdue
          </span>
        )}
      </div>

      {/* ── DESKTOP: month grid ── */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-t border border-zinc-200 bg-zinc-200 text-center text-xs font-medium text-zinc-600">
          {WEEKDAYS.map((d) => <div key={d} className="bg-zinc-50 py-1.5">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-b border border-t-0 border-zinc-200 bg-zinc-200">
          {cells.map((c) => {
            const dayNotes = byDay.get(c.key) ?? []
            const isSel = selected === c.key
            return (
              <button
                key={c.key}
                onClick={() => setSelected(c.key)}
                className={[
                  'min-h-[5.5rem] bg-white p-1.5 text-left align-top transition',
                  c.inMonth ? '' : 'bg-zinc-50 text-zinc-400',
                  isSel ? 'ring-2 ring-inset ring-amber-400' : 'hover:bg-amber-50',
                ].join(' ')}
              >
                <span className={[
                  'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs',
                  c.isToday ? 'bg-amber-400 font-bold text-amber-950' : 'font-medium',
                ].join(' ')}>
                  {c.date.getDate()}
                </span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {dayNotes.slice(0, 3).map((n) => (
                    <span key={n.id} className="flex items-center gap-1 truncate text-[11px] leading-tight">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[n.color] || DOT.yellow}`} />
                      <span className="truncate">{n.body}</span>
                    </span>
                  ))}
                  {dayNotes.length > 3 && (
                    <span className="text-[11px] text-zinc-500">+{dayNotes.length - 3} more</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* day detail */}
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-zinc-700">
            {selected
              ? new Date(selected + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
              : 'Pick a day'}
            <span className="ml-1 text-zinc-400">({selectedNotes.length})</span>
          </h3>
          {selectedNotes.length === 0
            ? <p className="text-sm text-zinc-400">Nothing coming back on this day.</p>
            : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {selectedNotes.map((n) => <NoteMini key={n.id} n={n} now={now} />)}
              </div>}
        </div>
      </div>

      {/* ── MOBILE: upcoming list (a 7-column grid is unreadable at ~380px) ── */}
      <div className="lg:hidden">
        {upcoming.length === 0
          ? <p className="text-sm text-zinc-400">Nothing scheduled to come back.</p>
          : <div className="flex flex-col gap-2">
              {upcoming.map((n) => (
                <div key={n.id}>
                  <p className="mb-1 text-xs font-medium text-zinc-500">
                    {new Date(n.snoozed_until as string).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                    {' · '}{timeOf(n)}
                  </p>
                  <NoteMini n={n} now={now} />
                </div>
              ))}
            </div>}
      </div>

      {undated.length > 0 && (
        <p className="mt-4 text-xs text-zinc-500">
          {undated.length} note{undated.length === 1 ? '' : 's'} with no date — they&apos;re on your screen now, see the List view.
        </p>
      )}
    </div>
  )
}

function NoteMini({ n, now }: { n: CalendarNote; now: Date }) {
  const client = clientOf(n)
  const late = isOverdue(n, now)
  return (
    <div className={`rounded border p-2 ${CARD[n.color] || CARD.yellow} ${late ? 'ring-1 ring-red-400' : ''}`}>
      <p className="whitespace-pre-wrap break-words text-sm leading-snug">{n.body}</p>
      {client && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium opacity-80">
          <Building2 className="h-3 w-3 shrink-0" /><span className="truncate">{client}</span>
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs opacity-70">
        <span>{timeOf(n)}</span>
        {late && <span className="font-medium text-red-700">overdue</span>}
        {n.visibility === 'private' && <span className="flex items-center gap-1"><Lock className="h-3 w-3" />Only you</span>}
        {n.visibility === 'shared' && <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{n.shared_with_name}</span>}
        {n.visibility === 'team' && <span className="flex items-center gap-1"><Users className="h-3 w-3" />Team</span>}
      </div>
    </div>
  )
}
