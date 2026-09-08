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

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StickyNote, Plus, Clock, Share2, Check, Loader2, Users, Lock, Building2, MessageSquare, ExternalLink, Trash2, Minimize2, Pin, CheckSquare, Move } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { readPositions, writePosition, prunePositions, cascadePos, clampFrac, type FracPos } from '@/lib/notes/note-position'
import { NoteEditor } from '@/components/dashboard/note-editor'
// AccountCombobox no longer needed here — the create UI is the full NoteEditor now.
import { useDraggableFab } from '@/components/ui/use-draggable-fab'
import { FAB_KEYS, isDragGesture } from '@/lib/ui/draggable-fab'
import { requestOpenTeamChat } from '@/lib/team/open-team-chat'
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from '@/lib/notes/open-note'
import { safeOriginPath, describeOrigin } from '@/lib/notes/note-origin'
import { latestReplyOf, type NoteReplyRow } from '@/lib/notes/staff-notes'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import { LinkifiedText } from '@/components/dashboard/note-linkified-text'

// cascadePos's own starting row/column (note-position.ts: y=0.08, x=0.04) — plain
// constants kept in sync here, not re-derived, since note-position.ts is deliberately
// pixel-agnostic (fractions only) and has no reason to know about the fixed-size chrome
// (header, sidebar) it now has to clear.
const CASCADE_FIRST_ROW_VH = 8
const CASCADE_FIRST_COL_VW = 4
// cascadePos's own HIGHEST column fraction (2026-09-08: the cascade now starts at the
// right edge, next to the Parked trigger, and steps left — see note-position.ts). Feeds
// the CEILING-side mirror of the shift below.
const CASCADE_LAST_COL_VW = 92
// Must clear the sticky desktop header (h-14 = 3.5rem) with a visible margin — measured
// live, not assumed: on sandbox specifically, the dashboard layout also adds `mt-10`
// (2.5rem) above the whole app to make room for the fixed orange sandbox banner
// (`app/(dashboard)/layout.tsx`, `isSandbox ? '... mt-10' : 'h-screen'`), so the header
// there actually sits at 2.5rem+3.5rem=6rem from the true top, not 3.5rem. Production has
// no banner and no mt-10, so its header genuinely does start at the top — but this one
// constant has no way to know which environment it's rendering in, so it's calibrated to
// the taller (sandbox) case; production ends up with a bit of harmless extra headroom
// rather than sandbox ending up under-cleared. A first version of this constant (4.5rem)
// was calibrated against production's header alone and looked fine there, but still
// visibly overlapped the header in sandbox — caught by measuring the actual rendered
// element positions with getBoundingClientRect, not by eyeballing a screenshot.
const HEADER_CLEARANCE_REM = 7
// Must clear the desktop sidebar (aside is w-64 = 16rem at the lg breakpoint this
// component only ever renders at) with a visible margin. Antonio, 2026-09-07 (second
// screenshot, on Team Workspace): notes were still landing on the sidebar's own nav
// links — the sidebar goes `static` (in normal document flow) at this same breakpoint,
// which also drops its z-index to `auto`, so it can no longer rely on stacking order to
// stay above a `fixed` note at z-45; only keeping the note out of that space at all works.
const SIDEBAR_CLEARANCE_REM = 17
// The two sizes notePosStyle is ever called with — the collapsed pill (fixed h-10,
// max-w-[180px]) and the expanded card (fixed w-60; height is content-driven, so this
// is a reasonable reserve for a typical note, not a hard cap — see notePosStyle's
// own comment on the right/bottom edge below).
const COLLAPSED_SIZE_REM = { width: 11.25, height: 2.5 }
const EXPANDED_SIZE_REM = { width: 15, height: 14 }
const EDGE_MARGIN_REM = 1

