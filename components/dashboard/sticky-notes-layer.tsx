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
import { StickyNote, Plus, X, Clock, Share2, Check, Loader2, Users, Lock, Building2 } from 'lucide-react'
import { readPositions, writePosition, prunePositions, cascadePos, clampFrac } from '@/lib/notes/note-position'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { NoteEditor } from '@/components/dashboard/note-editor'

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

  const [composing, setComposing] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)

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
          <DesktopNote key={n.id} note={n} index={i} members={members} onChange={invalidate} onOpen={setEditing} />
        ))}
      </div>

      {/* Composer (both desktop + mobile) */}
      {composing && <Composer onClose={() => setComposing(false)} onCreated={invalidate} />}

      {/* DESKTOP: + button, bottom-left */}
      <button
        onClick={() => setComposing(true)}
        className="hidden lg:flex fixed bottom-4 left-4 z-[45] h-11 w-11 items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-lg hover:bg-amber-300"
        title="New note"
        aria-label="New note"
      >
        <Plus className="h-5 w-5" />
      </button>

      {/* MOBILE: a pill (bottom-left) that opens a sheet */}
      <button
        onClick={() => setSheetOpen(true)}
        className="lg:hidden fixed bottom-4 left-4 z-[45] flex items-center gap-2 rounded-full bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950 shadow-lg"
      >
        <StickyNote className="h-4 w-4" />
        {notes.length > 0 ? notes.length : 'Notes'}
      </button>

      {sheetOpen && (
        <MobileSheet
          notes={notes}
          members={members}
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
          onClose={() => setEditing(null)}
          onChanged={invalidate}
        />
      )}
    </>
  )
}

/* ─────────────────────────── desktop draggable note ─────────────────────────── */

function DesktopNote({ note, index, members, onChange, onOpen }: { note: Note; index: number; members: Member[]; onChange: () => void; onOpen: (n: Note) => void }) {
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
      <NoteCardBody note={note} members={members} onChange={onChange} onOpen={onOpen} />
    </div>
  )
}

/* ─────────────────────────── shared card body + actions ─────────────────────────── */

function NoteCardBody({ note, members, onChange, onOpen }: { note: Note; members: Member[]; onChange: () => void; onOpen?: (n: Note) => void }) {
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<'none' | 'snooze' | 'share'>('none')
  const [err, setErr] = useState<string | null>(null)
  // held until Save — see the picker below
  const [customWhen, setCustomWhen] = useState('')

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

      <div className="mt-2 flex items-center gap-1 text-xs opacity-70">
        {note.visibility === 'private' && <Lock className="h-3 w-3" />}
        {note.visibility === 'shared' && <><Share2 className="h-3 w-3" />{note.shared_with_name}</>}
        {note.visibility === 'team' && <><Users className="h-3 w-3" />Team</>}
        <span className="ml-auto flex gap-1">
          <button data-no-drag onClick={() => setMenu(menu === 'snooze' ? 'none' : 'snooze')}
            className="rounded p-0.5 hover:bg-black/10" title="Snooze"><Clock className="h-3.5 w-3.5" /></button>
          <button data-no-drag onClick={() => setMenu(menu === 'share' ? 'none' : 'share')}
            className="rounded p-0.5 hover:bg-black/10" title="Share"><Share2 className="h-3.5 w-3.5" /></button>
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

      {menu === 'share' && (
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

/* ─────────────────────────── composer ─────────────────────────── */

function Composer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Pre-fill with the company whose page you're on; you can change or clear it.
  const fromPage = subjectFromPath()
  const [accountId, setAccountId] = useState<string | undefined>(fromPage.account_id)
  const [accountName, setAccountName] = useState<string | undefined>(undefined)

  const save = async () => {
    if (!body.trim()) { onClose(); return }
    setBusy(true); setErr(null)
    try {
      // an explicitly picked company wins; otherwise fall back to whatever the page implied
      const subject = accountId ? { account_id: accountId } : fromPage
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, origin_url: window.location.pathname, ...subject }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save — try again.')
      }
      onCreated(); onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save — your text is still here, try again.')
      setBusy(false) // keep the text on failure — never lose what was typed
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-sm rounded-t-xl sm:rounded-xl bg-amber-100 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-amber-950">New note</span>
          <button onClick={onClose} className="rounded p-1 hover:bg-black/10"><X className="h-4 w-4" /></button>
        </div>
        <textarea
          autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000}
          placeholder="e.g. call IRS about the EIN"
          className="h-28 w-full resize-none rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 outline-none focus:border-amber-500"
        />
        <div className="mt-2">
          <label className="mb-1 block text-xs font-medium text-amber-900">About a client (optional)</label>
          <AccountCombobox
            value={accountId}
            displayValue={accountName}
            onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
            placeholder="Search company or person…"
          />
        </div>
        {err && <p className="mt-1 text-xs text-red-700">{err}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-amber-900 hover:bg-black/10">Cancel</button>
          <button onClick={save} disabled={busy}
            className="flex items-center gap-1 rounded bg-amber-400 px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-60">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Stick it
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── mobile bottom sheet ─────────────────────────── */

function MobileSheet({ notes, members, onClose, onNew, onChange, onOpen }: {
  notes: Note[]; members: Member[]; onClose: () => void; onNew: () => void; onChange: () => void; onOpen: (n: Note) => void
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
              <NoteCardBody note={n} members={members} onChange={onChange} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
