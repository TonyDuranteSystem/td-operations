'use client'

/**
 * Floating staff sticky notes — the always-on-screen layer.
 *
 * Mounted once in the dashboard layout, OUTSIDE <main> (so it never fights pull-to-refresh).
 * Desktop: draggable notes at per-device fractional positions. Mobile (<lg): a bottom-LEFT pill
 * (the toast layer owns bottom-right) that opens a bottom sheet — no dragging at 380px.
 * z-index 45: above the mobile top bar (40), below every modal/drawer (50+), so a note never
 * traps a dialog's buttons. Wrapped in its own error boundary — a throw here must not take the CRM down.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StickyNote, Plus, Clock, Share2, Check, Loader2, Users, Lock, Building2, MessageSquare, ExternalLink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { readPositions, writePosition, prunePositions, cascadePos, clampFrac } from '@/lib/notes/note-position'
import { NoteEditor } from '@/components/dashboard/note-editor'
// AccountCombobox no longer needed here — the create UI is the full NoteEditor now.
import { useDraggableFab } from '@/components/ui/use-draggable-fab'
import { FAB_KEYS } from '@/lib/ui/draggable-fab'
import { requestOpenTeamChat } from '@/lib/team/open-team-chat'
import { safeOriginPath, describeOrigin } from '@/lib/notes/note-origin'

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
  // resolved at read time from the foreign keys — never stored, so a renamed company is never stale
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}

/** The client a note is about, as a display string (or null if it isn't about anyone). */
export function noteClientName(n: Note): string | null {
  return n.accounts?.company_name || n.contacts?.full_name || null
}
interface Member { id: string; name: string }
interface ActiveResponse { notes: Note[]; me: { id: string; name: string }; members: Member[] }

const API = '/api/crm/staff-notes'
const COLORS: Record<string, string> = {
  yellow: 'bg-amber-100 border-amber-300 text-amber-950',
  pink: 'bg-pink-100 border-pink-300 text-pink-950',
  blue: 'bg-sky-100 border-sky-300 text-sky-950',
  green: 'bg-emerald-100 border-emerald-300 text-emerald-950',
  purple: 'bg-violet-100 border-violet-300 text-violet-950',
}

async function fetchActive(): Promise<ActiveResponse> {
  const res = await fetch(`${API}?scope=active`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load your notes.')
  }
  return res.json()
}

/** Derive the account/contact this page is about, from the URL, so a note captures its subject. */
function subjectFromPath(): { account_id?: string; contact_id?: string } {
  if (typeof window === 'undefined') return {}
  const m = window.location.pathname.match(/\/(accounts|contacts)\/([0-9a-f-]{36})/i)
  if (!m) return {}
  return m[1].toLowerCase() === 'accounts' ? { account_id: m[2] } : { contact_id: m[2] }
}

/** The same page subject, shaped for the editor's create mode. */
function creationSubjectDefaults(): { accountId?: string; contactId?: string } {
  const s = subjectFromPath()
  return { accountId: s.account_id, contactId: s.contact_id }
}

class Boundary extends React.Component<{ children: React.ReactNode }, { dead: boolean }> {
  state = { dead: false }
  static getDerivedStateFromError() { return { dead: true } }
  componentDidCatch(e: unknown) { console.warn('[sticky-notes] layer error (contained):', e) }
  render() { return this.state.dead ? null : this.props.children }
}

export default function StickyNotesLayer() {
  return (
    <Boundary>
      <StickyNotesInner />
    </Boundary>
  )
}