/**
 * Desktop note position as a CSS style — shifts the WHOLE cascade down-and-right
 * together on a small screen, rather than flooring one note independently, so notes
 * never bunch up against each other. An earlier version floored only `${pos.y*100}vh`
 * per note: correct for row 0, but it compressed the gap to row 1 on any viewport short
 * enough to need the floor at all — found by creating real notes and looking, not by
 * reasoning about the CSS. Each inner `calc()`'s shared `max(0px, ...)` term is
 * identical for every note on that axis, so relative spacing between rows/columns is
 * preserved exactly — a shifted column 0 and a shifted column 1 both move by the same
 * amount, so the 0.18-viewport-width gap between them survives untouched.
 *
 * The floor (the `clamp()`'s low end) is a second, independent fix (Antonio,
 * 2026-09-07, third screenshot on Team Workspace: four OLD notes, each with its own
 * stored/dragged position from before this clearance logic existed, still sitting on
 * the sidebar). The inner shift is calibrated against cascadePos's OWN starting
 * fraction (x=0.04 / y=0.08) — correct for anything the cascade itself ever generates,
 * but a note can also carry a STORED position (drag-and-drop, or from before this fix
 * shipped) anywhere down to 0, and the shift alone under-corrects any position closer to
 * the edge than the cascade's own minimum. The floor is a hard backstop on top of that: a
 * no-op for every position at or beyond the cascade minimum (the inner shift already
 * lands those at-or-past the floor), and a genuine minimum for anything closer in — so
 * both a fresh cascade note AND an old dragged one always clear the same chrome.
 *
 * The CEILING (the `clamp()`'s high end) exists because the shift above is a REGRESSION
 * on the opposite edge if left unbounded — caught by an end-to-end review, not by any of
 * this session's own live tests (which only ever pushed a note toward the LOW corner).
 * `writePosition`'s own `clampFrac(v, 0.92)` reserves 8% of the viewport as margin so a
 * dragged note can never go fully off-screen — a contract that held when position was
 * rendered as a bare fraction, but the shift above is ADDED on top of that fraction with
 * nothing capping the total, so a note dragged toward the right/bottom edge (a completely
 * ordinary "tuck it out of the way" action) could render partly or fully past the
 * viewport, with no visible trace and no way to drag it back. `width`/`height` let each
 * call site (collapsed pill vs. expanded card) reserve exactly its own footprint at the
 * high end; the expanded card's real height is content-driven, so `EXPANDED_SIZE_REM` is
 * a reasonable typical-note reserve, not a hard cap — a note with an unusually long reply
 * thread can still extend further, same as it always could before any of this session's
 * changes (that risk is pre-existing and unrelated to the shift this fix adds).
 *
 * SECOND, MIRRORED shift on the horizontal axis only (2026-09-08, Antonio: "I want the
 * notes on the screen, next to Parked button... orizzontaly" — cascadePos now starts its
 * highest column at the right edge instead of its lowest at the left). The LEFT shift
 * above is an ALWAYS-ON exact-position mechanism, not a rare-narrow-screen rescue: for
 * any realistic viewport it makes fraction `CASCADE_FIRST_COL_VW%` land at EXACTLY
 * `SIDEBAR_CLEARANCE_REM` from the left, full stop. Reusing it unmodified for the new
 * high-fraction columns does the opposite of what's wanted — it pushes an already-far-
 * right column even FURTHER right, past the true edge, so two-plus columns collapse onto
 * the same clamped ceiling value instead of rendering as a proper row (caught live: 5
 * fresh notes, two of them landing pixel-identical). `rightShift` is the same mechanism
 * mirrored for the opposite edge — it makes fraction `CASCADE_LAST_COL_VW%` (cascadePos's
 * own highest column) land at EXACTLY `size.width + EDGE_MARGIN_REM` from the right, for
 * any realistic viewport, by computing how far that column would overshoot the ceiling
 * (itself already shifted left) and pulling the WHOLE row back by exactly that amount —
 * same "shift the group, don't floor one note independently" principle as the original,
 * just solved for the other edge. Verified algebraically to land the top column flush at
 * the ceiling at both 1024px (the narrowest width this layer ever renders at) and 1920px+,
 * not just eyeballed at one size — a flat, unshifted fraction looked fine narrow and
 * drifted hundreds of pixels short of the edge wide, since the true ceiling itself moves
 * with viewport width in a way no single fraction can track alone.
 */
