'use client'

/**
 * Note editor — the ONE place a note is opened and changed, shared by every surface
 * (floating card, Notes list, calendar day). Before this existed a note could be created and
 * acted on but never re-read or re-worded, which is what Antonio hit: "Now I can't do anything."
 *
 * Everything here goes through the existing note API actions — no new endpoints.
 */

import { useState } from 'react'
import { X, Loader2, Check, Lock, Share2, Users, RotateCcw } from 'lucide-react'
import { AccountCombobox } from '@/components/shared/account-combobox'

const API = '/api/crm/staff-notes'

export interface EditableNote {
  id: string
  body: string
  color: string
  visibility: 'private' | 'shared' | 'team'
  shared_with_user_id: string | null
  shared_with_name: string | null
  account_id: string | null
  contact_id: string | null
  snoozed_until: string | null
  archived_at: string | null
  updated_at: string
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
}
export interface Member { id: string; name: string }

/** A stored instant → the value a datetime-local input expects (LOCAL time, not UTC). */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function NoteEditor({
  note, members, onClose, onChanged,
}: {
  note: EditableNote
  members: Member[]
  onClose: () => void
  onChanged: () => void
}) {
  const [body, setBody] = useState(note.body)
  const [when, setWhen] = useState(toLocalInputValue(note.snoozed_until))
  const [accountId, setAccountId] = useState<string | undefined>(note.account_id ?? undefined)
  const [accountName, setAccountName] = useState<string | undefined>(
    note.accounts?.company_name ?? note.contacts?.full_name ?? undefined,
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const call = async (payload: Record<string, unknown>) => {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id, ...payload }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error || "That didn't work — try again.")
    }
  }

  /** Save the text, the client and the date together — one Save, as Antonio asked. */
  const saveAll = async () => {
    setBusy(true); setErr(null)
    try {
      if (body.trim() !== note.body) {
        await call({ action: 'edit', body, expectedUpdatedAt: note.updated_at })
      }
      if ((accountId ?? null) !== note.account_id) {
        await call({ action: 'set_client', account_id: accountId ?? null })
      }
      const currentWhen = toLocalInputValue(note.snoozed_until)
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

  const quick = async (payload: Record<string, unknown>) => {
    setBusy(true); setErr(null)
    try { await call(payload); onChanged(); onClose() }
    catch (e) { setErr(e instanceof Error ? e.message : "That didn't work."); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-xl bg-amber-50 p-4 shadow-2xl sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-amber-950">Note</span>
          <button onClick={onClose} className="rounded p-1 hover:bg-black/10" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-1 block text-xs font-medium text-amber-900">Note</label>
        <textarea
          autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000}
          className="mb-3 h-32 w-full resize-none rounded border border-amber-300 bg-white p-2 text-sm text-amber-950 outline-none focus:border-amber-500"
        />

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
        <p className="mb-3 text-xs text-amber-800/70">Leave empty to keep it on your screen.</p>

        {err && <p className="mb-2 text-xs text-red-700">{err}</p>}

        <div className="mb-3 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded border border-amber-300 px-3 py-2 text-sm hover:bg-black/5">
            Cancel
          </button>
          <button
            onClick={saveAll} disabled={busy}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-amber-400 px-3 py-2 text-sm font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>

        <div className="border-t border-amber-200 pt-3">
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

          {note.archived_at
            ? <button onClick={() => quick({ action: 'unarchive' })} disabled={busy}
                className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs">
                <RotateCcw className="h-3 w-3" />Put it back
              </button>
            : <button onClick={() => quick({ action: 'archive' })} disabled={busy}
                className="flex items-center gap-1 rounded bg-black/10 px-2 py-1 text-xs">
                <Check className="h-3 w-3" />Mark done
              </button>}
        </div>
      </div>
    </div>
  )
}
