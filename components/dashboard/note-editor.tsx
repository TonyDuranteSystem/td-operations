'use client'

/**
 * Note editor — the ONE place a note is opened, changed, AND CREATED, shared by every surface
 * (floating card, Notes list, calendar day, portal-chats "Make a note", Inbox "Note" button).
 * Before this existed a note could be created and acted on but never re-read or re-worded,
 * which is what Antonio hit: "Now I can't do anything." Since 2026-07-29 creating a note opens
 * this same full editor (text, client, come-back date, who's it for) instead of a mini popup.
 *
 * Two modes:
 *  - EDIT  (note != null): everything goes through the existing note API actions.
 *  - CREATE (note == null): everything is buffered locally and ONE create call fires on Save —
 *    there is no note id yet, so immediate actions would be meaningless (and used to 400).
 *
 * Rules learned the hard way (2026-07-28 incident — Luca's lost reply):
 *  - Typed text is SAVED FIRST before any one-click action runs; if that save fails the
 *    action is aborted and the text stays on screen. Never fire an action over a dirty body.
 *  - After a successful save the working baseline (body + timestamp) refreshes from the
 *    server response — otherwise the next Save trips the stale-edit guard on OUR OWN save.
 *  - Only the AUTHOR sees the "who can see it" buttons. A recipient "sharing back" is what
 *    silently rewrote the recipient slot and made the note vanish for them.
 */