function notePosStyle(pos: FracPos, size: { width: number; height: number }): React.CSSProperties {
  const leftShift = `max(0px, ${SIDEBAR_CLEARANCE_REM}rem - ${CASCADE_FIRST_COL_VW}vw)`
  const ceiling = `100vw - ${size.width + EDGE_MARGIN_REM}rem`
  const rightShift = `max(0px, calc(${CASCADE_LAST_COL_VW}vw + ${leftShift} - (${ceiling})))`
  return {
    left: `clamp(${SIDEBAR_CLEARANCE_REM}rem, calc(${pos.x * 100}vw + ${leftShift} - ${rightShift}), calc(${ceiling}))`,
    top: `clamp(${HEADER_CLEARANCE_REM}rem, calc(${pos.y * 100}vh + max(0px, ${HEADER_CLEARANCE_REM}rem - ${CASCADE_FIRST_ROW_VH}vh)), calc(100vh - ${size.height + EDGE_MARGIN_REM}rem))`,
  }
}

/** This file assumes the untouched CSS default of 1rem = 16px throughout — already relied
 *  on implicitly by every other REM constant's own comment above; named here because the
 *  functions below are the first to actually need it as a real number, not just inside a
 *  CSS string the browser converts for us. */
const REM_PX = 16

/**
 * The exact NUMBER of pixels notePosStyle's own shift adds on the horizontal axis, for a
 * real drag to correctly invert (2026-09-08, Bug Hunter EtoE pass on THIS SAME cascade
 * fix: "the hand is always out of the notes" while dragging). `onPointerMove` below turns
 * a raw mouse position into a STORED FRACTION by dividing by the viewport width — correct
 * ONLY if the fraction maps 1:1 to a rendered pixel, which stopped being true the moment
 * notePosStyle started adding leftShift/rightShift on top of `pos.x*100vw`. Left
 * uncorrected, every drag silently baked an extra `leftShift - rightShift` pixels into the
 * stored position the instant it started moving — the cursor tracks the mouse exactly (it
 * IS the mouse), but the note jumps by that fixed offset the moment the drag begins and
 * never catches back up, which is exactly "the hand is out of the notes." Must mirror
 * notePosStyle's OWN left/rightShift math exactly, as plain numbers instead of a CSS
 * string — computed fresh on every call (cheap, and self-corrects if the window is ever
 * resized mid-drag) rather than cached once at drag-start.
 */
function horizontalShiftPx(viewportWidthPx: number, noteWidthRem: number): number {
  const leftShift = Math.max(0, SIDEBAR_CLEARANCE_REM * REM_PX - (CASCADE_FIRST_COL_VW / 100) * viewportWidthPx)
  const ceiling = viewportWidthPx - (noteWidthRem + EDGE_MARGIN_REM) * REM_PX
  const rightShift = Math.max(0, (CASCADE_LAST_COL_VW / 100) * viewportWidthPx + leftShift - ceiling)
  return leftShift - rightShift
}

/** Same idea as horizontalShiftPx, for the vertical axis — notePosStyle's `top` only ever
 *  had the one (left-shift-equivalent) term, never a mirrored ceiling term, so this is
 *  simpler than the horizontal version, but the same drag-inversion bug applies to it. */
function verticalShiftPx(viewportHeightPx: number): number {
  return Math.max(0, HEADER_CLEARANCE_REM * REM_PX - (CASCADE_FIRST_ROW_VH / 100) * viewportHeightPx)
}

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
 *  already used for the destructive "Delete forever?" bar in this file. */
const UNREAD_CLASSES = 'bg-red-600 border-red-700 text-white'

