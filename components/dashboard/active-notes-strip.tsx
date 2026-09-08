'use client'

/**
 * Active notes — compact header strip, next to the Parked trigger (2026-09-08).
 *
 * Replaces the old floating/draggable canvas of scattered note pills. Antonio
 * sent a screenshot of note pills wanted inline in the header row itself,
 * and asked for the UX Designer specialist's take on the actual shape given
 * the header is a fixed, already-crowded strip and the number of active
 * notes is unbounded (his own screenshot already showed 7 pills overflowing
 * a normal window). Recommendation, adopted as-is: show a few pills inline,
 * cap it, and put the rest behind a "+N" trigger reusing ParkedNotesTrigger's
 * own dropdown shape verbatim — one mental model across both header note
 * controls, not two to learn.
 *
 * Free dragging and the old "select several and Move them" action do not
 * survive this move, deliberately — a pill in a header row has a slot, not a
 * screen coordinate, so there is nothing left to drag to, and reassigning a
 * "fresh spot" has no meaning once there is no canvas. Bulk PARK survives
 * (checkboxes in the dropdown below) because it is still the real lever here:
 * with only a few pills ever visible at once, parking several at a time is
 * how you control what stays on screen. Parking ONE note still also works
 * from inside the note editor itself (its own Park button), unchanged.
 */

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { StickyNote, Check, Loader2, Pin } from 'lucide-react'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { requestOpenNote } from '@/lib/notes/open-note'

interface ActiveNote {
  id: string
  body: string
}

/** Matches sticky-notes-layer.tsx's own StaffAlertLite shape exactly — reply_id
 *  is required to dismiss a reply-specific alert, not just a note-level one. */
interface StaffAlertLite { kind: string; note_id: string; reply_id: string | null }

async function fetchActive(): Promise<{ notes: ActiveNote[] }> {
  const res = await fetch('/api/crm/staff-notes?scope=active')
  if (!res.ok) return { notes: [] }
  return res.json().catch(() => ({ notes: [] }))
}

async function fetchStaffAlerts(): Promise<{ alerts: StaffAlertLite[] }> {
  const res = await fetch('/api/crm/staff-alerts')
  if (!res.ok) return { alerts: [] }
  return res.json().catch(() => ({ alerts: [] }))
}

/** How many pills show inline before the rest fold behind "+N" — the UX
 *  brief's own suggested range (2-4), live-verified against this header's
 *  actual free space rather than picked blind. */
const VISIBLE_COUNT = 3

