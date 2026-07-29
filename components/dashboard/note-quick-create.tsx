'use client'

/**
 * "Make a note" button — drop it on any surface that knows which client it's looking at
 * (a portal chat, an email thread) and it creates a post-it already tied to that client,
 * with a link back to the exact page it came from.
 *
 * Since 2026-07-29 this opens the FULL note editor (text, client, come-back date, who's
 * it for) — Antonio: creating a note anywhere must be the real editor, not a text-only
 * popup. The team list it needs is fetched on open via the lightweight members scope.
 *
 * Deliberately a plain shared button rather than a portal-chats catalog quick-action: the Inbox
 * cannot use that mechanism at all, and one component gives both surfaces identical behaviour.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StickyNote } from 'lucide-react'
import { NoteEditor, type Member } from '@/components/dashboard/note-editor'

const API = '/api/crm/staff-notes'

async function fetchMembers(): Promise<{ me: { id: string; name: string }; members: Member[] }> {
  const res = await fetch(`${API}?scope=members`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load the team list.')
  }
  return res.json()
}

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
  // Who can the note be for? Cached briefly — the staff list changes ~never mid-session.
  const { data } = useQuery({ queryKey: ['staff-notes-members'], queryFn: fetchMembers, staleTime: 5 * 60_000 })

  return (
    <NoteEditor
      note={null}
      members={data?.members ?? []}
      meId={data?.me?.id ?? null}
      createDefaults={{
        body: prefill ? prefill.slice(0, 200) : undefined,
        accountId: accountId || undefined,
        contactId: accountId ? undefined : contactId || undefined,
        // where it came from, so the note can take you back weeks later
        originUrl: typeof window !== 'undefined' ? window.location.pathname + window.location.search : undefined,
      }}
      onClose={onClose}
      onChanged={() => {
        qc.invalidateQueries({ queryKey: ['staff-notes-active'] })
        qc.invalidateQueries({ queryKey: ['staff-notes-all'] })
      }}
    />
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
