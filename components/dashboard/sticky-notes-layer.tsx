'use client'

/**
 * Staff sticky notes — the note editor + creation entry points.
 *
 * Mounted once in the dashboard layout, OUTSIDE <main> (so it never fights pull-to-refresh).
 * Desktop: this layer no longer renders active notes itself — they live inline in the
 * dashboard header now (components/dashboard/active-notes-strip.tsx), next to the Parked
 * trigger, per the 2026-09-08 redesign (Antonio wanted them "next to Parked button...
 * orizzontaly"; the UX Designer specialist's recommendation was a bounded header strip,
 * not a free-floating draggable canvas — see that file's own header comment for the full
 * reasoning). This file's remaining desktop job is narrower: own the note editor/composer
 * modal and the "New note" entry point, and answer "open this note" requests from
 * anywhere (the header strip, the Parked trigger, the Alerts bell) via the same
 * open-in-place mechanism as before. Mobile (<lg) — a bottom-LEFT pill (the toast layer
 * owns bottom-right) that opens a bottom sheet listing every active note. Since 2026-09-09
 * the team-chat launcher docks on this SAME left edge too (Antonio: "put the bubbles on
 * the same side"), stacked directly below this pill — see floating-chat.tsx's own comment
 * for the exact vertical math.
 * z-index 45: above the mobile top bar (40), below every modal/drawer (50+), so a note never
 * traps a dialog's buttons. Wrapped in its own error boundary — a throw here must not take the CRM down.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StickyNote, Plus, Clock, Share2, Check, Loader2, Users, Lock, Building2, MessageSquare, ExternalLink, Trash2, Minimize2, Pin } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { NoteEditor } from '@/components/dashboard/note-editor'
// AccountCombobox no longer needed here — the create UI is the full NoteEditor now.
import { useDraggableFab } from '@/components/ui/use-draggable-fab'
import { useEdgeDock } from '@/components/ui/use-edge-dock'
import { hoverRevealClass } from '@/lib/ui/edge-dock'
import { FAB_KEYS } from '@/lib/ui/draggable-fab'
import { requestOpenTeamChat } from '@/lib/team/open-team-chat'
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from '@/lib/notes/open-note'
import { safeOriginPath, describeOrigin } from '@/lib/notes/note-origin'
import { latestReplyOf, type NoteReplyRow } from '@/lib/notes/staff-notes'
import { noteUrgencyColors, type NoteAlertKind, type NoteUrgencyColor } from '@/lib/notes/staff-alerts'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { LinkifiedText } from '@/components/dashboard/note-linkified-text'

interface Note {
  id: string
  title: string | null
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
  staff_note_replies?: NoteReplyRow[] | null
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
/** A solid, saturated red — deliberately NOT one of the pastel COLORS above, so "unread"
 *  can never be confused with a deliberately-chosen pink note. Matches the same red
 *  already used for the destructive "Delete forever?" bar in this file. Blinks
 *  (`animate-pulse`) to match the same solid-blinking-red convention already used by the
 *  desktop header pills, the Parked-notes trigger, and the Staff Alerts bell — this was
 *  the one surface still missing the blink (2026-09-09). */
const UNREAD_CLASSES = 'animate-pulse bg-red-600 border-red-700 text-white'
/** A snoozed note whose time has come back up — solid, blinking, and deliberately NOT a
 *  shade of amber/yellow: this feature's own brand color (the "+" buttons) and its
 *  existing "parked, nothing urgent" indicator are both already amber, so a third amber-
 *  family meaning here would be the one thing Antonio explicitly asked to avoid (Council
 *  review, dev job b85fe89e). Teal has no existing meaning anywhere in this feature. */
const DUE_CLASSES = 'animate-pulse bg-teal-600 border-teal-700 text-white'

function noteBgClasses(note: Note, urgency: NoteUrgencyColor | null | undefined): string {
  if (urgency === 'red') return UNREAD_CLASSES
  if (urgency === 'teal') return DUE_CLASSES
  return COLORS[note.color] || COLORS.yellow
}

async function fetchActive(): Promise<ActiveResponse> {
  const res = await fetch(`${API}?scope=active`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load your notes.')
  }
  return res.json()
}

/**
 * Same query key ('staff-notes-parked') ParkedNotesTrigger already fetches under —
 * react-query dedupes identical concurrent queries, so mounting this here is not a
 * second network round trip, it's a shared cache hit. Needed so the open-note
 * listener below can ALSO claim a parked note synchronously (see that effect's
 * own comment for why this can't just be an async fetch at click time).
 */
