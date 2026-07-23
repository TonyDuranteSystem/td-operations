'use client'

/**
 * Notes page body — every note visible to me, grouped by state.
 * Reuses the SAME visibility rule as the floating layer (the server decides; this only groups).
 */

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Lock, Share2, Users, Building2, Clock, RotateCcw, Check, List, CalendarDays } from 'lucide-react'
import { noteClientName } from '@/components/dashboard/sticky-notes-layer'
import { NotesCalendar } from '@/components/dashboard/notes-calendar'
import { NoteEditor, type EditableNote, type Member } from '@/components/dashboard/note-editor'
import { isArchivedFor, isSnoozedFor, otherPersonState, otherViewersOf } from '@/lib/notes/staff-notes'

interface Note {
  id: string
  body: string
  color: string
  author_user_id: string | null
  author_name: string | null
  visibility: 'private' | 'shared' | 'team'
  shared_with_user_id: string | null
  shared_with_name: string | null
  account_id: string | null
  contact_id: string | null
  origin_url: string | null
  snoozed_until: string | null
  archived_at: string | null
  /** One row per person who has marked this done / snoozed it. */
  staff_note_state?: Array<{ user_id: string; archived_at: string | null; snoozed_until: string | null }> | null
  created_at: string
  updated_at: string
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}

const API = '/api/crm/staff-notes'
const COLORS: Record<string, string> = {
  yellow: 'bg-amber-100 border-amber-300',
  pink: 'bg-pink-100 border-pink-300',
  blue: 'bg-sky-100 border-sky-300',
  green: 'bg-emerald-100 border-emerald-300',
  purple: 'bg-violet-100 border-violet-300',
}

async function fetchAll(): Promise<{ notes: Note[]; members?: Member[]; me?: { id: string; name: string } }> {
  const res = await fetch(`${API}?scope=all`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load your notes.')
  }
  return res.json()
}

/** When THIS person's snooze ends (null = they have not snoozed it themselves). */
function myWake(n: Note, me: string | null): string | null {
  if (!me) return null
  return (n.staff_note_state ?? []).find((r) => r.user_id === me)?.snoozed_until ?? null
}

function whenText(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
}

function ViewSwitch({ view, setView }: { view: 'list' | 'calendar'; setView: (v: 'list' | 'calendar') => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-zinc-300 text-sm">
      <button
        onClick={() => setView('list')}
        className={`flex items-center gap-1.5 px-3 py-1.5 ${view === 'list' ? 'bg-zinc-900 text-white' : 'bg-white hover:bg-zinc-50'}`}
      >
        <List className="h-4 w-4" />List
      </button>
      <button
        onClick={() => setView('calendar')}
        className={`flex items-center gap-1.5 border-l border-zinc-300 px-3 py-1.5 ${view === 'calendar' ? 'bg-zinc-900 text-white' : 'bg-white hover:bg-zinc-50'}`}
      >
        <CalendarDays className="h-4 w-4" />Calendar
      </button>
    </div>
  )
}

