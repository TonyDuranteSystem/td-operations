'use client'

/**
 * Portal Chat destination picker for CRM Storage's "Share" action — the one
 * CLIENT-FACING send this feature has. Same two-step search-then-confirm
 * shape as components/captures/portal-chat-destination-picker.tsx (reuses
 * the same GET /api/captures/portal-destinations search — that endpoint
 * searches real contacts/accounts and has nothing capture-specific about
 * it), adapted to a storage file instead of a screenshot:
 *
 * - The confirm screen shows the FILE NAME being sent (not an image
 *   preview — captures' own reasoning for showing the picture was "did I
 *   capture something I shouldn't", which doesn't apply to a named document
 *   someone deliberately picked from a folder).
 * - No resend concept — see lib/crm-storage/share-actions.ts.
 * - The Send button disables itself the instant it's tapped, same
 *   double-tap guard captures' own picker uses (there is no server-side
 *   atomic claim to lean on here, by design — a stored document is a
 *   reusable library item, not a one-shot capture).
 */
import { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { PortalDestinationCandidate } from '@/lib/captures/portal-destinations'
import { sendStorageFileToPortalChat } from '@/lib/crm-storage/share-actions'

interface ConfirmTarget {
  contactId: string | null
  accountId: string | null
  displayLabel: string
  contactEmail: string | null
  wholeCompany: boolean
}

function toConfirmTarget(c: PortalDestinationCandidate): ConfirmTarget {
  return {
    contactId: c.contactId,
    accountId: c.accountId,
    displayLabel: c.kind === 'company_wide' ? `${c.companyName} — Whole company` : c.kind === 'company' ? `${c.contactName} — ${c.companyName}` : c.contactName,
    contactEmail: c.contactEmail,
    wholeCompany: c.kind === 'company_wide',
  }
}

export function SharePortalChatPicker({
  fileId,
  fileName,
  onSent,
  onError,
}: {
  fileId: string
  fileName: string
  onSent: (label: string) => void
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<PortalDestinationCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [target, setTarget] = useState<ConfirmTarget | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (target) return
    const q = query.trim()
    setSearchError(false)
    if (q.length < 2) {
      setCandidates([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(() => {
      fetch(`/api/captures/portal-destinations?q=${encodeURIComponent(q)}`)
        .then(r => {
          if (!r.ok) throw new Error('search failed')
          return r.json()
        })
        .then(d => {
          if (!cancelled) setCandidates(Array.isArray(d.candidates) ? d.candidates : [])
        })
        .catch(() => {
          if (!cancelled) {
            setCandidates([])
            setSearchError(true)
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, target])

  const handleSend = async () => {
    if (!target || sending) return
    setSending(true)
    try {
      await sendStorageFileToPortalChat(fileId, { contact_id: target.contactId, account_id: target.accountId })
      onSent(`Sent to ${target.displayLabel}.`)
    } catch (err) {
      setSending(false)
      onError(err instanceof Error ? err.message : 'Could not send it. Please try again.')
    }
  }

  if (target) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-zinc-200 p-3 text-sm">
          <p className="text-zinc-500">Sending</p>
          <p className="truncate font-medium text-zinc-900">{fileName}</p>
          <p className="mt-2 text-zinc-500">to</p>
          <p className="font-medium text-zinc-900">{target.displayLabel}</p>
          {target.contactEmail && <p className="text-xs text-zinc-400">{target.contactEmail}</p>}
          <p className="mt-2 text-xs text-zinc-500">
            {target.wholeCompany
              ? 'Not addressed to one person. Someone at the company will still get the email and phone notification — anyone linked could also see it if they check their portal chat.'
              : target.accountId
                ? 'They’ll get an email and a phone notification. Anyone else linked to this company could also see it if they check their portal chat.'
                : 'They’ll get an email and a phone notification.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setTarget(null)}
            disabled={sending}
            className="flex-1 rounded-md border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-40"
          >
            Back
          </button>
          <button
            onClick={() => void handleSend()}
            disabled={sending}
            className="flex-1 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search a client's name or company..."
          className="w-full rounded-md border border-zinc-200 py-2 pl-8 pr-3 text-sm"
        />
      </div>
      {searching && (
        <div className="flex items-center justify-center py-4 text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
      {!searching && searchError && (
        <p className="py-4 text-center text-xs text-red-600">Couldn&apos;t search — check your connection and try again.</p>
      )}
      {!searching && !searchError && query.trim().length >= 2 && candidates.length === 0 && (
        <p className="py-4 text-center text-xs text-zinc-400">No matches.</p>
      )}
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {candidates.map(c => (
          <button
            key={`${c.kind}-${c.contactId ?? 'none'}-${c.accountId ?? 'personal'}`}
            onClick={() => setTarget(toConfirmTarget(c))}
            className="flex flex-col items-start rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50"
          >
            <span className="font-medium text-zinc-900">
              {c.kind === 'company_wide' ? `${c.companyName} — Whole company` : c.kind === 'company' ? `${c.contactName} — ${c.companyName}` : c.contactName}
            </span>
            {c.contactEmail && <span className="text-xs text-zinc-400">{c.contactEmail}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
