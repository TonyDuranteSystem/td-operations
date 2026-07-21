'use client'

/**
 * Notes page body — every note visible to me, grouped by state.
 * Reuses the SAME visibility rule as the floating layer (the server decides; this only groups).
 */

import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Lock, Share2, Users, Building2, Clock, RotateCcw, Check } from 'lucide-react'
import { noteClientName } from '@/components/dashboard/sticky-notes-layer'

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

async function fetchAll(): Promise<{ notes: Note[] }> {
  const res = await fetch(`${API}?scope=all`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load your notes.')
  }
  return res.json()
}

function whenText(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
}

export function NotesBoard() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['staff-notes-all'],
    queryFn: fetchAll,
    staleTime: 15_000,
  })

  const notes = useMemo(() => data?.notes ?? [], [data])
  const now = Date.now()

  const { active, snoozed, done } = useMemo(() => {
    const a: Note[] = [], s: Note[] = [], d: Note[] = []
    for (const n of notes) {
      if (n.archived_at) d.push(n)
      else if (n.snoozed_until && new Date(n.snoozed_until).getTime() > now) s.push(n)
      else a.push(n)
    }
    s.sort((x, y) => new Date(x.snoozed_until!).getTime() - new Date(y.snoozed_until!).getTime())
    return { active: a, snoozed: s, done: d }
  }, [notes, now])

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

  return (
    <div className="flex flex-col gap-6">
      <Section title="On your screen" count={active.length} empty="Nothing on screen right now.">
        {active.map((n) => <Card key={n.id} n={n} onAct={act} showDone />)}
      </Section>

      <Section title="Snoozed" count={snoozed.length} empty="Nothing snoozed.">
        {snoozed.map((n) => (
          <Card key={n.id} n={n} onAct={act} showUnsnooze
            footer={<span className="flex items-center gap-1 text-xs opacity-70"><Clock className="h-3 w-3" />Back {whenText(n.snoozed_until!)}</span>} />
        ))}
      </Section>

      <Section title="Done" count={done.length} empty="Nothing cleared yet.">
        {done.map((n) => <Card key={n.id} n={n} onAct={act} showRestore />)}
      </Section>
    </div>
  )
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

function Card({ n, onAct, showDone, showUnsnooze, showRestore, footer }: {
  n: Note
  onAct: (id: string, payload: Record<string, unknown>) => void
  showDone?: boolean
  showUnsnooze?: boolean
  showRestore?: boolean
  footer?: React.ReactNode
}) {
  const client = noteClientName(n as never)
  return (
    <div className={`rounded-md border p-3 ${COLORS[n.color] || COLORS.yellow}`}>
      <p className="whitespace-pre-wrap break-words text-sm leading-snug">{n.body}</p>

      {client && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium opacity-80">
          <Building2 className="h-3 w-3 shrink-0" /><span className="truncate">{client}</span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs opacity-70">
        {n.visibility === 'private' && <span className="flex items-center gap-1"><Lock className="h-3 w-3" />Only you</span>}
        {n.visibility === 'shared' && <span className="flex items-center gap-1"><Share2 className="h-3 w-3" />{n.shared_with_name}</span>}
        {n.visibility === 'team' && <span className="flex items-center gap-1"><Users className="h-3 w-3" />Team</span>}
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