async function fetchParked(): Promise<{ notes: Note[] }> {
  const res = await fetch(`${API}?scope=parked`)
  if (!res.ok) return { notes: [] }
  return res.json().catch(() => ({ notes: [] }))
}

/**
 * Reuses the Staff Alerts bell's own "have I seen this note" tracking (Antonio,
 * 2026-09-05: red until read, yellow after — same rule for a fresh reply as for a
 * fresh share) rather than a second, parallel read-tracker that could disagree with
 * the bell about the same note. Same query key ('staff-alerts') as
 * staff-alerts-bell.tsx on purpose — one shared cache, so dismissing here also
 * clears the bell's badge for this note, and vice versa.
 */
interface StaffAlertLite { kind: NoteAlertKind; note_id: string; reply_id: string | null }
async function fetchStaffAlerts(): Promise<{ alerts: StaffAlertLite[] }> {
  const res = await fetch('/api/crm/staff-alerts')
  if (!res.ok) return { alerts: [] }
  return res.json().catch(() => ({ alerts: [] }))
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
  // Parked notes aren't rendered here (they're off the floating layer by design), but this
  // layer is still the ONE place that owns the note editor + open-in-place mechanism — see
  // the open-note listener below.
  const { data: parkedData } = useQuery({
    queryKey: ['staff-notes-parked'],
    queryFn: fetchParked,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
  const parkedNotes = useMemo(() => parkedData?.notes ?? [], [parkedData])
  const meId = data?.me?.id ?? null

  // Same query key as staff-alerts-bell.tsx — one shared cache for "have I seen this."
  const { data: alertsData } = useQuery({
    queryKey: ['staff-alerts'],
    queryFn: fetchStaffAlerts,
    refetchInterval: 60_000,
  })
  const noteAlerts = useMemo(
    () =>
      (alertsData?.alerts ?? []).filter(
        (a) => a.kind === 'note_update' || a.kind === 'note_reply' || a.kind === 'note_snooze_due',
      ),
    [alertsData],
  )
  // THE ONE red-vs-teal decision — see noteUrgencyColors' own header for why this must
  // never be re-derived independently per surface.
  const noteColors = useMemo(() => noteUrgencyColors(noteAlerts), [noteAlerts])

  /** Mark one note read: dismiss every pending alert on it (the share/edit alert AND
   *  any pending replies), same optimistic-then-invalidate pattern as the bell's own
   *  dismissMany, so a failed write surfaces instead of silently staying "read." */
  const dismissNoteAlerts = useCallback(async (noteId: string) => {
    const mine = noteAlerts.filter((a) => a.note_id === noteId)
    if (mine.length === 0) return
    qc.setQueryData<{ alerts: StaffAlertLite[] }>(['staff-alerts'], (old) =>
      old ? { alerts: old.alerts.filter((a) => a.note_id !== noteId) } : old,
    )
    try {
      await Promise.all(mine.map(async (a) => {
        const res = await fetch('/api/crm/staff-alerts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: a.kind, note_id: a.note_id, reply_id: a.reply_id }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not mark that note read — it may show as new again.')
        }
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark that note read — it may show as new again.')
    } finally {
      qc.invalidateQueries({ queryKey: ['staff-alerts'] })
    }
  }, [noteAlerts, qc])

  const [composing, setComposing] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)
  // Both entry points are draggable (Antonio, 2026-07-23) — separate keys so the
  // desktop + button and the mobile pill remember their own spots per device.
  const deskFab = useDraggableFab(`${FAB_KEYS.notes}-desktop`, { dragThresholdPx: 16 })
  const mobileFab = useDraggableFab(FAB_KEYS.notes)
  // Both launchers dock toward the LEFT edge by default — their own existing home
  // corner (Antonio: "hidden for 3/4 on the side of the screen and recall them
  // when needed," 2026-09-09, dev job b85fe89e).
  const deskDock = useEdgeDock(deskFab.ref, { defaultEdge: 'left', pos: deskFab.pos })
  // remeasureOn: notes.length — this pill's own label switches from the wider
  // "Notes" loading placeholder to a narrower real count once the query
  // resolves; see useEdgeDock's own remeasureOn comment for why a plain
  // ResizeObserver did not reliably catch that specific change on its own.
  const mobileDock = useEdgeDock(mobileFab.ref, { defaultEdge: 'left', pos: mobileFab.pos, remeasureOn: notes.length })

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

  /**
   * External "open this note" — lets another surface (the Staff Alerts bell,
   * the Parked-notes trigger) open a specific note here instead of navigating
   * away, the same way "Discuss this note" opens the floating chat by event
   * (mirrors FloatingChatInner's OPEN_TEAM_CHAT_EVENT handler exactly).
   *
   * SYNCHRONOUS ONLY, on purpose: preventDefault only affects the dispatcher's
   * return value if called before dispatchEvent returns, so this can only claim
   * a note already loaded CLIENT-SIDE at the moment of the click — an async
   * fetch-then-open fallback was considered and rejected for exactly this
   * reason (preventDefault can't fire late enough to stop a navigation that's
   * already happened by the time an async fetch resolves).
   *
   * Checks BOTH the active feed AND the parked feed (2026-09-08 — found live:
   * every parked note was silently falling through to a full navigation, 100%
   * of the time, never just the rare case, since isLiveOrRevivedFor
   * unconditionally excludes parked notes from `notes`). The parked list is
   * fetched above under the SAME query key the header's Parked trigger
   * already uses, so checking it here costs no extra request. A note that's
   * snoozed or archived-for-me but still alerting (note_update isn't gated on
   * either) is still a real, accepted gap — we let the event go unhandled and
   * the caller falls back to navigating to /notes?note=<id>, which shows
   * every note, not just active/parked ones. Never a dead click either way.
   */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as OpenNoteDetail | undefined
      const noteId = detail?.noteId
      if (!noteId) return
      const found = notes.find((n) => n.id === noteId) ?? parkedNotes.find((n) => n.id === noteId)
      if (!found) return
      e.preventDefault()
      setSheetOpen(false)
      setEditing(found)
    }
    document.addEventListener(OPEN_NOTE_EVENT, onOpen)
    return () => document.removeEventListener(OPEN_NOTE_EVENT, onOpen)
  }, [notes, parkedNotes])

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['staff-notes-active'] }), [qc])

  if (isError) return null // never block the CRM on a notes failure

  return (
    <>
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

      {/* DESKTOP: + button, bottom-left, draggable (double-click resets) — opens the
          composer directly. Simplified back to a single action (2026-09-08: active
          notes moved into the header strip, next to Parked — see
          active-notes-strip.tsx — so there is no more floating canvas for a
          "select notes" menu item to send you to; bulk-selecting for Park now happens
          inside that header strip's own dropdown instead).

          bottom-24, not the old bottom-4 (2026-09-09: Antonio, having used both
          launchers live, "put the bubbles on the same side" — the chat launcher
          moved from the right edge onto this same left edge, so this button
          moved UP to stack above it with a clear gap, rather than the two
          landing on top of each other; chat's own bottom-6 desktop position is
          unchanged, see floating-chat.tsx).

          A FIRST hover-to-reveal attempt was tried the same round and
          REVERTED within the hour — live on a real phone it froze/strobed the
          screen. Root cause: it revealed to the button's own natural inset
          resting spot, which is PAST wherever the pointer already sat in the
          docked sliver — sweeping the button's edge past the pointer drops
          the hover, which docks it again, which puts the sliver BACK under
          the pointer, re-triggering — a loop, many times a second. The claim
          this would be "harmless on touch, which has no sustained hover" was
          asserted, not verified, and was wrong — touch reproduced it too.
          REBUILT (2026-09-09) using hoverRevealClass from lib/ui/edge-dock.ts:
          it reveals flush at the true edge (x=0) instead of the inset resting
          spot, which the module's own HOVER_REVEAL_PX comment proves cannot
          reopen the loop — the docked-visible range is always a subset of
          the revealed range, so the pointer can never be swept out from
          under itself. */}
      <FastTooltip label="New note — drag to move, double-click to reset & reveal" align="left">
        <button
          ref={deskFab.ref}
          {...deskFab.dragProps}
          style={{ ...deskFab.style, ...deskDock.dockStyle }}
          onClick={() => { if (!deskFab.dragging) setComposing(true) }}
          onDoubleClick={() => { deskFab.reset(); deskDock.revealPermanently() }}
          className={`hidden lg:flex fixed bottom-24 left-4 z-[45] h-11 w-11 touch-none items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-lg hover:bg-amber-300 ${hoverRevealClass('left')}`}
          aria-label="New note"
        >
          <Plus className="h-5 w-5" />
        </button>
      </FastTooltip>

      {/* MOBILE: a pill that opens a sheet.
          RAISED above the composer band (bottom-24 was the floor — at bottom-4 it
          sat exactly on the Attach button of every chat composer, and on Portal
          Chats that is how a client gets an attachment, so the phone could not do
          the job). Now bottom-40, one more step up (2026-09-09: the chat launcher
          moved onto this same left edge at its own unchanged bottom-24, so this
          pill moved UP to stack above it rather than overlap — see
          floating-chat.tsx). Draggable too (Antonio, 2026-07-23); double-tap
          resets. `touch-none` is required or the browser gives the drag to the
          scroller.

          A pointer-hover reveal was tried here too, same round, same revert —
          see the desktop button's own comment above for the full incident
          (root cause was the same on both: revealing to the natural inset
          spot moves the button's edge out from under the pointer, which
          un-triggers the reveal, oscillating). On THIS button it was touch
          itself that reproduced it live, on Antonio's own phone — direct
          proof the "touch has no sustained hover" assumption was wrong, not
          just an assumption. REBUILT (2026-09-09) with the same
          hoverRevealClass flush-edge fix as the desktop button above. */}
      <button
        ref={mobileFab.ref}
        {...mobileFab.dragProps}
        style={{ ...mobileFab.style, ...mobileDock.dockStyle }}
        onDoubleClick={() => { mobileFab.reset(); mobileDock.revealPermanently() }}
        onClick={() => {
          if (mobileFab.dragging) return
          setSheetOpen(true)
          // Opening the sheet already reveals every note's full preview text — the phone
          // has no separate collapsed-icon step to click through, so opening IS reading
          // (Antonio, 2026-09-05: the phone should behave the same as the desktop icons).
          for (const n of notes) if (noteColors.has(n.id)) dismissNoteAlerts(n.id)
        }}
        className={`lg:hidden fixed bottom-40 left-4 z-[45] flex touch-none items-center gap-2 rounded-full bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950 shadow-lg ${hoverRevealClass('left')}`}
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
          noteColors={noteColors}
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


/* ─────────────────────────── shared card body + actions ─────────────────────────── */

function NoteCardBody({ note, members, meId, onChange, onOpen, onCollapse }: { note: Note; members: Member[]; meId: string | null; onChange: () => void; onOpen?: (n: Note) => void; onCollapse?: () => void }) {
  const router = useRouter()
  // WHO SEES a note is the author's call alone (2026-07-28 share-back incident) — the
  // share menu is hidden, not disabled, for everyone else. Fail-closed when me is unknown.
  const isAuthor = meId != null && meId === note.author_user_id
  const origin = note.origin_url ? safeOriginPath(note.origin_url) : null
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<'none' | 'snooze' | 'share'>('none')
  const [err, setErr] = useState<string | null>(null)
  const [discussing, setDiscussing] = useState(false)
  // Delete straight from the card (Luca's ask, 2026-07-22) — author-only, two-tap confirm.
  const [confirmDelete, setConfirmDelete] = useState(false)
  // held until Save — see the picker below
  const [customWhen, setCustomWhen] = useState('')

  /** Delete COMPLETELY, for everyone — same author-only endpoint the editor uses.
   *  Distinct from Done (per-person). Two taps: first turns the icon into a red
   *  "Delete forever?", second actually deletes. */
  const del = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${API}?id=${note.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not delete the note.')
      }
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete the note.')
    } finally {
      setBusy(false); setConfirmDelete(false)
    }
  }

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
        <div data-no-drag onClick={() => onOpen?.(note)} title="Open" className="min-w-0 flex-1 cursor-pointer">
          {note.title && (
            <p className="truncate text-sm font-semibold leading-snug hover:underline">{note.title}</p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm leading-snug line-clamp-6 hover:underline">
            <LinkifiedText text={note.body} />
          </p>
        </div>
        <FastTooltip label="Done">
          <button data-no-drag onClick={() => act({ action: 'archive' })} disabled={busy}
            className="shrink-0 rounded p-0.5 hover:bg-black/10" aria-label="Mark done">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
        </FastTooltip>
      </div>

      {noteClientName(note) && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium opacity-80">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{noteClientName(note)}</span>
        </p>
      )}

      {/* Latest answer, in the reply colour — see who answered without opening. */}
      {(() => {
        const latest = latestReplyOf(note)
        if (!latest) return null
        const count = (note.staff_note_replies ?? []).length
        const byAuthor = latest.author_user_id != null && latest.author_user_id === note.author_user_id
        return (
          <p className={`mt-1 truncate rounded px-1.5 py-0.5 text-xs ${byAuthor ? 'bg-amber-200/70 text-amber-950' : 'bg-sky-200/80 text-sky-950'}`}>
            ↳ {latest.author_name || 'Teammate'}: {latest.body}{count > 1 ? `  (+${count - 1})` : ''}
          </p>
        )
      })()}

      {/* Where the note came from — one tap back to the email / chat / page. */}
      {origin && (
        <FastTooltip label={origin}>
          <button
            data-no-drag
            onClick={() => router.push(origin)}
            aria-label={origin}
            className="mt-1 flex items-center gap-1 text-xs opacity-70 hover:underline"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">From: {describeOrigin(origin)}</span>
          </button>
        </FastTooltip>
      )}

      <div className="mt-2 flex items-center gap-1 text-xs opacity-70">
        {note.visibility === 'private' && <Lock className="h-3 w-3" />}
        {note.visibility === 'shared' && <><Share2 className="h-3 w-3" />{note.shared_with_name}</>}
        {note.visibility === 'team' && <><Users className="h-3 w-3" />Team</>}
        <span className="ml-auto flex gap-1">
          <FastTooltip label={noteClientName(note) ? `Discuss ${noteClientName(note)} in chat` : 'Discuss this note with your teammate'}>
            <button data-no-drag onClick={discuss} disabled={discussing}
              className="rounded p-0.5 hover:bg-black/10 disabled:opacity-40"
              aria-label={noteClientName(note) ? `Discuss ${noteClientName(note)} in chat` : 'Discuss this note with your teammate'}>
              {discussing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
            </button>
          </FastTooltip>
          <FastTooltip label="Snooze">
            <button data-no-drag onClick={() => setMenu(menu === 'snooze' ? 'none' : 'snooze')}
              className="rounded p-0.5 hover:bg-black/10" aria-label="Snooze"><Clock className="h-3.5 w-3.5" /></button>
          </FastTooltip>
          <FastTooltip label="Park — move it to the notes shelf, out of the way">
            <button data-no-drag onClick={() => act({ action: 'park' })} disabled={busy}
              className="rounded p-0.5 hover:bg-black/10 disabled:opacity-40" aria-label="Park this note">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
          </FastTooltip>
          {isAuthor && (
            <FastTooltip label="Share">
              <button data-no-drag onClick={() => setMenu(menu === 'share' ? 'none' : 'share')}
                className="rounded p-0.5 hover:bg-black/10" aria-label="Share"><Share2 className="h-3.5 w-3.5" /></button>
            </FastTooltip>
          )}
          {isAuthor && (
            <FastTooltip label="Delete this note for everyone">
              <button data-no-drag onClick={() => setConfirmDelete((v) => !v)}
                className={`rounded p-0.5 hover:bg-black/10 ${confirmDelete ? 'bg-red-600/20 text-red-700' : ''}`}
                aria-label="Delete this note for everyone"><Trash2 className="h-3.5 w-3.5" /></button>
            </FastTooltip>
          )}
          {onCollapse && (
            <FastTooltip label="Minimize to icon">
              <button data-no-drag onClick={onCollapse}
                className="rounded p-0.5 hover:bg-black/10" aria-label="Minimize to icon">
                <Minimize2 className="h-3.5 w-3.5" />
              </button>
            </FastTooltip>
          )}
        </span>
      </div>

      {/* Second tap happens on a full-width red bar, never on the tiny icon — a stray
          tap can't destroy a note. Deleting removes it for EVERYONE (unlike Done). */}
      {confirmDelete && (
        <div data-no-drag className="mt-2 flex gap-1 text-xs">
          <FastTooltip label="Deletes the note for everyone — replies go with it">
            <button onClick={del} disabled={busy}
              aria-label="Deletes the note for everyone — replies go with it"
              className="flex flex-1 items-center justify-center gap-1 rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              {(note.staff_note_replies ?? []).length > 0 ? 'Delete forever, replies too?' : 'Delete forever?'}
            </button>
          </FastTooltip>
          <button onClick={() => setConfirmDelete(false)} disabled={busy}
            className="rounded bg-black/10 px-2 py-1">Keep</button>
        </div>
      )}

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

function MobileSheet({ notes, members, meId, onClose, onNew, onChange, onOpen, noteColors }: {
  notes: Note[]; members: Member[]; meId: string | null; onClose: () => void; onNew: () => void; onChange: () => void; onOpen: (n: Note) => void
  noteColors: Map<string, NoteUrgencyColor>
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
            <div key={n.id} className={`rounded-md border ${noteBgClasses(n, noteColors.get(n.id))}`}>
              <NoteCardBody note={n} members={members} meId={meId} onChange={onChange} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
