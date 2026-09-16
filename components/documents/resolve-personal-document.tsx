'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toggleDocumentPortalVisibility, listAccountContactsForDocumentResolution } from '@/app/(dashboard)/accounts/actions'

/**
 * Inline "who is this for" resolution, shown in place of a plain error when
 * sharing a personal document (passport/ID/etc.) with no resolved owner.
 * Replaces the old hard block from lib/documents/visibility-guard.ts with an
 * actual way to fix it, right where the block happens — dev job following
 * ece21c44/f1dc4048.
 *
 * Deliberately renders inline in the row, not a separate popup/modal (an
 * earlier draft with a full multi-step wizard was reviewed and rejected as
 * too heavy for what is fundamentally a one-question problem).
 *
 * Owner-confirmation and the actual share happen as ONE call (see
 * toggleDocumentPortalVisibility's `resolution` param) — never two separate
 * saves. A two-step version (save owner, then separately share) was reviewed
 * and rejected: interrupting between the steps left a document with a
 * resolved owner but no visible record that anything else was pending, so it
 * could then be shared normally by an unrelated later click with the
 * intended follow-through silently dropped.
 *
 * Folder-filing is a SEPARATE, later, non-blocking step (see
 * FileIntoFolderPrompt below) — never a precondition for sharing. An earlier
 * draft bundled "move to folder" into the same confirm as the share itself,
 * reusing the account's Drive move endpoint; that endpoint's side effect of
 * re-syncing the document's category to match the destination folder would
 * have silently turned OFF the very guard this whole feature exists to
 * satisfy (the guard checks category === 2 — moving to any other folder, or
 * to no folder because no exact match existed, would flip that check to
 * "not personal" regardless of whether an owner was actually confirmed).
 * Closed by never letting this flow's folder step touch category at all
 * (see the `preserveCategory` flag on the move route).
 */

interface Props {
  documentId: string
  driveFileId: string
  accountId: string
  confidence: string | null
  updatedAt: string | null
  /** The account's real top-level Drive folders, already fetched by the caller. */
  folders: { id: string; name: string }[]
  onResolved: () => void
  onCancel: () => void
}

const PERSONAL_FOLDER_NAME = '2. Contacts'

export function ResolvePersonalDocument({
  documentId, driveFileId, accountId, confidence, updatedAt, folders, onResolved, onCancel,
}: Props) {
  const [contacts, setContacts] = useState<{ id: string; full_name: string }[]>([])
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [contactsError, setContactsError] = useState(false)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [justShared, setJustShared] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadingContacts(true)
    setContactsError(false)
    listAccountContactsForDocumentResolution(accountId)
      .then((data) => { if (!cancelled) setContacts(data) })
      .catch(() => { if (!cancelled) setContactsError(true) })
      .finally(() => { if (!cancelled) setLoadingContacts(false) })
    return () => { cancelled = true }
  }, [accountId])

  const submit = async (options: { contactId?: string; overridePersonalCheck?: boolean }) => {
    setSubmitting(true)
    try {
      const result = await toggleDocumentPortalVisibility(documentId, true, {
        ...options,
        expectedUpdatedAt: updatedAt ?? undefined,
      })
      if (result.success) {
        toast.success('Shared with the client')
        setJustShared(true)
      } else {
        toast.error(result.error || 'Failed to share the document')
        onResolved() // refetch — state may have changed under us
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (justShared) {
    return (
      <FileIntoFolderPrompt
        driveFileId={driveFileId}
        accountId={accountId}
        folders={folders}
        onDone={onResolved}
      />
    )
  }

  const confidenceIsLow = confidence === 'low'

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm space-y-2" data-testid="resolve-personal-document">
      <p className="font-medium text-zinc-800">
        {confidenceIsLow ? 'Is this a personal document — and if so, who is it for?' : 'This looks personal — who is it for?'}
      </p>
      {loadingContacts ? (
        <div className="flex items-center gap-2 text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading people linked to this account…</div>
      ) : contactsError ? (
        <div className="flex items-center gap-2 text-red-600">
          Couldn&apos;t load the people linked to this account.
          <button
            type="button"
            className="underline"
            onClick={() => {
              setLoadingContacts(true)
              setContactsError(false)
              listAccountContactsForDocumentResolution(accountId)
                .then(setContacts)
                .catch(() => setContactsError(true))
                .finally(() => setLoadingContacts(false))
            }}
          >
            Try again
          </button>
        </div>
      ) : contacts.length === 0 ? (
        <p className="text-zinc-500">No one is linked to this account yet — link the right person first, then come back here.</p>
      ) : (
        <div className="space-y-1">
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={submitting}
              onClick={() => { setSelectedContactId(c.id); submit({ contactId: c.id }) }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left hover:bg-amber-100 disabled:opacity-50',
                selectedContactId === c.id ? 'border-amber-400 bg-amber-100' : 'border-transparent bg-white'
              )}
            >
              {submitting && selectedContactId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 opacity-0" />}
              {c.full_name}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit({ overridePersonalCheck: true })}
          className="text-xs text-zinc-400 underline hover:text-zinc-600 disabled:opacity-50"
        >
          Not personal — share anyway
        </button>
        <button type="button" onClick={onCancel} className="text-zinc-400 hover:text-zinc-600" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function FileIntoFolderPrompt({
  driveFileId, accountId, folders, onDone,
}: {
  driveFileId: string
  accountId: string
  folders: { id: string; name: string }[]
  onDone: () => void
}) {
  const suggested = folders.find((f) => f.name === PERSONAL_FOLDER_NAME) ?? null
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(suggested?.id ?? null)
  const [moving, setMoving] = useState(false)

  const move = async () => {
    if (!selectedFolderId) return
    const folder = folders.find((f) => f.id === selectedFolderId)
    setMoving(true)
    try {
      const res = await fetch(`/api/accounts/${accountId}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: driveFileId,
          targetFolderId: selectedFolderId,
          targetFolderName: folder?.name,
          preserveCategory: true,
        }),
      })
      const data = await res.json().catch(() => ({}) as { error?: string })
      if (res.ok && data && (data as { success?: boolean }).success) {
        toast.success('Filed in the right folder')
      } else {
        toast.error((data as { error?: string }).error || `Couldn't move the file (server error ${res.status})`)
      }
    } finally {
      setMoving(false)
      onDone()
    }
  }

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm space-y-2">
      <p className="font-medium text-zinc-800">Shared. File it in the right folder?</p>
      {folders.length === 0 ? (
        <p className="text-zinc-500">Couldn&apos;t load this account&apos;s folders — you can file it later from the file list.</p>
      ) : (
        <select
          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          value={selectedFolderId ?? ''}
          onChange={(e) => setSelectedFolderId(e.target.value || null)}
        >
          <option value="">Choose a folder…</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      )}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          disabled={!selectedFolderId || moving}
          onClick={move}
          className="rounded-md bg-green-600 px-3 py-1 text-white disabled:opacity-50"
        >
          {moving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'File it'}
        </button>
        <button type="button" onClick={onDone} className="text-xs text-zinc-400 underline hover:text-zinc-600">
          Skip for now
        </button>
      </div>
    </div>
  )
}