export function ActiveNotesStrip() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const router = useRouter()

  // Same query key sticky-notes-layer.tsx already fetches under — a shared
  // cache hit, not a second network round trip (same pattern ParkedNotesTrigger
  // already uses for the 'staff-notes-parked' key).
  const { data } = useQuery({
    queryKey: ['staff-notes-active'],
    queryFn: fetchActive,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  const notes = useMemo(() => data?.notes ?? [], [data])

  // Same query key as staff-alerts-bell.tsx / parked-notes-trigger.tsx — one
  // shared cache for "have I seen this."
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

  const visible = notes.slice(0, VISIBLE_COUNT)
  const overflowCount = Math.max(0, notes.length - VISIBLE_COUNT)

  /** Mirrors sticky-notes-layer.tsx's own dismissNoteAlerts — a separate
   *  component tree now, so it keeps its own copy rather than reaching across
   *  into that file's local state (same reasoning ParkedNotesTrigger already
   *  applies to its own unpark function). */
  const dismissAlerts = async (noteId: string) => {
    const mine = (alertsData?.alerts ?? []).filter((a) => a.note_id === noteId)
    if (mine.length === 0) return
    qc.setQueryData<{ alerts: StaffAlertLite[] }>(['staff-alerts'], (old) =>
      old ? { alerts: old.alerts.filter((a) => a.note_id !== noteId) } : old,
    )
    await Promise.all(mine.map((a) =>
      fetch('/api/crm/staff-alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: a.kind, note_id: a.note_id, reply_id: a.reply_id }),
      }).catch(() => null),
    ))
    qc.invalidateQueries({ queryKey: ['staff-alerts'] })
  }

  const openNote = (noteId: string) => {
    setOpen(false)
    if (unreadNoteIds.has(noteId)) dismissAlerts(noteId)
    const handled = requestOpenNote({ noteId })
    if (handled) return
    router.push(`/notes?note=${noteId}`)
  }

  const park = async (noteId: string) => {
    const res = await fetch('/api/crm/staff-notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: noteId, action: 'park' }),
    })
    if (!res.ok) return
    qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
    qc.invalidateQueries({ queryKey: ['staff-notes-parked'] })
  }

  if (notes.length === 0) return null

  return (
    <div className="flex items-center gap-1.5">
      {visible.map((n) => {
        const unread = unreadNoteIds.has(n.id)
        const preview = n.body.replace(/\s+/g, ' ').trim().slice(0, 80)
        return (
          <FastTooltip key={n.id} label={unread ? `New: ${preview}` : preview} align="left">
            <button
              onClick={() => openNote(n.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                unread
                  ? 'animate-pulse border-red-700 bg-red-600 text-white hover:bg-red-700'
                  : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
              }`}
              aria-label={`${unread ? 'New note' : 'Note'}: ${preview}`}
            >
              <StickyNote className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-[7rem] truncate">{preview.slice(0, 40)}</span>
            </button>
          </FastTooltip>
        )
      })}
      {overflowCount > 0 && (
        <div className="relative">
          <FastTooltip label="More notes on your screen">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              aria-label={`${overflowCount} more note${overflowCount > 1 ? 's' : ''}`}
            >
              +{overflowCount}
            </button>
          </FastTooltip>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute right-0 top-full mt-2 z-50 w-96 max-h-[70vh] overflow-y-auto rounded-lg border bg-white shadow-lg">
                <ActiveList notes={notes} unreadNoteIds={unreadNoteIds} onOpen={openNote} onPark={park} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The full list, shown inside the "+N" dropdown — every active note, not
 *  just the overflow, so there is one authoritative place to see and act on
 *  all of them (the inline pills above are a quick-glance/quick-open
 *  convenience for the newest few, not a second source of truth). */
function ActiveList({ notes, unreadNoteIds, onOpen, onPark }: {
  notes: ActiveNote[]
  unreadNoteIds: Set<string>
  onOpen: (id: string) => void
  onPark: (id: string) => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bulkParking, setBulkParking] = useState(false)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const parkSelected = async () => {
    setBulkParking(true)
    try {
      await Promise.all(Array.from(selected).map((id) => onPark(id)))
      setSelected(new Set())
    } finally {
      setBulkParking(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold text-zinc-700">On your screen ({notes.length})</span>
        {selected.size > 0 && (
          <button
            onClick={parkSelected}
            disabled={bulkParking}
            className="flex items-center gap-1 rounded-full bg-amber-400 px-2.5 py-1 text-xs font-medium text-amber-950 disabled:opacity-50"
          >
            {bulkParking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pin className="h-3 w-3" />}
            Park {selected.size}
          </button>
        )}
      </div>
      <div className="divide-y">
        {notes.map((n) => {
          const unread = unreadNoteIds.has(n.id)
          return (
            <div key={n.id} className={`flex items-start gap-2 p-3 ${unread ? 'bg-red-50' : ''}`}>
              <button
                onClick={() => toggle(n.id)}
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  selected.has(n.id) ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300'
                }`}
                aria-label={selected.has(n.id) ? 'Deselect this note' : 'Select this note'}
              >
                {selected.has(n.id) && <Check className="h-3 w-3" />}
              </button>
              <button onClick={() => onOpen(n.id)} className="block flex-1 text-left">
                <p className={`text-sm line-clamp-2 ${unread ? 'font-semibold text-red-900' : 'text-zinc-700'}`}>{n.body}</p>
              </button>
              <button
                onClick={async () => { setBusyId(n.id); await onPark(n.id); setBusyId(null) }}
                disabled={busyId === n.id}
                className="mt-0.5 shrink-0 text-xs text-zinc-500 hover:text-zinc-700 disabled:opacity-50"
              >
                {busyId === n.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Park'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