export function NotesBoard() {
  const qc = useQueryClient()
  const [view, setView] = useState<'list' | 'calendar'>('list')
  const [editing, setEditing] = useState<Note | null>(null)
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['staff-notes-all'],
    queryFn: fetchAll,
    staleTime: 15_000,
  })

  const notes = useMemo(() => data?.notes ?? [], [data])
  const members = useMemo(() => data?.members ?? [], [data])
  const me: string | null = data?.me?.id ?? null
  const now = Date.now()

  /** Refresh BOTH note feeds — the tab and the floating layer must never disagree. */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['staff-notes-all'] })
    qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
  }

  // Grouped by MY state, not the note's. Done and Snooze belong to the person
  // who pressed them — Antonio clearing a shared note leaves Luca's copy alone.
  const { active, snoozed, done } = useMemo(() => {
    const a: Note[] = [], s: Note[] = [], d: Note[] = []
    const nowDate = new Date(now)
    for (const n of notes) {
      if (!me) { a.push(n); continue }
      if (isArchivedFor(n, me)) d.push(n)
      else if (isSnoozedFor(n, me, nowDate)) s.push(n)
      else a.push(n)
    }
    const wake = (n: Note) => {
      const mine = (n.staff_note_state ?? []).find((r) => r.user_id === me)
      return new Date(mine?.snoozed_until ?? n.snoozed_until ?? 0).getTime()
    }
    s.sort((x, y) => wake(x) - wake(y))
    return { active: a, snoozed: s, done: d }
  }, [notes, now, me])

  const act = async (id: string, payload: Record<string, unknown>) => {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...payload }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d.error || "That didn't work — try again.")
      return
    }
    qc.invalidateQueries({ queryKey: ['staff-notes-all'] })
    qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
  }

  if (isLoading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading your notes…</div>
  }
  if (isError) {
    return <p className="py-10 text-sm text-red-700">{error instanceof Error ? error.message : 'Could not load your notes.'}</p>
  }

  if (view === 'calendar') {
    return (
      <div>
        <ViewSwitch view={view} setView={setView} />
        {/* The calendar only declares the fields it renders, but it is handed the FULL note
            objects from the feed — so the value coming back is a complete Note. */}
        <NotesCalendar notes={notes} onOpen={(n) => setEditing(n as unknown as Note)} />
        {editing && (
          <NoteEditor
            note={editing as unknown as EditableNote}
            members={members}
            onClose={() => setEditing(null)}
            onChanged={refresh}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <ViewSwitch view={view} setView={setView} />

      <Section title="On your screen" count={active.length} empty="Nothing on screen right now.">
        {active.map((n) => <Card key={n.id} n={n} onAct={act} showDone onOpen={setEditing} me={me} members={members} />)}
      </Section>

      <Section title="Snoozed" count={snoozed.length} empty="Nothing snoozed.">
        {snoozed.map((n) => (
          <Card key={n.id} n={n} onAct={act} showUnsnooze onOpen={setEditing} me={me} members={members}
            footer={<span className="flex items-center gap-1 text-xs opacity-70"><Clock className="h-3 w-3" />Back {whenText(myWake(n, me) ?? n.snoozed_until!)}</span>} />
        ))}
      </Section>

      <Section title="Done" count={done.length} empty="Nothing cleared yet.">
        {done.map((n) => <Card key={n.id} n={n} onAct={act} showRestore onOpen={setEditing} me={me} members={members} />)}
      </Section>

      {editing && (
        <NoteEditor
          note={editing as unknown as EditableNote}
          members={members}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

/**
 * Where the OTHER person stands on a shared note — Antonio's ask, 2026-07-23:
 * "I will check in notes in the tab for the notes status."
 *
 * Now that Done and Snooze are per-person, a shared note vanishing from your
 * screen no longer tells you Luca dealt with it. This says so explicitly.
 * A private note has no other viewers, so it renders nothing.
 *
 * Team notes are summarised as a count rather than a list of names — with a
 * handful of staff a list is noise, and it grows badly.
 */
function OtherStatus({ n, me, members }: { n: Note; me?: string | null; members?: Member[] }) {
  if (!me) return null
  const staffIds = (members ?? []).map((m) => m.id)
  // `members` excludes the viewer, so add them back before working out who else
  // a team note reaches.
  const others = otherViewersOf(n, me, Array.from(new Set([...staffIds, me])))
  if (others.length === 0) return null

  const now = new Date()
  const nameOf = (id: string) => (members ?? []).find((m) => m.id === id)?.name ?? 'Teammate'
  const label = (st: ReturnType<typeof otherPersonState>) =>
    st === 'done' ? 'done' : st === 'snoozed' ? 'snoozed' : 'still open'

  if (others.length === 1) {
    const st = otherPersonState(n, others[0], now)
    return (
      <span className={`flex items-center gap-1 ${st === 'done' ? 'text-emerald-700' : ''}`}>
        · {nameOf(others[0])}: {label(st)}
      </span>
    )
  }
  const doneCount = others.filter((id) => otherPersonState(n, id, now) === 'done').length
  return <span className="flex items-center gap-1">· {doneCount} of {others.length} done</span>
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-zinc-700">{title} <span className="text-zinc-400">({count})</span></h2>
      {count === 0
        ? <p className="text-sm text-zinc-400">{empty}</p>
        : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>}
    </section>
  )
}

function Card({ n, onAct, showDone, showUnsnooze, showRestore, footer, onOpen, me, members }: {
  n: Note
  onAct: (id: string, payload: Record<string, unknown>) => void
  showDone?: boolean
  showUnsnooze?: boolean
  showRestore?: boolean
  footer?: React.ReactNode
  onOpen?: (n: Note) => void
  me?: string | null
  members?: Member[]
}) {
  const client = noteClientName(n as never)
  return (
    <div className={`rounded-md border p-3 ${COLORS[n.color] || COLORS.yellow}`}>
      <p
        onClick={() => onOpen?.(n)}
        title="Open"
        className="cursor-pointer whitespace-pre-wrap break-words text-sm leading-snug hover:underline"
      >{n.body}</p>

      {client && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium opacity-80">
          <Building2 className="h-3 w-3 shrink-0" /><span className="truncate">{client}</span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-70">
        {n.visibility === 'private' && <span className="flex items-center gap-1"><Lock className="h-3 w-3" />Only you</span>}
        {n.visibility === 'shared' && <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{n.shared_with_name}</span>}
        {n.visibility === 'team' && <span className="flex items-center gap-1"><Users className="h-3 w-3" />Team</span>}
        <OtherStatus n={n} me={me} members={members} />
        {n.author_name && <span>· by {n.author_name}</span>}
        {footer}
      </div>

      <div className="mt-2 flex gap-1">
        {showDone && (
          <button onClick={() => onAct(n.id, { action: 'archive' })}
            className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs"><Check className="h-3 w-3" />Done</button>
        )}
        {showUnsnooze && (
          <button onClick={() => onAct(n.id, { action: 'unsnooze' })}
            className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs"><RotateCcw className="h-3 w-3" />Bring back now</button>
        )}
        {showRestore && (
          <button onClick={() => onAct(n.id, { action: 'unarchive' })}
            className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs"><RotateCcw className="h-3 w-3" />Put back</button>
        )}
      </div>
    </div>
  )
}
