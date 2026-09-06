'use client'

/**
 * Portal Chat destination — the one CLIENT-FACING send this feature has
 * (Phase 2, council-reviewed 2026-09-04). Everything below exists because a
 * real client receives this, not another staff member:
 *
 * - Always a two-step flow (search -> confirm), even for a one-tap "send to
 *   the same place again" shortcut (the only destination that behaves this
 *   way — see REQUIRES_CONFIRMATION in lib/captures/recent-destinations.ts).
 * - The confirm screen shows the ACTUAL captured picture, not just a name —
 *   two independent council reviewers converged on the same point: the
 *   likelier mistake with a screenshot tool is the picture catching
 *   something it shouldn't, not picking the wrong person. A name-only
 *   confirmation re-confirms a fact the sender already knew and never
 *   surfaces the one they're least likely to have checked.
 * - Every match shows the person's email alongside their name (two real
 *   clients can share a name) and, for a company, is honest about who
 *   actually gets pinged: exactly the one named contact gets an email/push
 *   the moment this sends (lib/portal/notifications.ts's
 *   notifyClientOfAdminMessage takes its single-recipient branch whenever a
 *   contact is tagged, which a company-scoped admin send always is) — other
 *   people linked to the company are NOT proactively notified, only able to
 *   see it if they open their own portal chat. Overclaiming "N people will
 *   be notified" here would be confidently wrong; this says what's true.
 * - A multi-member company ALSO offers itself as its own candidate — kind
 *   "company_wide", no contact attached — mirroring the "Whole company"
 *   choice the main Portal Chats composer already has (2026-09-06, Antonio:
 *   a real search only showed the two people at a two-person company, never
 *   the company itself). Genuinely different from picking a person, not
 *   just a label: notifyClientOfAdminMessage's ACCOUNT-only branch notifies
 *   EVERY eligible linked contact, not one, so the confirm screen's copy
 *   changes accordingly for this case (see below).
 * - The Send button disables itself the instant it's tapped (no existing
 *   confirm-then-send component in this feature to inherit a busy-guard
 *   from — this is the first one, so double-tap-under-latency, a real
 *   pattern on Antonio's phone-PWA-primary usage, needed its own guard).
 * - Freshness: the actual send route re-validates the contact/company/status
 *   itself, right before touching Storage, and fails with a clear message
 *   if anything changed since this screen loaded — so a stale confirmation
 *   screen can't slip a bad send through even if this component's own data
 *   is a few minutes old.
 */
import { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { PortalDestinationCandidate } from '@/lib/captures/portal-destinations'
import { sendCaptureToPortalChat } from '@/lib/captures/share-actions'
import { addRecentDestination } from '@/lib/captures/recent-destinations'

interface PrefilledTarget {
  contactId: string
  accountId: string | null
  label: string
}

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

export function PortalChatDestinationPicker({
  captureId,
  imageFile = null,
  imageUrl,
  resend,
  prefilled,
  onSent,
  onError,
}: {
  captureId: string
  /** A real local File — only ever available right after a fresh capture. */
  imageFile?: File | null
  /** The existing capture's own image URL — for a re-share, which has no local File. */
  imageUrl?: string
  /** True for a deliberate re-share of a capture already sent once — see share-actions.ts. */
  resend?: boolean
  prefilled: PrefilledTarget | null
  onSent: (label: string) => void
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<PortalDestinationCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [target, setTarget] = useState<ConfirmTarget | null>(prefilled ? { ...prefilled, displayLabel: prefilled.label, contactEmail: null, wholeCompany: false } : null)
  const [sending, setSending] = useState(false)

  // Create AND revoke inside the SAME effect (not a memo + a separate
  // cleanup effect) — under React 18 Strict Mode's dev-only double-invoke,
  // a memoized URL survives the simulated unmount/remount but the blob it
  // points to gets revoked by a same-deps cleanup effect that already ran,
  // leaving img.src pointing at a syntactically valid but dead blob URL
  // (complete=true, naturalWidth=0) — caught by live testing, not by the
  // council's plan review, since it's an implementation-only bug.
  // `imageUrl` (a re-share's existing, already-uploaded picture) is used
  // AS-IS — it's a real URL already, nothing to create or revoke. Only the
  // `imageFile` branch (a fresh local File) needs a blob URL, and that one
  // still must be created AND revoked inside this SAME effect — see the
  // comment above about the Strict Mode double-invoke trap this avoids.
  const [previewUrl, setPreviewUrl] = useState<string | null>(imageUrl ?? null)
  useEffect(() => {
    if (imageUrl) {
      setPreviewUrl(imageUrl)
      return
    }
    if (!imageFile) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(imageFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile, imageUrl])

  useEffect(() => {
    if (target) return // already on the confirm step (prefilled from a recent)
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
        .then((r) => {
          if (!r.ok) throw new Error('search failed')
          return r.json()
        })
        .then((d) => {
          if (!cancelled) setCandidates(Array.isArray(d.candidates) ? d.candidates : [])
        })
        .catch(() => {
          // Kept local rather than escalated to the full onError screen
          // (unlike the other pickers' one-time loads) — this fires on
          // every keystroke, so kicking the user out of searching on one
          // transient blip would be worse than the R099 violation it fixes.
          // Still surfaced, not silently swallowed into "no matches" (that
          // was indistinguishable from a real client not existing —
          // bug-hunter finding, 2026-09-04).
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
      await sendCaptureToPortalChat(captureId, { contact_id: target.contactId, account_id: target.accountId }, resend)
      // Not saved as a "recent" for a whole-company send — RecentDestination's
      // portal_chat shape keys on a real contactId, and portal_chat already
      // never skips the confirm screen (REQUIRES_CONFIRMATION), so the only
      // thing a saved recent would buy here is pre-filling a search that's
      // just as fast to redo.
      if (target.contactId) {
        addRecentDestination({ type: 'portal_chat', contactId: target.contactId, accountId: target.accountId, label: target.displayLabel })
      }
      onSent(`Sent to ${target.displayLabel}.`)
    } catch (err) {
      setSending(false)
      onError(err instanceof Error ? err.message : 'Could not send it. Please try again.')
    }
  }

  if (target) {
    return (
      <div className="flex flex-col gap-3">
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not a remote image
          <img src={previewUrl} alt="What you're about to send" className="max-h-40 w-full rounded-md border border-zinc-200 object-contain" />
        )}
        <div className="rounded-md border border-zinc-200 p-3 text-sm">
          <p className="text-zinc-500">This will be sent to</p>
          <p className="font-medium text-zinc-900">{target.displayLabel}</p>
          {target.contactEmail && <p className="text-xs text-zinc-400">{target.contactEmail}</p>}
          <p className="mt-2 text-xs text-zinc-500">
            {target.wholeCompany
              ? 'Everyone at this company with portal access will get an email and a phone notification.'
              : target.accountId
                ? 'They’ll get an email and a phone notification. Anyone else linked to this company could also see it if they check their portal chat.'
                : 'They’ll get an email and a phone notification.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => (prefilled ? onError('Search for a destination instead.') : setTarget(null))}
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
          onChange={(e) => setQuery(e.target.value)}
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
        {candidates.map((c) => (
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