function noteBgClasses(note: Note, unread: boolean): string {
  return unread ? UNREAD_CLASSES : COLORS[note.color] || COLORS.yellow
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
interface StaffAlertLite { kind: string; note_id: string; reply_id: string | null }
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

  /**
   * Every note's starting position — decided ONCE per note, ever, and remembered here
   * for as long as this layer stays mounted. A `useMemo` alone is not enough: it would
   * recompute from scratch whenever `notes` changes (a note added or removed), but a
   * note ALREADY on screen ignores a freshly-recomputed value — its own useState only
   * reads its initial prop once, at ITS first mount, exactly like this ref only decides
   * a slot once. Recomputing on every change and expecting already-mounted notes to
   * "pick up" a new value was the actual bug: two never-moved notes both computed the
   * identical fresh slot, because the feed sorts newest-first so a brand-new note is
   * always first, and computing all slots from empty every time gave the EXISTING note
   * a value its own component then silently ignored (Antonio, 2026-09-05: "they go one
   * on top of the other and I can't see them unless i move them"). A ref, mutated
   * idempotently here during render (safe: re-running with the same `notes` re-adds only
   * already-present entries), is what makes a slot assignment durable across re-renders.
   */
  const assignedPositions = useRef<Map<string, FracPos>>(new Map())
  // Bumped by moveSelected (below) to force this memo to recompute even though `notes`
  // itself never changes for a pure reposition — a move touches no server state, only
  // localStorage, so there is no query-invalidation that would otherwise trigger it.
  const [posEpoch, setPosEpoch] = useState(0)
  const notePositions = useMemo(() => {
    const stored = readPositions()
    const map = assignedPositions.current
    const liveIds = new Set(notes.map((n) => n.id))
    for (const id of Array.from(map.keys())) if (!liveIds.has(id)) map.delete(id)
    const occupied: FracPos[] = Array.from(map.values())
    for (const n of notes) {
      if (map.has(n.id)) continue // already decided — never reassign a note that's already on screen
      const pos = stored[n.id] ?? cascadePos(occupied)
      map.set(n.id, pos)
      occupied.push(pos)
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, posEpoch])
  // A note's own `pos` state only ever reads its `initialPos` prop on first mount (see
  // DesktopNote's own comment on this) — so after moveSelected writes a fresh position,
  // the already-mounted instance needs a genuinely NEW key to remount and pick it up.
  // Bumped per-note, not globally, so a move never disturbs notes that weren't selected.
  const moveVersions = useRef<Map<string, number>>(new Map())

  // Same query key as staff-alerts-bell.tsx — one shared cache for "have I seen this."
  const { data: alertsData } = useQuery({
    queryKey: ['staff-alerts'],
    queryFn: fetchStaffAlerts,
    refetchInterval: 60_000,
  })
  const noteAlerts = useMemo(
    () => (alertsData?.alerts ?? []).filter((a) => a.kind === 'note_update' || a.kind === 'note_reply'),
    [alertsData],
  )
  const unreadNoteIds = useMemo(() => new Set(noteAlerts.map((a) => a.note_id)), [noteAlerts])

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

  // Guarded on `data` (not just `notes`, which defaults to [] before the fetch even
  // resolves) — pruning against an empty list on the very first render wiped every
  // stored position on every page load, before the real note list ever arrived
  // (found live, 2026-09-08: Antonio's notes kept losing their spread-out positions
  // and re-bunching into the default cascade on every reload).
  useEffect(() => { if (data) prunePositions(notes.map((n) => n.id)) }, [data, notes])

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

  /**
   * Select-and-park: Antonio, 2026-09-07 (Finance-page screenshot, notes scattered
   * over real content): "I want a solution to select of them an move all together
   * in another place." Desktop only — the mobile sheet is already a plain scrollable
   * list, so the on-screen-clutter problem this solves doesn't exist there; a mobile
   * note still parks fine one at a time via NoteCardBody's own Park button.
   */
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [parking, setParking] = useState(false)
  // The "+" button opens a small menu (New note / Select notes) instead of jumping
  // straight to composing — Antonio, 2026-09-08: "why don't inglobe the select button
  // in the '+' icon... instead of creating a noisy [corner] with a lot of icones."
  const [fabMenuOpen, setFabMenuOpen] = useState(false)
  // Where the menu renders when the "+" button has been dragged away from its
  // default corner — null (→ the plain default-corner CSS) until it has actually
  // moved. Measured fresh every time the menu opens, via the button's own ref,
  // rather than re-deriving deskFab's drag math here (Bug Hunter, 2026-09-08).
  const [menuAnchor, setMenuAnchor] = useState<{ left: string; bottom: string } | null>(null)
  useLayoutEffect(() => {
    if (!fabMenuOpen) return
    if (!deskFab.hasMoved) { setMenuAnchor(null); return }
    const el = deskFab.ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 200))
    const bottom = Math.max(8, window.innerHeight - rect.top + 8)
    setMenuAnchor({ left: `${left}px`, bottom: `${bottom}px` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabMenuOpen])
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  const exitSelectMode = useCallback(() => { setSelectMode(false); setSelectedIds(new Set()) }, [])
  const parkSelected = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setParking(true)
    try {
      const results = await Promise.all(ids.map((id) =>
        fetch(API, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, action: 'park' }),
        }).then((r) => r.ok).catch(() => false),
      ))
      const failed = results.filter((ok) => !ok).length
      if (failed > 0) toast.error(`${failed} note${failed > 1 ? 's' : ''} couldn't be parked — try again.`)
      invalidate()
    } finally {
      setParking(false)
      exitSelectMode()
    }
  }, [selectedIds, invalidate, exitSelectMode])

  /**
   * "Move" — Antonio, 2026-09-08: "I dont' want only to park them, I want to move in
   * the screen changing spot." Unlike Park, this touches no server state at all —
   * position is purely client-side (note-position.ts) — so it's synchronous, has
   * nothing to fail over the network, and needs no loading state. Re-cascades every
   * selected note to a fresh free slot, using the SAME collision-avoiding search a
   * brand-new note gets, seeded with every note's CURRENT spot except the ones being
   * moved (so the just-moved notes don't land on top of notes staying put, or on top
   * of each other — built up incrementally exactly like notePositions' own loop does).
   */
  const moveSelected = useCallback(() => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const map = assignedPositions.current
    const idSet = new Set(ids)
    const occupied: FracPos[] = Array.from(map.entries())
      .filter(([id]) => !idSet.has(id))
      .map(([, pos]) => pos)
    for (const id of ids) {
      const fresh = cascadePos(occupied)
      writePosition(id, fresh)
      occupied.push(fresh)
      map.delete(id) // let notePositions re-derive it from the fresh stored value below
      moveVersions.current.set(id, (moveVersions.current.get(id) ?? 0) + 1)
    }
    setPosEpoch((v) => v + 1)
    exitSelectMode()
  }, [selectedIds, exitSelectMode])

  if (isError) return null // never block the CRM on a notes failure

  return (
    <>
      {/* DESKTOP: floating draggable notes. Keyed on id + its own move-version, not just
          id — moveSelected (above) bumps ONLY the moved notes' version, forcing exactly
          those to remount and pick up their freshly-written position (a note's own `pos`
          state only ever reads its initialPos prop once, at first mount). */}
      <div className="hidden lg:block">
        {notes.map((n) => (
          <DesktopNote key={`${n.id}-${moveVersions.current.get(n.id) ?? 0}`} note={n} initialPos={notePositions.get(n.id)!} members={members} meId={meId} onChange={invalidate} onOpen={setEditing}
            isUnread={unreadNoteIds.has(n.id)} onRead={() => dismissNoteAlerts(n.id)}
            selectMode={selectMode} selected={selectedIds.has(n.id)} onToggleSelect={() => toggleSelected(n.id)} />
        ))}
      </div>

      {/* DESKTOP: select-mode toolbar — Move (reposition together, stay on screen) or
          Park (send to the shelf), your choice once you've picked which notes. */}
      {selectMode && (
        <div className="hidden lg:flex fixed bottom-4 left-4 z-[46] items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg">
          <span>{selectedIds.size} selected</span>
          <button
            onClick={moveSelected}
            disabled={selectedIds.size === 0}
            className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 font-medium hover:bg-white/20 disabled:opacity-40"
          >
            <Move className="h-3.5 w-3.5" />
            Move
          </button>
          <button
            onClick={parkSelected}
            disabled={selectedIds.size === 0 || parking}
            className="flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 font-medium text-amber-950 disabled:opacity-40"
          >
            {parking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pin className="h-3.5 w-3.5" />}
            Park
          </button>
          <button onClick={exitSelectMode} disabled={parking} className="rounded-full bg-white/10 px-3 py-1 hover:bg-white/20 disabled:opacity-40">Cancel</button>
        </div>
      )}

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

      {/* DESKTOP: + button, bottom-left. Draggable (double-click resets), unchanged —
          only its click now opens a small menu (New note / Select notes) instead of
          jumping straight to composing (Antonio, 2026-09-08: fold the select toggle
          into the "+" instead of a separate icon cluttering the corner). Hidden during
          select mode — the toolbar above takes this corner instead. */}
      {!selectMode && (
        <>
          {fabMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFabMenuOpen(false)} />
              {/* Anchored to the BUTTON'S OWN measured position, not a fixed corner
                  (Bug Hunter, 2026-09-08: the button has been draggable since
                  2026-07-23 — its own tooltip says so below — but this menu used to
                  render at the untouched default corner regardless, so a dragged
                  button opened a menu nowhere near it). menuAnchor is null until the
                  button has actually moved, so the untouched default case keeps using
                  the plain CSS corner below — unchanged. */}
              <div
                className="hidden lg:flex fixed bottom-[4.75rem] left-4 z-50 w-48 flex-col gap-1 rounded-lg border bg-white p-2 shadow-lg"
                style={menuAnchor ?? undefined}
              >
                <button
                  onClick={() => { setFabMenuOpen(false); setComposing(true) }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Plus className="h-4 w-4" /> New note
                </button>
                {notes.length > 1 && (
                  <button
                    onClick={() => { setFabMenuOpen(false); setSelectMode(true) }}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <CheckSquare className="h-4 w-4" /> Select notes
                  </button>
                )}
              </div>
            </>
          )}
          <FastTooltip label="New note, or select several — drag to move, double-click to reset" align="left">
            <button
              ref={deskFab.ref}
              {...deskFab.dragProps}
              style={deskFab.style}
              onClick={() => { if (!deskFab.dragging) setFabMenuOpen((v) => !v) }}
              className="hidden lg:flex fixed bottom-4 left-4 z-[45] h-11 w-11 touch-none items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-lg hover:bg-amber-300"
              aria-label="New note or select notes"
            >
              <Plus className="h-5 w-5" />
            </button>
          </FastTooltip>
        </>
      )}

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
        onClick={() => {
          if (mobileFab.dragging) return
          setSheetOpen(true)
          // Opening the sheet already reveals every note's full preview text — the phone
          // has no separate collapsed-icon step to click through, so opening IS reading
          // (Antonio, 2026-09-05: the phone should behave the same as the desktop icons).
          for (const n of notes) if (unreadNoteIds.has(n.id)) dismissNoteAlerts(n.id)
        }}
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
          unreadNoteIds={unreadNoteIds}
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

