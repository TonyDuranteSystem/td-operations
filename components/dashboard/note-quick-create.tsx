'use client'

/**
 * "Make a note" button — drop it on any surface that knows which client it's looking at
 * (a portal chat, an email thread) and it creates a post-it already tied to that client,
 * with a link back to the exact page it came from.
 *
 * Deliberately a plain shared button rather than a portal-chats catalog quick-action: the Inbox
 * cannot use that mechanism at all, and one component gives both surfaces identical behaviour.
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { StickyNote, Loader2, X } from 'lucide-react'

const API = '/api/crm/staff-notes'

/**
 * The dialog on its own, opened by the caller — so a dropdown menu item (portal-chats
 * per-message menu) can raise it without rendering a button of its own.
 */
export function NoteComposeDialog({
  accountId, contactId, prefill, onClose,
}: {
  accountId?: string | null
  contactId?: string | null
  prefill?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [body, setBody] = useState(prefill ? prefill.slice(0, 200) : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const save = async () => {
    if (!body.trim()) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body,
          account_id: accountId || undefined,
          contact_id: accountId ? undefined : contactId || undefined,
          // where it came from, so the note can take you back weeks later
          origin_url: typeof window !== 'undefined' ? window.location.pathname + window.location.search : undefined,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save the note — try again.')
      }
      qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
      qc.invalidateQueries({ queryKey: ['staff-notes-all'] })
      setDone(true)
      setTimeout(onClose, 700)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the note — try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
          <div
            className="w-full rounded-t-xl bg-amber-100 p-4 shadow-2xl sm:max-w-sm sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-amber-950">New note</span>
              <button onClick={onClose} className="rounded p-1 hover:bg-black/10" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <textarea
              autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000}
              placeholder="e.g. call IRS about the EIN"
              className="h-28 w-full resize-none rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 outline-none focus:border-amber-500"
            />

            {err && <p className="mt-1 text-xs text-red-700">{err}</p>}
            {done && <p className="mt-1 text-xs text-emerald-700">Stuck on your screen.</p>}

            <div className="mt-2 flex justify-end gap-2">
              <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-amber-900 hover:bg-black/10">
                Cancel
              </button>
              <button
                onClick={save} disabled={busy || !body.trim()}
                className="flex items-center gap-1 rounded bg-amber-400 px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-300 disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Stick it
              </button>
            </div>
      </div>
    </div>
  )
}

/** Button + dialog, for surfaces that want their own control (the Inbox email header). */
export function NoteQuickCreate({
  accountId, contactId, prefill, label = 'Note', className,
}: {
  accountId?: string | null
  contactId?: string | null
  prefill?: string
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Make a note about this"
        className={className ?? 'flex shrink-0 items-center gap-1 rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-amber-50'}
      >
        <StickyNote className="h-3.5 w-3.5" />{label}
      </button>
      {open && (
        <NoteComposeDialog
          accountId={accountId}
          contactId={contactId}
          prefill={prefill}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
