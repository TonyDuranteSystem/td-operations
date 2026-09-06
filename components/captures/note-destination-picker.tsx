'use client'

/**
 * "Share to..." step 5: attach the just-uploaded capture to a sticky note —
 * either one you already have, or a brand new one. Only shows YOUR OWN notes
 * (GET ?scope=mine) — there was no existing "pick one of my own notes"
 * screen to reuse (UX review, 2026-09-04), this is that new, bounded piece.
 * Team Chat as a second destination is a separate, later step.
 */
import { useEffect, useState } from 'react'
import { Loader2, StickyNote } from 'lucide-react'
import { attachCaptureToNote } from '@/lib/captures/share-actions'
import { addRecentDestination } from '@/lib/captures/recent-destinations'

interface MyNote {
  id: string
  body: string
  color: string
  created_at: string
}

export function NoteDestinationPicker({
  captureId,
  resend,
  onAttached,
  onError,
}: {
  captureId: string
  /** True for a deliberate re-share of a capture already sent once — see share-actions.ts. */
  resend?: boolean
  onAttached: () => void
  onError: (message: string) => void
}) {
  const [notes, setNotes] = useState<MyNote[] | null>(null)
  const [newNoteBody, setNewNoteBody] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/crm/staff-notes?scope=mine')
      .then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      .then((d) => {
        if (!cancelled) setNotes(Array.isArray(d.notes) ? d.notes : [])
      })
      .catch(() => {
        // A failed load used to look identical to "you have no notes"
        // (R099 violation, bug-hunter finding 2026-09-04) — surfaced through
        // the same onError this component already uses for save failures.
        if (!cancelled) onError('Could not load your notes. Please try again.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const attachTo = async (noteId: string, label: string) => {
    setBusy(true)
    try {
      await attachCaptureToNote(captureId, noteId, resend)
      addRecentDestination({ type: 'sticky_note', id: noteId, label })
      onAttached()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not attach the picture. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const createAndAttach = async () => {
    if (!newNoteBody.trim()) return
    setBusy(true)
    try {
      const createRes = await fetch('/api/crm/staff-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newNoteBody.trim() }),
      })
      if (!createRes.ok) {
        const d = await createRes.json().catch(() => ({}))
        throw new Error(d.error || 'Could not create the note. Please try again.')
      }
      const { note } = await createRes.json()
      await attachTo(note.id, newNoteBody.trim())
    } catch (err) {
      setBusy(false)
      onError(err instanceof Error ? err.message : 'Could not create the note. Please try again.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
        <StickyNote className="h-4 w-4" />
        Save to a sticky note
      </div>

      <div className="flex flex-col gap-2">
        <textarea
          value={newNoteBody}
          onChange={(e) => setNewNoteBody(e.target.value)}
          placeholder="Write a new note to attach this to..."
          rows={2}
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
        />
        <button
          onClick={() => void createAndAttach()}
          disabled={busy || !newNoteBody.trim()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {busy ? 'Saving...' : 'Create note & attach'}
        </button>
      </div>

      {notes === null ? (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your notes...
        </div>
      ) : notes.length === 0 ? (
        <p className="py-2 text-center text-xs text-zinc-400">You don&apos;t have any notes yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-zinc-400">Or attach to one of your own notes:</p>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {notes.map((n) => (
              <button
                key={n.id}
                onClick={() => void attachTo(n.id, n.body)}
                disabled={busy}
                className="truncate rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 disabled:opacity-40"
              >
                {n.body}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