import { useState } from 'react'
import { X, Loader2, Check, Lock, Share2, Users, RotateCcw, MessageSquare, Trash2, ExternalLink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { requestOpenTeamChat } from '@/lib/team/open-team-chat'
import { safeOriginPath, describeOrigin } from '@/lib/notes/note-origin'
import { isArchivedFor } from '@/lib/notes/staff-notes'

const API = '/api/crm/staff-notes'

export interface EditableNote {
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
  updated_at: string
  staff_note_state?: Array<{ user_id: string; archived_at: string | null; snoozed_until: string | null }> | null
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}
export interface Member { id: string; name: string }

/** Prefill for CREATE mode — where the note starts from (page subject, quoted text, origin). */
export interface CreateDefaults {
  body?: string
  accountId?: string
  accountName?: string
  contactId?: string
  originUrl?: string
  recipient?: string // 'me' | 'team' | staff user id
}

/** A stored instant → the value a datetime-local input expects (LOCAL time, not UTC). */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The come-back moment as the creator sees it — sent along for the recipient's push text. */
function humanWhen(local: string): string {
  const d = new Date(local)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function NoteEditor({
  note, members, meId, onClose, onChanged, createDefaults,
}: {
  /** null = CREATE mode (full editor as the creation UI). */
  note: EditableNote | null
  members: Member[]
  /** My auth user id — decides whether the author-only controls render. Fail-closed: unknown = hidden. */
  meId?: string | null
  onClose: () => void
  onChanged: () => void
  createDefaults?: CreateDefaults
}) {
  const isCreate = note === null
  // MY come-back date lives in the per-person state row (since 2026-07-23); the note's own
  // column is the frozen legacy fallback. Without this the field shows empty on a note that
  // very much has a date — found in the 2026-07-29 sandbox QA.
  const myStateRow = note && meId ? (note.staff_note_state ?? []).find((r) => r.user_id === meId) ?? null : null
  const myWhenIso = note ? (myStateRow ? myStateRow.snoozed_until : note.snoozed_until) : null
  const [body, setBody] = useState(note?.body ?? createDefaults?.body ?? '')
  const [when, setWhen] = useState(toLocalInputValue(myWhenIso))
  const [accountId, setAccountId] = useState<string | undefined>(note?.account_id ?? createDefaults?.accountId)
  const [accountName, setAccountName] = useState<string | undefined>(
    note?.accounts?.company_name ?? note?.contacts?.full_name ?? createDefaults?.accountName,
  )
  const [recipient, setRecipient] = useState<string>(createDefaults?.recipient ?? 'me')
  // EDIT mode working baseline: what the server currently has, refreshed after every save we
  // make — the stale-edit guard compares against THIS, so it must move with our own writes.
  const [baseline, setBaseline] = useState<{ body: string; updated_at: string }>(
    () => ({ body: note?.body ?? '', updated_at: note?.updated_at ?? '' }),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [discussing, setDiscussing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const router = useRouter()

  const isAuthor = !isCreate && meId != null && meId === note.author_user_id
  const dirty = !isCreate && body.trim() !== baseline.body
  const archivedForMe = !isCreate && (meId ? isArchivedFor(note, meId) : note.archived_at != null)
  const origin = !isCreate && note.origin_url ? safeOriginPath(note.origin_url) : null

  /** Open the chat about this note — the client's conversation, or the teammate DM. */
  const discuss = async () => {
    if (isCreate) return
    setDiscussing(true); setErr(null)
    try {
      const res = await fetch(`${API}/discuss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: note.id }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not open a chat for this note.')
      }
      const { threadId, draft } = await res.json()
      if (!requestOpenTeamChat({ threadId, draft })) router.push(`/team-chat?thread=${threadId}`)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open a chat for this note.')
      setDiscussing(false)
    }
  }

  /** Delete the note COMPLETELY (for everyone) — author-only, enforced server-side.
   *  Distinct from "Mark done", which only clears it from your own screen. */
  const del = async () => {
    if (isCreate) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${API}?id=${note.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not delete the note.')
      }
      onChanged(); onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete the note.')
      setBusy(false)
    }
  }

  /** One PATCH action; returns the server's row so callers can refresh the baseline. */
  const call = async (payload: Record<string, unknown>) => {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note!.id, ...payload }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(d.error || "That didn't work — try again.")
    return d
  }

  /**
   * Persist a dirty body BEFORE anything else happens. Returns true when it's safe to
   * continue. `suppressNotify` keeps the auto-save quiet when the very next action changes
   * who sees the note — the new text must not be pushed to someone about to lose access.
   */
  const saveBodyIfDirty = async (suppressNotify: boolean): Promise<boolean> => {
    if (!dirty) return true
    const d = await call({
      action: 'edit', body,
      expectedUpdatedAt: baseline.updated_at,
      ...(suppressNotify ? { suppress_notify: true } : {}),
    })
    const fresh = d?.note
    setBaseline({ body: body.trim(), updated_at: fresh?.updated_at ?? baseline.updated_at })
    return true
  }

  /** Save the text, the client and the date together — one Save, as Antonio asked. */
  const saveAll = async () => {
    setBusy(true); setErr(null)
    try {
      if (isCreate) {
        if (!body.trim()) throw new Error('A note needs some text.')
        const subject = accountId
          ? { account_id: accountId }
          : createDefaults?.contactId
            ? { contact_id: createDefaults.contactId }
            : {}
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body,
            recipient,
            origin_url: createDefaults?.originUrl
              ?? (typeof window !== 'undefined' ? window.location.pathname + window.location.search : undefined),
            ...(when ? { come_back: new Date(when).toISOString(), come_back_display: humanWhen(when) } : {}),
            ...subject,
          }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d.error || 'Could not save — your text is still here, try again.')
        onChanged()
        onClose()
        // Partial success (note saved, date failed) is said out loud, never swallowed.
        if (d.warning) alert(d.warning)
        return
      }

      await saveBodyIfDirty(false)
      if ((accountId ?? null) !== note.account_id) {
        await call({ action: 'set_client', account_id: accountId ?? null })
      }
      const currentWhen = toLocalInputValue(myWhenIso)
      if (when !== currentWhen) {
        if (!when) {
          await call({ action: 'unsnooze' })
        } else {
          const d = new Date(when)
          if (isNaN(d.getTime())) throw new Error("That date didn't make sense.")
          await call({ action: 'snooze', preset: 'custom', custom: d.toISOString() })
        }
      }
      onChanged(); onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work — try again.")
      setBusy(false) // keep what was typed
    }
  }

  /**
   * One-click actions (share / visibility / done). A dirty body is saved FIRST; if that
   * fails, the action is ABORTED and the text stays — clicking a button must never cost
   * typed words (the 2026-07-28 lost-reply bug).
   */
  const quick = async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null)
    try {
      const changesVisibility = payload.action === 'share' || payload.action === 'team' || payload.action === 'private'
      await saveBodyIfDirty(changesVisibility)
      await call(payload)
      onChanged(); onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work."); setBusy(false)
    }
  }

  const openOrigin = () => {
    if (!origin) return
    onClose()
    router.push(origin)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-xl bg-amber-50 p-4 shadow-2xl sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-amber-950">{isCreate ? 'New note' : 'Note'}</span>
          <button onClick={onClose} className="rounded p-1 hover:bg-black/10" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-1 block text-xs font-medium text-amber-900">Note</label>
        <textarea
          autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000}
          placeholder="e.g. call IRS about the EIN"
          className="mb-3 h-32 w-full resize-none rounded border border-amber-300 bg-white p-2 text-sm text-amber-950 outline-none focus:border-amber-500"
        />

        {/* Where this note came from — the email / chat / page it was written on. */}
        {origin && (
          <button
            onClick={openOrigin}
            className="mb-3 flex items-center gap-1 rounded bg-black/5 px-2 py-1 text-xs text-amber-900 hover:bg-black/10"
            title={origin}
          >
            <ExternalLink className="h-3 w-3" />
            From: {describeOrigin(origin)}
          </button>
        )}

        <label className="mb-1 block text-xs font-medium text-amber-900">About a client</label>
        <div className="mb-3">
          <AccountCombobox
            value={accountId}
            displayValue={accountName}
            onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
            placeholder="Search company or person…"
          />
        </div>

        {/* Date AND time, saved only when Save is pressed — picking a date no longer fires. */}
        <label className="mb-1 block text-xs font-medium text-amber-900">Comes back on</label>
        <div className="mb-1 flex items-center gap-2">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-sm"
          />
          {when && (
            <button onClick={() => setWhen('')} className="shrink-0 rounded border border-amber-300 px-2 py-1.5 text-xs hover:bg-black/5">
              Clear
            </button>
          )}
        </div>
        <p className="mb-3 text-xs text-amber-800/70">
          {isCreate && recipient !== 'me'
            ? 'Leave empty to keep it on the screen now. With a date, it appears for everyone on that day.'
            : 'Leave empty to keep it on your screen.'}
        </p>

        {/* CREATE: who's it for, chosen up-front and sent with the one Save. */}
        {isCreate && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-amber-900">Who can see it</label>
            <div className="flex flex-wrap gap-1 text-xs">
              <button onClick={() => setRecipient('me')}
                className={`flex items-center gap-1 rounded px-2 py-1 ${recipient === 'me' ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                <Lock className="h-3 w-3" />Only me
              </button>
              {members.map((m) => (
                <button key={m.id} onClick={() => setRecipient(m.id)}
                  className={`flex items-center gap-1 rounded px-2 py-1 ${recipient === m.id ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                  <Share2 className="h-3 w-3" />{m.name}
                </button>
              ))}
              <button onClick={() => setRecipient('team')}
                className={`flex items-center gap-1 rounded px-2 py-1 ${recipient === 'team' ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                <Users className="h-3 w-3" />Team
              </button>
            </div>
          </div>
        )}

        {err && <p className="mb-2 text-xs text-red-700">{err}</p>}

        <div className="mb-3 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded border border-amber-300 px-3 py-2 text-sm hover:bg-black/5">
            Cancel
          </button>
          <button
            onClick={saveAll} disabled={busy || (isCreate && !body.trim())}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-amber-400 px-3 py-2 text-sm font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>

        {!isCreate && (
          <div className="border-t border-amber-200 pt-3">
            {/* WHO SEES IT is the author's call alone (2026-07-28: a recipient "sharing back"
                overwrote the recipient slot and vanished the note for themselves). Recipients
                get a plain statement instead of buttons that would only 403. */}
            {isAuthor ? (
              <>
                <p className="mb-2 text-xs font-medium text-amber-900">Who can see it</p>
                <div className="mb-3 flex flex-wrap gap-1 text-xs">
                  <button onClick={() => quick({ action: 'private' })} disabled={busy}
                    className={`flex items-center gap-1 rounded px-2 py-1 ${note.visibility === 'private' ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                    <Lock className="h-3 w-3" />Only me
                  </button>
                  {members.map((m) => (
                    <button key={m.id} onClick={() => quick({ action: 'share', shared_with_user_id: m.id })} disabled={busy}
                      className={`flex items-center gap-1 rounded px-2 py-1 ${note.shared_with_user_id === m.id ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                      <Share2 className="h-3 w-3" />{m.name}
                    </button>
                  ))}
                  <button onClick={() => quick({ action: 'team' })} disabled={busy}
                    className={`flex items-center gap-1 rounded px-2 py-1 ${note.visibility === 'team' ? 'bg-amber-400 text-amber-950' : 'bg-black/10'}`}>
                    <Users className="h-3 w-3" />Team
                  </button>
                </div>
              </>
            ) : (
              <p className="mb-3 flex items-center gap-1 text-xs text-amber-800/80">
                {note.visibility === 'team' ? <Users className="h-3 w-3" /> : <Share2 className="h-3 w-3" />}
                {note.visibility === 'team' ? 'Team note' : 'Shared with you'}
                {note.author_name ? ` by ${note.author_name}` : ''} — type your answer and press Save; they&apos;ll be notified.
              </p>
            )}

            <div className="flex items-center gap-2">
              {archivedForMe
                ? <button onClick={() => quick({ action: 'unarchive' })} disabled={busy}
                    className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs">
                    <RotateCcw className="h-3 w-3" />Put it back
                  </button>
                : <button onClick={() => quick({ action: 'archive' })} disabled={busy}
                    className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs">
                    <Check className="h-3 w-3" />Mark done
                  </button>}

              <button onClick={discuss} disabled={discussing || busy}
                className="flex items-center gap-1 rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-200 disabled:opacity-50">
                {discussing ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                Discuss
              </button>

              {/* Delete COMPLETELY — for everyone, author-only (server-enforced; hidden for
                  recipients so it's never a dead click). Two taps: a deleted note doesn't
                  come back, unlike Done which is per-person. */}
              {isAuthor && (confirmDelete ? (
                <button onClick={del} disabled={busy}
                  className="ml-auto flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Delete forever?
                </button>
              ) : (
                <button onClick={() => setConfirmDelete(true)} disabled={busy}
                  className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                  <Trash2 className="h-3 w-3" />Delete
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
