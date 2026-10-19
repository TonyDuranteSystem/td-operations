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
 * Stop Drive S2: the old "file it in the right Drive folder" step that followed a share is gone (Google Drive is read-only; the
 * Drive move route was removed). Sharing never changes the document's category.
 */

interface Props {
  documentId: string
  accountId: string
  confidence: string | null
  updatedAt: string | null
  onResolved: () => void
  onCancel: () => void
}

export function ResolvePersonalDocument({
  documentId, accountId, confidence, updatedAt, onResolved, onCancel,
}: Props) {
  const [contacts, setContacts] = useState<{ id: string; full_name: string }[]>([])
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [contactsError, setContactsError] = useState(false)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
        onResolved()
      } else {
        toast.error(result.error || 'Failed to share the document')
        onResolved() // refetch — state may have changed under us
      }
    } finally {
      setSubmitting(false)
    }
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