function StickyNotesInner() {
  const qc = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: ['staff-notes-active'],
    queryFn: fetchActive,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  const notes = useMemo(() => data?.notes ?? [], [data])
  const members = useMemo(() => data?.members ?? [], [data])
  const meId = data?.me?.id ?? null

  const [composing, setComposing] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)
  // Both entry points are draggable (Antonio, 2026-07-23) — separate keys so the
  // desktop + button and the mobile pill remember their own spots per device.
  const deskFab = useDraggableFab(`${FAB_KEYS.notes}-desktop`)
  const mobileFab = useDraggableFab(FAB_KEYS.notes)

  // Re-sync when the tab wakes (sleep/PWA freeze) or the network returns — realtime replays nothing.
  useEffect(() => {
    const resync = () => qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
    const onVis = () => { if (document.visibilityState === 'visible') resync() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', resync)
    // wake the earliest snooze so a note reappears without a refresh (clamped so a far-future
    // snooze can't overflow setTimeout and fire in a tight loop)
    let timer: ReturnType<typeof setTimeout> | undefined
    const future = notes
      .map((n) => (n.snoozed_until ? new Date(n.snoozed_until).getTime() : 0))
      .filter((t) => t > Date.now())
      .sort((a, b) => a - b)[0]
    if (future) {
      const delay = Math.min(Math.max(future - Date.now(), 1000), 6 * 60 * 60_000)
      timer = setTimeout(resync, delay)
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', resync)
      if (timer) clearTimeout(timer)
    }
  }, [notes, qc])

  useEffect(() => { prunePositions(notes.map((n) => n.id)) }, [notes])

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['staff-notes-active'] }), [qc])

  if (isError) return null // never block the CRM on a notes failure

  return (
    <>
      {/* DESKTOP: floating draggable notes */}
      <div className="hidden lg:block">
        {notes.map((n, i) => (
          <DesktopNote key={n.id} note={n} index={i} members={members} meId={meId} onChange={invalidate} onOpen={setEditing} />
        ))}
      </div>

      {/* New note = the FULL editor (text, client, come-back date, who's it for) — not a
          mini popup (Antonio, 2026-07-29). Pre-fills the client from the page you're on. */}
      {composing && (
        <NoteEditor
          note={null}
          members={members}
          meId={meId}
          createDefaults={{
            ...creationSubjectDefaults(),
            originUrl: typeof window !== 'undefined' ? window.location.pathname + window.location.search : undefined,
          }}
          onClose={() => setComposing(false)}
          onChanged={invalidate}
        />
      )}

      {/* DESKTOP: + button, bottom-left. Draggable (double-click resets). */}
      <button
        ref={deskFab.ref}
        {...deskFab.dragProps}
        style={deskFab.style}
        onClick={() => { if (!deskFab.dragging) setComposing(true) }}
        className="hidden lg:flex fixed bottom-4 left-4 z-[45] h-11 w-11 touch-none items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-lg hover:bg-amber-300"
        title="New note — drag to move, double-click to reset"
        aria-label="New note"
      >
        <Plus className="h-5 w-5" />
      </button>

      {/* MOBILE: a pill that opens a sheet.
          RAISED above the composer band (bottom-24). At bottom-4 it sat exactly
          on the Attach button of every chat composer — on Portal Chats that is
          how a client gets an attachment, so the phone could not do the job.
          Draggable too (Antonio, 2026-07-23); double-tap resets.
          `touch-none` is required or the browser gives the drag to the scroller. */}
      <button
        ref={mobileFab.ref}
        {...mobileFab.dragProps}
        style={mobileFab.style}
        onClick={() => { if (!mobileFab.dragging) setSheetOpen(true) }}
        className="lg:hidden fixed bottom-24 left-4 z-[45] flex touch-none items-center gap-2 rounded-full bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950 shadow-lg"
      >
        <StickyNote className="h-4 w-4" />
        {notes.length > 0 ? notes.length : 'Notes'}
      </button>

      {sheetOpen && (
        <MobileSheet
          notes={notes}
          members={members}
          meId={meId}
          onClose={() => setSheetOpen(false)}
          onNew={() => { setSheetOpen(false); setComposing(true) }}
          onChange={invalidate}
          onOpen={(n) => { setSheetOpen(false); setEditing(n) }}
        />
      )}

      {editing && (
        <NoteEditor
          note={editing}
          members={members}
          meId={meId}
          onClose={() => setEditing(null)}
          onChanged={invalidate}
        />
      )}
    </>
  )
}

/* ─────────────────────────── desktop draggable note ─────────────────────────── */

