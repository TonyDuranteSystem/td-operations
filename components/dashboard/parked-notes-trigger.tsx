'use client'

/**
 * Parked notes — the header shelf trigger (2026-09-08).
 *
 * Antonio: a note that's been "parked" lives here, grouped with the others,
 * instead of scattered across whatever page you happen to be on. Same
 * interaction shape as StaffAlertsBell on purpose (compact icon+badge on
 * mobile, full button+dropdown on desktop) — Antonio and Luca already know
 * how that pattern works, no new mental model to learn.
 *
 * Red/unread styling deliberately reuses the EXISTING, unmodified alerts
 * feed (computeNoteAlerts via the shared 'staff-alerts' query key) rather
 * than any Parked-specific logic — a fresh reply on a parked note already
 * produces a note_reply alert today (that computation never checked
 * archived/snoozed/parked state), so this is pure read-side reuse, not a
 * new signal. A parked note does NOT revive back onto the scattered floating
 * layer on reply (see isLiveOrRevivedFor's own comment) — it stays here and
 * turns red in place instead.
 */

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { Pin, X, Loader2 } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { requestOpenNote } from '@/lib/notes/open-note'

interface ParkedNote {
  id: string
  body: string
  color: string
  account_id: string | null
  contact_id: string | null
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}

interface StaffAlertLite {
  kind: string
  note_id?: string
}

async function fetchParked(): Promise<{ notes: ParkedNote[] }> {
  const res = await fetch('/api/crm/staff-notes?scope=parked')
  if (!res.ok) throw new Error('Could not load parked notes')
  return res.json()
}

async function fetchStaffAlerts(): Promise<{ alerts: StaffAlertLite[] }> {
  const res = await fetch('/api/crm/staff-alerts')
  if (!res.ok) throw new Error('Could not load alerts')
  return res.json()
}

function clientNameOf(n: ParkedNote): string | null {
  return n.accounts?.company_name ?? n.contacts?.full_name ?? null
}

export function ParkedNotesTrigger({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const router = useRouter()

  const { data } = useQuery({
    queryKey: ['staff-notes-parked'],
    queryFn: fetchParked,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  const notes = useMemo(() => data?.notes ?? [], [data])

  // Same query key as sticky-notes-layer.tsx / staff-alerts-bell.tsx — one
  // shared cache for "is there something new on this note."
  const { data: alertsData } = useQuery<{ alerts: StaffAlertLite[] }>({
    queryKey: ['staff-alerts'],
    queryFn: fetchStaffAlerts,
    refetchInterval: 60_000,
  })
  const unreadNoteIds = useMemo(() => {
    const ids = new Set<string>()
    for (const a of alertsData?.alerts ?? []) {
      if ((a.kind === 'note_reply' || a.kind === 'note_update') && a.note_id) ids.add(a.note_id)
    }
    return ids
  }, [alertsData])

  const count = notes.length
  const hasUnread = notes.some((n) => unreadNoteIds.has(n.id))

  const unpark = async (noteId: string) => {
    const res = await fetch('/api/crm/staff-notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: noteId, action: 'unpark' }),
    })
    if (!res.ok) return
    qc.invalidateQueries({ queryKey: ['staff-notes-parked'] })
    qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
  }

  const openNote = (noteId: string) => {
    setOpen(false)
    const handled = requestOpenNote({ noteId })
    if (handled) return
    router.push(`/notes?note=${noteId}`)
  }

  if (compact) {
    if (count === 0) return null
    return (
      <>
        <FastTooltip label="Parked notes">
          <button
            onClick={() => setOpen(true)}
            className={`relative p-2 rounded-md hover:bg-zinc-100 ${hasUnread ? 'text-red-600' : 'text-amber-600'}`}
            aria-label={`Parked notes, ${count}${hasUnread ? ', unread' : ''}`}
          >
            <Pin className="h-5 w-5" />
            <span className={`absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${hasUnread ? 'animate-pulse bg-red-600' : 'bg-amber-500'}`}>
              {count > 9 ? '9+' : count}
            </span>
          </button>
        </FastTooltip>
        {open && (
          <div className="lg:hidden fixed inset-0 z-[46] flex flex-col justify-end bg-black/30" onClick={() => setOpen(false)}>
            <div className="max-h-[75vh] overflow-y-auto rounded-t-xl bg-zinc-50 p-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-sm font-semibold text-zinc-700">Parked notes</span>
                <button onClick={() => setOpen(false)} className="p-1 text-zinc-400" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <ParkedList notes={notes} unreadNoteIds={unreadNoteIds} onOpen={openNote} onUnpark={unpark} />
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="relative">
      <FastTooltip label="Notes moved here to keep them out of the way">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors border ${
            count === 0
              ? 'bg-zinc-100 text-zinc-400 border-zinc-200 cursor-default'
              : hasUnread
                ? 'animate-pulse bg-red-600 text-white border-red-600 hover:bg-red-700'
                : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
          }`}
          aria-label={`Parked notes${count ? `, ${count}` : ''}${hasUnread ? ', unread' : ''}`}
        >
          <Pin className="h-3.5 w-3.5" />
          {count > 0 ? `Parked (${count})` : 'Parked'}
        </button>
      </FastTooltip>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-96 max-h-[70vh] overflow-y-auto rounded-lg border bg-white shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold text-zinc-700">Parked notes</span>
            </div>
            <ParkedList notes={notes} unreadNoteIds={unreadNoteIds} onOpen={openNote} onUnpark={unpark} />
          </div>
        </>
      )}
    </div>
  )
}

function ParkedList({ notes, unreadNoteIds, onOpen, onUnpark }: {
  notes: ParkedNote[]
  unreadNoteIds: Set<string>
  onOpen: (id: string) => void
  onUnpark: (id: string) => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  if (notes.length === 0) {
    return <p className="p-6 text-center text-sm text-zinc-400">Nothing parked right now.</p>
  }
  return (
    <div className="divide-y">
      {notes.map((n) => {
        const unread = unreadNoteIds.has(n.id)
        const client = clientNameOf(n)
        return (
          <div key={n.id} className={`p-3 ${unread ? 'bg-red-50' : ''}`}>
            <button onClick={() => onOpen(n.id)} className="block w-full text-left">
              <p className={`text-sm line-clamp-2 ${unread ? 'font-semibold text-red-900' : 'text-zinc-700'}`}>{n.body}</p>
              {client && <p className="mt-0.5 text-xs text-zinc-400 truncate">{client}</p>}
            </button>
            <button
              onClick={async () => { setBusyId(n.id); await onUnpark(n.id); setBusyId(null) }}
              disabled={busyId === n.id}
              className="mt-1.5 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-50"
            >
              {busyId === n.id && <Loader2 className="h-3 w-3 animate-spin" />}
              Send back to screen
            </button>
          </div>
        )
      })}
    </div>
  )
}
