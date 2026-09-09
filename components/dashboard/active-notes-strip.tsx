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
 * Free (x,y) dragging and the old "select several and Move them" action do
 * not survive this move, deliberately — a pill in a header row has a slot,
 * not a screen coordinate, so there is nothing left to drag to. Bulk PARK
 * survives (checkboxes in the dropdown below) because it is still the real
 * lever here: with only a few pills ever visible at once, parking several
 * at a time is how you control what stays on screen. Parking ONE note still
 * also works from inside the note editor itself (its own Park button),
 * unchanged.
 *
 * Reordering DOES survive, in a narrower shape (Antonio, same day, once he'd
 * seen the strip live: "I want to be able to put one on top of each other").
 * A free-position canvas would have undone the whole point of this redesign,
 * so instead a pill can be dragged to a new SLOT within the visible row —
 * the priority order, not a coordinate. The result is a per-device ordering
 * (localStorage, `ORDER_STORAGE_KEY` below) layered on top of the natural
 * fetch order: notes the user has explicitly placed keep that placement,
 * anything never touched falls back to arrival order. Nothing is shared
 * across staff or devices — this is "how I like my own screen arranged,"
 * the same category as the sidebar's own drag-to-reorder nav.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { StickyNote, Check, Loader2, Pin } from 'lucide-react'
import {
  DndContext, closestCenter, useSensor, useSensors, MouseSensor, TouchSensor, KeyboardSensor,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, useSortable, horizontalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { requestOpenNote } from '@/lib/notes/open-note'

interface ActiveNote {
  id: string
  title: string | null
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

/** Per-device pill order, keyed by note id — same storage category as the
 *  sidebar's own nav order (components/dashboard/sidebar.tsx), never synced. */
const ORDER_STORAGE_KEY = 'td-active-notes-order'

/**
 * Layer a saved priority order on top of the notes actually on screen. IDs the
 * user has dragged before keep that relative position; anything not in the
 * saved order (a brand-new note, or a first-time device) falls back to arrival
 * order, appended after. A saved id for a note that's since been parked/
 * archived/deleted is silently skipped — never surfaced as an error, since a
 * stale localStorage entry just means "irrelevant now," not "broken."
 */
function applyStoredOrder(notes: ActiveNote[], order: string[]): ActiveNote[] {
  const remaining = new Map(notes.map((n) => [n.id, n]))
  const ordered: ActiveNote[] = []
  for (const id of order) {
    const n = remaining.get(id)
    if (n) { ordered.push(n); remaining.delete(id) }
  }
  for (const n of notes) {
    if (remaining.has(n.id)) ordered.push(n)
  }
  return ordered
}

export function ActiveNotesStrip() {
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  const qc = useQueryClient()
  const router = useRouter()

  // Loaded once, client-side only — SSR/first paint renders in natural fetch
  // order, same as before this existed, until this effect hydrates it.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ORDER_STORAGE_KEY)
      if (saved) setOrder(JSON.parse(saved))
    } catch { /* per-device convenience only — a bad value just means no custom order yet */ }
  }, [])

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

  const orderedNotes = useMemo(() => applyStoredOrder(notes, order), [notes, order])
  const visible = orderedNotes.slice(0, VISIBLE_COUNT)
  const overflowCount = Math.max(0, orderedNotes.length - VISIBLE_COUNT)

  // Distance/delay thresholds so a plain tap-to-open still works — only a real
  // drag (moved past the threshold) engages reordering. Same sensor shape as
  // the sidebar's own nav reorder.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const full = orderedNotes.map((n) => n.id)
    const oldIndex = full.indexOf(active.id as string)
    const newIndex = full.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(full, oldIndex, newIndex)
    setOrder(next)
    try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next)) } catch { /* per-device convenience only */ }
  }

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
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visible.map((n) => n.id)} strategy={horizontalListSortingStrategy}>
          {visible.map((n) => (
            <ActiveNotePill key={n.id} note={n} unread={unreadNoteIds.has(n.id)} onOpen={openNote} />
          ))}
        </SortableContext>
      </DndContext>
      {overflowCount > 0 && (
        <div className="relative">
          <FastTooltip label="More notes on your screen">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
              aria-label={`${overflowCount} more note${overflowCount > 1 ? 's' : ''}`}
            >
              +{overflowCount}
            </button>
          </FastTooltip>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute right-0 top-full mt-2 z-50 w-96 max-h-[70vh] overflow-y-auto rounded-lg border bg-white shadow-lg">
                <ActiveList notes={orderedNotes} unreadNoteIds={unreadNoteIds} onOpen={openNote} onPark={park} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One draggable pill. The button itself is both the click target (open the
 * note) AND the drag handle — there's no room in a pill this small for a
 * separate grip icon, and dnd-kit's activation distance already tells a tap
 * from a drag apart (a plain click never crosses the threshold, so onClick
 * still fires normally; a real drag suppresses the trailing click on its
 * own). Always draggable — unlike the sidebar's nav reorder, there's no
 * separate "edit mode" here, since a 3-pill row has nothing else a stray
 * drag could disturb.
 */
function ActiveNotePill({ note: n, unread, onOpen }: {
  note: ActiveNote
  unread: boolean
  onOpen: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: n.id })
  // Full body — what hover already reveals (Antonio, 2026-09-08: "we already have
  // the description when we pass the pointer on it"), unaffected by title.
  const preview = n.body.replace(/\s+/g, ' ').trim().slice(0, 80)
  // The pill's own visible text: the deliberate short title when the author wrote
  // one, else the same body-snippet fallback as before.
  const label = (n.title?.trim() || preview).slice(0, 40)

  return (
    <FastTooltip label={unread ? `New: ${preview}` : preview} align="left">
      <button
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        onClick={() => onOpen(n.id)}
        style={{ transform: CSS.Transform.toString(transform), transition, touchAction: 'none' }}
        className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors select-none ${
          isDragging ? 'z-10 opacity-60 shadow-md' : ''
        } ${
          unread
            ? 'animate-pulse border-red-700 bg-red-600 text-white hover:bg-red-700'
            : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
        }`}
        aria-label={`${unread ? 'New note' : 'Note'}: ${label}`}
      >
        <StickyNote className="h-3 w-3 shrink-0" />
        <span className="max-w-[5rem] truncate">{label}</span>
      </button>
    </FastTooltip>
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
                {n.title && (
                  <p className={`text-sm font-semibold ${unread ? 'text-red-900' : 'text-zinc-800'}`}>{n.title}</p>
                )}
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
