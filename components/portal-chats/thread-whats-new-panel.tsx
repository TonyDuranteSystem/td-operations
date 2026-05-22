'use client'

/**
 * ThreadWhatsNewPanel — the "What's New" feed inside /portal-chats for one
 * client: the internal system notes (sender_type='system' chat-events — "Client
 * paid…", "signed SS-4 — fax to IRS", "uploaded a document", wizard/onboarding
 * triggered) that the team must triage. These are STAFF-ONLY (hidden from the
 * client portal — see the leak fix in /api/portal/chat).
 *
 * Each note has an "Open card" action that opens the SAME card editor used on
 * the dashboard (NewCardDialog), pre-attached to this client with a suggested
 * next step + a source link. Once a card exists for a note, the note shows a
 * shared "Handled by …" marker so Antonio and Luca never double-work it.
 *
 * See sysdoc notification-center-plan.
 */

import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles, Plus, CheckCircle2, Square, CheckSquare } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const CHAT_API = '/api/portal/chat'
const WHATS_NEW_API = '/api/crm/admin-actions/whats-new'

interface RawMessage {
  id: string
  sender_type: string
  message: string
  topic: string | null
  created_at: string
  account_id: string | null
  contact_id: string | null
  handled_at?: string | null
  handled_by?: string | null
}

export interface WhatsNewNote {
  id: string
  topic: string | null
  kind: string | null
  sourceRef: string | null
  text: string
  created_at: string
  handledAt: string | null
  handledBy: string | null
}

// Best-guess next step per event kind. Honest + generic — the data often can't
// tell us the real task (e.g. a $64 payment whose description says
// "annual_renewal" was actually a card-shipping fee), so this is only a starting
// suggestion the user edits. See notification-center-plan.
const SUGGEST: Record<string, string> = {
  payment_received: 'Confirm what this payment was for and take the next step (e.g. ship card)',
  ss4_signed: 'Fax the SS-4 to the IRS to start the EIN application',
  document_uploaded: 'Review the document the client uploaded',
  wizard_submitted: "Review the client's submission and take the next step",
  workflow_spawned: 'Review and take the next step',
}

const MARKER_RE = /<!--\s*chat-event:\s*kind=(\S+)\s+src=(\S+)\s*-->/

function parseNote(m: RawMessage): WhatsNewNote {
  const match = m.message.match(MARKER_RE)
  const kind = match?.[1] ?? null
  const sourceRef = match?.[2] ?? null
  const text = m.message.replace(MARKER_RE, '').trim()
  return {
    id: m.id,
    topic: m.topic,
    kind,
    sourceRef,
    text,
    created_at: m.created_at,
    handledAt: m.handled_at ?? null,
    handledBy: m.handled_by ?? null,
  }
}

export function ThreadWhatsNewPanel({
  accountId,
  contactId,
  onOpenCard,
}: {
  accountId: string | null
  contactId: string | null
  onOpenCard: (note: { noteId: string; label: string; sourceRef: string | null }) => void
}) {
  const qc = useQueryClient()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const scopeKey = accountId ?? contactId
  const param = accountId ? `account_id=${accountId}` : contactId ? `contact_id=${contactId}` : null

  // System notes for this client (staff sees them; client portal does not).
  const { data: notes, isLoading } = useQuery<WhatsNewNote[]>({
    queryKey: ['thread-whats-new', scopeKey],
    queryFn: () =>
      fetch(`${CHAT_API}?${param}&limit=50`)
        .then((r) => r.json())
        .then((d: { messages?: RawMessage[] }) =>
          // Only internal chat-event notes (carry the marker) — exclude other
          // system messages like the out-of-office auto-reply (client-facing).
          (d.messages || [])
            .filter((m) => m.sender_type === 'system' && MARKER_RE.test(m.message))
            .map(parseNote)
            .reverse(),
        ),
    enabled: !!param,
    refetchInterval: 30_000,
  })

  // Tick / untick a note as handled. Handled notes drop off the purple dot;
  // unticking brings the dot back.
  const toggleHandled = useCallback(
    async (note: WhatsNewNote) => {
      setTogglingId(note.id)
      try {
        const res = await fetch(WHATS_NEW_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: note.id, handled: !note.handledAt }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not update')
        }
      } finally {
        await qc.invalidateQueries({ queryKey: ['thread-whats-new'] })
        await qc.invalidateQueries({ queryKey: ['portal-chat-whats-new-counts'] })
        setTogglingId(null)
      }
    },
    [qc],
  )

  // Opening a card from a note hands triage off to the dashboard card editor;
  // the page marks the note handled once the card is saved.
  const open = useCallback(
    (note: WhatsNewNote) => {
      const label = (note.kind && SUGGEST[note.kind]) || note.text
      onOpenCard({ noteId: note.id, label, sourceRef: note.sourceRef })
    },
    [onOpenCard],
  )

  if (!param) {
    return (
      <div className="flex items-center justify-center py-6">
        <p className="text-sm text-zinc-400">Select a conversation</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 bg-amber-50/60 border-b border-amber-100 flex items-center gap-1.5 shrink-0">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-xs font-medium text-amber-700">What&apos;s New — things this client did</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
        ) : !notes || notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle2 className="h-9 w-9 text-zinc-200 mb-2" />
            <p className="text-sm font-medium text-zinc-500">Nothing new</p>
            <p className="text-xs text-zinc-400">Client actions (payments, signatures, uploads) show up here.</p>
          </div>
        ) : (
          notes.map((note) => {
            const handled = !!note.handledAt
            const busy = togglingId === note.id
            return (
              <div key={note.id} className={`rounded-md border bg-white p-2.5 ${handled ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {note.topic && (
                      <span className="inline-block text-[9px] font-semibold uppercase tracking-wide text-zinc-500 bg-zinc-100 border border-zinc-200 rounded px-1 py-px mb-1">
                        {note.topic}
                      </span>
                    )}
                    <p className="text-sm text-zinc-800">{note.text}</p>
                    <p className="text-[10px] text-zinc-400 mt-1">
                      {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                      {handled && note.handledBy ? ` · handled by ${note.handledBy}` : ''}
                    </p>
                  </div>
                  {!handled && (
                    <button
                      onClick={() => open(note)}
                      className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900 border border-violet-200 rounded px-2 py-0.5 bg-white"
                      title="Open a To-Do card for this"
                    >
                      <Plus className="h-3 w-3" /> Open card
                    </button>
                  )}
                </div>
                {/* Handled toggle — ticking drops it off the purple dot; unticking brings it back. */}
                <div className="mt-1.5 flex items-center justify-between">
                  <button
                    disabled={busy}
                    onClick={() => toggleHandled(note)}
                    className={`flex items-center gap-1 text-[11px] ${handled ? 'text-emerald-600 hover:text-emerald-800' : 'text-zinc-500 hover:text-zinc-800'} disabled:opacity-50`}
                    title={handled ? 'Mark as not handled (the dot returns)' : 'Mark handled — I know what to do (no card needed)'}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : handled ? (
                      <CheckSquare className="h-3.5 w-3.5" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                    {handled ? 'Handled' : 'Mark handled'}
                  </button>
                  {handled && (
                    <button onClick={() => open(note)} className="text-[10px] text-zinc-400 hover:text-violet-700">
                      + card
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