function DesktopNote({ note, index, members, meId, onChange, onOpen }: { note: Note; index: number; members: Member[]; meId: string | null; onChange: () => void; onOpen: (n: Note) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const stored = readPositions()[note.id]
    return stored ?? cascadePos(index)
  })
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const rect = ref.current!.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    ref.current!.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const x = clampFrac((e.clientX - drag.current.dx) / window.innerWidth)
    const y = clampFrac((e.clientY - drag.current.dy) / window.innerHeight)
    setPos({ x, y })
  }
  const onPointerUp = () => {
    if (drag.current) { writePosition(note.id, pos); drag.current = null }
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ left: `${pos.x * 100}vw`, top: `${pos.y * 100}vh` }}
      className={`fixed z-[45] w-60 cursor-grab active:cursor-grabbing rounded-md border shadow-lg ${COLORS[note.color] || COLORS.yellow}`}
    >
      <NoteCardBody note={note} members={members} meId={meId} onChange={onChange} onOpen={onOpen} />
    </div>
  )
}

/* ─────────────────────────── shared card body + actions ─────────────────────────── */

function NoteCardBody({ note, members, meId, onChange, onOpen }: { note: Note; members: Member[]; meId: string | null; onChange: () => void; onOpen?: (n: Note) => void }) {
  const router = useRouter()
  // WHO SEES a note is the author's call alone (2026-07-28 share-back incident) — the
  // share menu is hidden, not disabled, for everyone else. Fail-closed when me is unknown.
  const isAuthor = meId != null && meId === note.author_user_id
  const origin = note.origin_url ? safeOriginPath(note.origin_url) : null
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<'none' | 'snooze' | 'share'>('none')
  const [err, setErr] = useState<string | null>(null)
  const [discussing, setDiscussing] = useState(false)
  // held until Save — see the picker below
  const [customWhen, setCustomWhen] = useState('')

  /**
   * "Discuss this note" — ask the server WHERE the conversation lives (the
   * client's chat for a client note, the teammate DM otherwise), then open the
   * floating chat there. If the floating chat can't show it (switched off, or
   * we're already on the Team Chat page), fall back to the full page — the
   * button is never a dead click.
   */
  const discuss = async () => {
    setDiscussing(true); setErr(null)
    try {
      const res = await fetch(`${API}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: note.id }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not open a chat for this note.')
      }
      const { threadId, draft } = await res.json()
      const handled = requestOpenTeamChat({ threadId, draft })
      if (!handled) router.push(`/team-chat?thread=${threadId}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open a chat for this note.')
    } finally {
      setDiscussing(false)
    }
  }

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id, ...payload }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'That didn\'t work — try again.')
      }
      setMenu('none')
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn\'t work — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-2">
        {/* Tap the text to open the full note (read + edit). Not the whole card — the card is
            the drag handle on desktop, so only the body opens the editor. */}
        <p
          data-no-drag
          onClick={() => onOpen?.(note)}
          title="Open"
          className="cursor-pointer whitespace-pre-wrap break-words text-sm leading-snug line-clamp-6 hover:underline"
        >
          {note.body}
        </p>
        <button data-no-drag onClick={() => act({ action: 'archive' })} disabled={busy}
          className="shrink-0 rounded p-0.5 hover:bg-black/10" title="Done" aria-label="Mark done">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
      </div>

      {noteClientName(note) && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium opacity-80">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{noteClientName(note)}</span>
        </p>
      )}

      {/* Where the note came from — one tap back to the email / chat / page. */}
      {origin && (
        <button
          data-no-drag
          onClick={() => router.push(origin)}
          title={origin}
          className="mt-1 flex items-center gap-1 text-xs opacity-70 hover:underline"
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">From: {describeOrigin(origin)}</span>
        </button>
      )}

      <div className="mt-2 flex items-center gap-1 text-xs opacity-70">
        {note.visibility === 'private' && <Lock className="h-3 w-3" />}
        {note.visibility === 'shared' && <><Share2 className="h-3 w-3" />{note.shared_with_name}</>}
        {note.visibility === 'team' && <><Users className="h-3 w-3" />Team</>}
        <span className="ml-auto flex gap-1">
          <button data-no-drag onClick={discuss} disabled={discussing}
            className="rounded p-0.5 hover:bg-black/10 disabled:opacity-40"
            title={noteClientName(note) ? `Discuss ${noteClientName(note)} in chat` : 'Discuss this note with your teammate'}>
            {discussing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
          </button>
          <button data-no-drag onClick={() => setMenu(menu === 'snooze' ? 'none' : 'snooze')}
            className="rounded p-0.5 hover:bg-black/10" title="Snooze"><Clock className="h-3.5 w-3.5" /></button>
          {isAuthor && (
            <button data-no-drag onClick={() => setMenu(menu === 'share' ? 'none' : 'share')}
              className="rounded p-0.5 hover:bg-black/10" title="Share"><Share2 className="h-3.5 w-3.5" /></button>
          )}
        </span>
      </div>

      {err && <p data-no-drag className="mt-1 text-xs text-red-700">{err}</p>}

      {menu === 'snooze' && (
        <div data-no-drag className="mt-2 grid grid-cols-2 gap-1 text-xs">
          <button onClick={() => act({ action: 'snooze', preset: '10min' })} className="rounded bg-black/10 px-2 py-1">10 min</button>
          <button onClick={() => act({ action: 'snooze', preset: '1hour' })} className="rounded bg-black/10 px-2 py-1">1 hour</button>
          <button onClick={() => act({ action: 'snooze', preset: 'tomorrow' })} className="col-span-2 rounded bg-black/10 px-2 py-1">Tomorrow 9am</button>
          {/* Pick your own moment. The value is HELD until Save is pressed — saving on change
              fired the moment the DATE was picked, before a time could be set, and the note
              vanished mid-edit (Antonio, 2026-07-21). Never save a datetime-local on change. */}
          <label className="col-span-2 mt-1 flex flex-col gap-1">
            <span className="opacity-70">Or pick a date &amp; time</span>
            <div className="flex gap-1">
              <input
                type="datetime-local"
                value={customWhen}
                onChange={(e) => setCustomWhen(e.target.value)}
                className="w-full rounded border border-black/20 bg-white/60 px-2 py-1"
              />
              <button
                disabled={!customWhen}
                onClick={() => {
                  const when = new Date(customWhen)
                  if (isNaN(when.getTime())) return
                  act({ action: 'snooze', preset: 'custom', custom: when.toISOString() })
                }}
                className="shrink-0 rounded bg-black/20 px-2 py-1 font-medium disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </label>
        </div>
      )}

      {menu === 'share' && isAuthor && (
        <div data-no-drag className="mt-2 flex flex-col gap-1 text-xs">
          {members.map((m) => (
            <button key={m.id} onClick={() => act({ action: 'share', shared_with_user_id: m.id })}
              className="rounded bg-black/10 px-2 py-1 text-left">Give to {m.name} 📲</button>
          ))}
          <button onClick={() => act({ action: 'team' })} className="rounded bg-black/10 px-2 py-1 text-left">Show whole team</button>
          {note.visibility !== 'private' && (
            <button onClick={() => act({ action: 'private' })} className="rounded bg-black/10 px-2 py-1 text-left">Make private</button>
          )}
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────── mobile bottom sheet ─────────────────────────── */
// (The old mini Composer lived here — creation now opens the FULL NoteEditor instead.)

function MobileSheet({ notes, members, meId, onClose, onNew, onChange, onOpen }: {
  notes: Note[]; members: Member[]; meId: string | null; onClose: () => void; onNew: () => void; onChange: () => void; onOpen: (n: Note) => void
}) {
  return (
    <div className="lg:hidden fixed inset-0 z-[46] flex flex-col justify-end bg-black/30" onClick={onClose}>
      <div className="max-h-[75vh] overflow-y-auto rounded-t-xl bg-zinc-50 p-3" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Notes</span>
          <button onClick={onNew} className="flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-sm font-medium text-amber-950">
            <Plus className="h-4 w-4" /> New
          </button>
        </div>
        {notes.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">No notes right now.</p>}
        <div className="flex flex-col gap-2">
          {notes.map((n) => (
            <div key={n.id} className={`rounded-md border ${COLORS[n.color] || COLORS.yellow}`}>
              <NoteCardBody note={n} members={members} meId={meId} onChange={onChange} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