/**
 * Collapsed by default — a small icon, always on screen, draggable anywhere out of the
 * way. Click expands it in place to the full card; a Minimize button on the card
 * collapses it back (Antonio, 2026-09-05: "reduce it in icon but always visible to open
 * when we need" — full cards were landing on top of the sidebar nav, see note-position.ts
 * cascadePos starting near the top-left corner).
 *
 * Click vs. drag uses the same measured-distance threshold as the draggable FAB buttons
 * (isDragGesture) and the same ref-based (not state-based) click suppression — a past bug
 * here let a drag also OPEN the thing being dragged because suppression was React state,
 * captured stale at click time. A ref reads current at call time.
 *
 * Position comes from notePosStyle(pos, size), which clears the sticky desktop header
 * (h-14 = 3.5rem, z-30) and the sidebar, AND keeps the note on-screen on the opposite
 * (right/bottom) edge too — see notePosStyle's own comment for the full history. It's
 * CSS-only — the stored/dragged fraction itself is untouched, so a manually-dragged note
 * still tracks the cursor exactly; only where it's allowed to visually render is bounded.
 */
function DesktopNote({ note, initialPos, members, meId, onChange, onOpen, isUnread, onRead, selectMode, selected, onToggleSelect }: {
  note: Note; initialPos: FracPos; members: Member[]; meId: string | null; onChange: () => void; onOpen: (n: Note) => void; isUnread: boolean; onRead: () => void
  selectMode: boolean; selected: boolean; onToggleSelect: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  // initialPos was already resolved once, for every note together (stored spot, or the
  // first free cascade slot) — see notePositions in the parent. Only the FIRST value
  // React sees here matters; later re-renders (including notePositions recomputing when
  // a sibling note is added) must not silently teleport an already-open note.
  const [pos, setPos] = useState<{ x: number; y: number }>(initialPos)
  const [expanded, setExpanded] = useState(false)
  // Purely a RENDER-time offset on top of `pos` — never persisted, never fed back into
  // `pos` itself — applied only when expanding lands the card on top of a neighbor
  // already on screen. See the layout effect below.
  const [nudge, setNudge] = useState({ dx: 0, dy: 0 })
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)

  const onPointerDown = (e: React.PointerEvent) => {
    if (selectMode) return // no dragging while selecting — a click here only toggles the checkbox
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    if (nudge.dx || nudge.dy) setNudge({ dx: 0, dy: 0 }) // a manual drag always wins over the auto-nudge
    const rect = ref.current!.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, moved: false }
    ref.current!.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (selectMode) return
    const d = drag.current
    if (!d) return
    if (!d.moved && !isDragGesture(e.clientX - d.startX, e.clientY - d.startY)) return
    d.moved = true
    // Invert notePosStyle's OWN render-time shift before storing — see horizontalShiftPx's
    // own comment. Without this, the note jumps by a fixed offset the instant a drag
    // starts, and the cursor (which IS the mouse) reads as permanently detached from it.
    const size = expanded ? EXPANDED_SIZE_REM : COLLAPSED_SIZE_REM
    const x = clampFrac((e.clientX - d.dx - horizontalShiftPx(window.innerWidth, size.width)) / window.innerWidth)
    const y = clampFrac((e.clientY - d.dy - verticalShiftPx(window.innerHeight)) / window.innerHeight)
    setPos({ x, y })
  }
  const onPointerUp = () => {
    if (selectMode) return
    const d = drag.current
    drag.current = null
    if (d?.moved) {
      writePosition(note.id, pos)
      justDragged.current = true
      // Swallow the click that fires right after releasing a drag — otherwise
      // dropping the icon also opens it.
      setTimeout(() => { justDragged.current = false }, 0)
    }
  }
  const onClickCollapsed = () => {
    if (selectMode) { onToggleSelect(); return }
    if (justDragged.current) return
    setNudge({ dx: 0, dy: 0 }) // re-measure fresh every time, never carry a stale nudge in
    setExpanded(true)
    // Expanding to the full preview text IS reading it (Antonio, 2026-09-05: red
    // until read, back to normal once it is) — no separate "mark read" action.
    if (isUnread) onRead()
  }

  /**
   * THE FIX for "when i open one it doesn't move away from the others... one on top the
   * other" (Antonio, 2026-09-07, re-hit and re-flagged 2026-09-08): expanding a note only
   * ever positioned itself from its OWN stored fraction — it never checked whether the
   * much bigger expanded card would land on a NEIGHBOR already sitting on screen (trivial
   * to hit once several notes are cascaded close together, which position-loss on reload,
   * fixed above, made the common case rather than a rare one).
   *
   * Runs AFTER the browser has laid out the just-expanded card at its natural (un-nudged)
   * position — `useLayoutEffect` so this resolves before the user sees a flash of the
   * overlapping frame. Measures real DOM rects (every other on-screen note, collapsed or
   * expanded, tagged `data-note-id`) rather than re-deriving the CSS clamp() math in JS,
   * which would be a second copy of notePosStyle's own logic to keep in sync. Pushes
   * straight down, in fixed steps, until clear of every neighbor it currently overlaps —
   * simple and bounded rather than a full free-slot search, and always resettable: a
   * manual drag (onPointerDown, above) or a fresh expand (onClickCollapsed, above) clears
   * it back to zero, so the offset never compounds across repeated open/close cycles.
   * Never written to `pos` / localStorage — purely how this ONE open session renders.
   */
  useLayoutEffect(() => {
    if (!expanded || selectMode) return
    const el = ref.current
    if (!el) return
    const STEP = 48
    const MAX_STEPS = 20
    const EDGE_MARGIN = 16
    const natural = el.getBoundingClientRect()
    // The bottom-edge bound folded INTO the search, not applied after — clamping an
    // already-decided `dy` after the fact (the original version of this fix) picks a
    // value that was never actually tested for collisions, so on a short viewport with
    // several notes already clustered near the bottom it could silently reintroduce the
    // exact overlap this effect exists to prevent (Bug Hunter, 2026-09-08). Every
    // candidate `dy` this loop settles on has been checked; run out of room and it
    // stops at the last checked, on-screen value — a real best effort, not a guess.
    const maxDy = Math.max(0, window.innerHeight - EDGE_MARGIN - natural.bottom)
    const collidesAt = (dy: number) => {
      const test = { top: natural.top + dy, bottom: natural.bottom + dy, left: natural.left, right: natural.right }
      let collided = false
      document.querySelectorAll<HTMLElement>('[data-note-id]').forEach((sib) => {
        if (sib === el || sib.dataset.noteId === note.id) return
        const r = sib.getBoundingClientRect()
        if (test.left < r.right && test.right > r.left && test.top < r.bottom && test.bottom > r.top) collided = true
      })
      return collided
    }
    let dy = 0
    for (let i = 0; i < MAX_STEPS && collidesAt(dy) && dy < maxDy; i++) {
      dy = Math.min(dy + STEP, maxDy)
    }
    if (dy > 0) setNudge({ dx: 0, dy })
    // Deliberately only on `expanded` toggling on — re-running on every render would
    // fight a manual drag (which sets `pos`, not `nudge`) and re-trigger a nudge search
    // against the card's OWN just-nudged position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, selectMode])

  // Select mode shows every note as a compact, checkable chip regardless of its own
  // expanded/collapsed state — a clean list to tick, rather than making "which part of
  // an open card selects vs. opens it" a judgment call for every note shape.
  if (!expanded || selectMode) {
    const preview = note.body.replace(/\s+/g, ' ').trim().slice(0, 80)
    // A short, always-visible snippet next to the icon (Antonio, 2026-09-05: "a short
    // description at the button what it is about") — shorter than the tooltip's preview,
    // and truncated with CSS rather than pre-cut so it never clips a whole word for no
    // reason on a wider snippet. The tooltip (full 80-char preview) still covers anything
    // this snippet itself truncates.
    const snippet = preview.slice(0, 40)
    return (
      <FastTooltip label={selectMode ? preview : (isUnread ? `New: ${preview}` : preview)} align="left">
        <button
          ref={ref as React.RefObject<HTMLButtonElement>}
          data-note-id={note.id}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onClick={onClickCollapsed}
          style={notePosStyle(pos, COLLAPSED_SIZE_REM)}
          className={`fixed z-[45] flex h-10 max-w-[180px] items-center gap-1.5 rounded-full border px-3 shadow-lg ${selectMode ? 'cursor-pointer' : 'touch-none cursor-grab active:cursor-grabbing'} ${selectMode && selected ? 'ring-2 ring-offset-1 ring-blue-500' : ''} ${noteBgClasses(note, isUnread)}`}
          aria-label={`${isUnread ? 'New note' : 'Note'}: ${preview}${selectMode ? (selected ? ', selected' : ', not selected') : ''}`}
        >
          {selectMode && (
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? 'border-blue-600 bg-blue-600 text-white' : 'border-current bg-white/40'}`}>
              {selected && <Check className="h-3 w-3" />}
            </span>
          )}
          <StickyNote className="h-4 w-4 shrink-0" />
          <span className="truncate text-xs font-medium">{snippet}</span>
        </button>
      </FastTooltip>
    )
  }

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      data-note-id={note.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        ...notePosStyle(pos, EXPANDED_SIZE_REM),
        transform: nudge.dx || nudge.dy ? `translate(${nudge.dx}px, ${nudge.dy}px)` : undefined,
      }}
      className={`fixed z-[45] w-60 cursor-grab active:cursor-grabbing rounded-md border shadow-lg ${noteBgClasses(note, isUnread)}`}
    >
      <NoteCardBody note={note} members={members} meId={meId} onChange={onChange} onOpen={onOpen} onCollapse={() => setExpanded(false)} />
    </div>
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
        <p
          data-no-drag
          onClick={() => onOpen?.(note)}
          title="Open"
          className="cursor-pointer whitespace-pre-wrap break-words text-sm leading-snug line-clamp-6 hover:underline"
        >
          <LinkifiedText text={note.body} />
        </p>
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

function MobileSheet({ notes, members, meId, onClose, onNew, onChange, onOpen, unreadNoteIds }: {
  notes: Note[]; members: Member[]; meId: string | null; onClose: () => void; onNew: () => void; onChange: () => void; onOpen: (n: Note) => void
  unreadNoteIds: Set<string>
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
            <div key={n.id} className={`rounded-md border ${noteBgClasses(n, unreadNoteIds.has(n.id))}`}>
              <NoteCardBody note={n} members={members} meId={meId} onChange={onChange} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
