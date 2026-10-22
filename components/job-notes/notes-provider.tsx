'use client'

/**
 * Calendar team notes — the pop-up and the row pieces (dev job 388bb74b). Lives OUTSIDE components/new-calendar on purpose: the Calendar page is
 * read-only (a test pins it) and this is the one place that writes, through /api/job-notes/<job>.
 *
 * ONE pop-up for the whole list, held ABOVE the rows: the Calendar re-draws itself every minute and when a job moves, and a row can leave the
 * list while someone is typing. A pop-up that lived inside a row would close and lose the draft; this one belongs to the provider, so it does not.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { StickyNote, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { OpenInWindowLink } from '@/components/windows/open-in-window-link'
import { requestCreateNote } from '@/lib/notes/create-note'
import { NOTE_MAX, noteTimeLabel, notePreview, type JobNote } from '@/lib/job-notes/types'

export interface NoteTarget {
  id: string
  name: string
  serviceType: string
  stage: string
  accountId: string | null
  contactId: string | null
}

interface Ctx { open: (t: NoteTarget) => void }
const NotesContext = createContext<Ctx | null>(null)

export function JobNotesProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<NoteTarget | null>(null)
  const open = useCallback((t: NoteTarget) => setTarget(t), [])
  const value = useMemo(() => ({ open }), [open])
  return (
    <NotesContext.Provider value={value}>
      {children}
      {target && <NotesDialog key={target.id} target={target} onClose={() => setTarget(null)} />}
    </NotesContext.Provider>
  )
}

function NotesDialog({ target, onClose }: { target: NoteTarget; onClose: () => void }) {
  const router = useRouter()
  const [notes, setNotes] = useState<JobNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/job-notes/${target.id}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load the notes — please try again.')
      setNotes(data.notes ?? [])
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the notes — please try again.')
    }
  }, [target.id])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!draft.trim() || saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/job-notes/${target.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: draft }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'The note was not saved — please try again.')
      setNotes(data.notes ?? [])
      setDraft('')
      toast.success('Note added')
      // the row behind the pop-up shows the newest note straight away (the pop-up itself is not affected by the redraw)
      router.refresh()
    } catch (err) {
      // the draft stays in the box
      toast.error(err instanceof Error && err.message ? err.message : 'The note was not saved — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const makeSticky = () => {
    const body = draft.trim() || (notes && notes[0] ? notes[0].body : '')
    const handled = requestCreateNote({
      title: `${target.serviceType} — ${target.name}${target.stage ? ` — ${target.stage}` : ''}`,
      body,
      accountId: target.accountId ?? undefined,
      accountName: target.accountId || target.contactId ? target.name : undefined,
      contactId: target.accountId ? undefined : target.contactId ?? undefined,
      originUrl: `/flows/${target.id}`,
    } as Parameters<typeof requestCreateNote>[0])
    if (!handled) toast.error('Sticky notes are not available in this window. Open the Calendar in the main window to make one.')
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label={`Notes for ${target.name}`}>
        <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="text-base font-semibold">Notes — {target.name}, {target.serviceType}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="space-y-3 overflow-y-auto px-5 py-4">
            <p className="text-xs text-zinc-500">The team sees these notes on the Calendar row. They are never shown to the client.</p>
            <div>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={3}
                maxLength={NOTE_MAX}
                placeholder="Write a note for the team"
                aria-label="New note"
                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
              <div className="mt-2 flex items-center justify-between">
                <button type="button" onClick={makeSticky} className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline">
                  <StickyNote className="h-3.5 w-3.5" /> Make a sticky note from this
                </button>
                <button type="button" onClick={save} disabled={saving || !draft.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />} Add note
                </button>
              </div>
            </div>
            {loadError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                {loadError} <button type="button" onClick={() => void load()} className="underline">Try again</button>
              </div>
            )}
            {!loadError && notes === null && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading notes…</div>}
            {notes && notes.length === 0 && <p className="text-sm text-zinc-500">No notes yet.</p>}
            {notes && notes.length > 0 && (
              <ul className="divide-y rounded-md border">
                {notes.map(n => (
                  <li key={n.id} className="px-3 py-2">
                    <div className="text-xs text-zinc-500"><span className="font-medium text-zinc-700">{n.authorName}</span> · {noteTimeLabel(n.createdAt)}</div>
                    <div className="mt-0.5 whitespace-pre-wrap text-sm text-zinc-900">{n.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/** The note line of a Calendar row: the newest note and how many there are, or "Add note". Opens the pop-up. */
export function JobNoteCell({ target, count, last }: { target: NoteTarget; count: number; last: JobNote | null }) {
  const ctx = useContext(NotesContext)
  return (
    <button
      type="button"
      onClick={() => ctx?.open(target)}
      aria-label={`${count > 0 ? 'Notes' : 'Add a note'} for ${target.name}`}
      className="max-w-full truncate text-left text-xs text-zinc-600 hover:text-blue-700"
    >
      {last ? <><span className="mr-1 rounded bg-zinc-100 px-1.5 py-0.5 font-semibold text-zinc-700">{count}</span>{notePreview(last)}</> : <span className="text-zinc-400 hover:text-blue-700">+ Add note</span>}
    </button>
  )
}

/** "Message client": the job's client chat in a floating window (every message there goes to the client). */
export function MessageClientLink({ jobId, name, serviceType }: { jobId: string; name: string; serviceType: string }) {
  return (
    <OpenInWindowLink
      href={`/flows/${jobId}/chat`}
      title={`Message ${name} — ${serviceType}`}
      aria-label={`Message the client of ${name}`}
      className="whitespace-nowrap text-xs font-medium text-zinc-600 hover:text-blue-700 hover:underline"
    >
      Message client
    </OpenInWindowLink>
  )
}
