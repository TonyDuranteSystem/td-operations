'use client'

/**
 * The "choose where to send it" screen — extracted from capture-layer.tsx
 * (2026-09-05) so a picture already sitting in My Captures can be shared
 * again LATER through the exact same screen, not a second, separately
 * maintained copy of it (Antonio: "opens the exact same send-to screen you
 * already get right after taking a screenshot"). This is the same principle
 * lib/captures/share-actions.ts's own header comment already states for the
 * one-tap recent-destination shortcuts: one code path, reused everywhere,
 * because a second copy is how the mandatory-confirmation-for-portal-chat
 * rule (see REQUIRES_CONFIRMATION) would eventually drift and get missed in
 * only one of the two places.
 *
 * Two callers:
 *  - capture-layer.tsx, right after a fresh capture uploads — passes
 *    `imageFile` (a real local File, for the portal-chat confirm preview)
 *    and no `resend` (the original, strict idempotency: this exact capture
 *    has never been sent before, so the share routes correctly reject a
 *    second attempt at the same send).
 *  - share-existing-modal.tsx, for a picture already in the gallery —
 *    passes `imageUrl` (the existing capture has no local File, only its
 *    server-side image) and `resend: true`, since "this was already shared"
 *    is exactly what a deliberate re-share is trying to do again. See that
 *    file's own header comment for why the weaker idempotency posture on
 *    THIS ONE path is a deliberate, reasoned trade-off, not an oversight.
 */
import { useEffect, useState } from 'react'
import { StickyNote, MessageSquare, Send } from 'lucide-react'
import { NoteDestinationPicker } from '@/components/captures/note-destination-picker'
import { TeamChatDestinationPicker } from '@/components/captures/team-chat-destination-picker'
import { PortalChatDestinationPicker } from '@/components/captures/portal-chat-destination-picker'
import { attachCaptureToNote, sendCaptureToTeamChat } from '@/lib/captures/share-actions'
import { getRecentDestinations, addRecentDestination, REQUIRES_CONFIRMATION, type RecentDestination } from '@/lib/captures/recent-destinations'

type DestinationChoice = 'sticky_note' | 'team_chat' | 'portal_chat' | null
type PortalChatPrefill = { contactId: string; accountId: string | null; label: string }

export function DestinationFlow({
  captureId,
  imageFile = null,
  imageUrl,
  resend = false,
  onDone,
  onError,
}: {
  captureId: string
  /** A real local File — only ever available right after a fresh capture. */
  imageFile?: File | null
  /** The existing capture's own image, for a re-share from the gallery. */
  imageUrl?: string
  /** True only for a deliberate re-share of an already-sent capture. */
  resend?: boolean
  onDone: (message?: string) => void
  onError: (message: string) => void
}) {
  const [destinationChoice, setDestinationChoice] = useState<DestinationChoice>(null)
  const [recents, setRecents] = useState<RecentDestination[]>([])
  const [quickSending, setQuickSending] = useState(false)
  const [portalChatPrefill, setPortalChatPrefill] = useState<PortalChatPrefill | null>(null)

  useEffect(() => {
    setRecents(getRecentDestinations())
  }, [])

  // Same shape as capture-layer.tsx's original handleQuickSend — consults
  // REQUIRES_CONFIRMATION rather than hardcoding which types are instant-send
  // (bug-hunter blocker, 2026-09-04 council pass: the natural "add a branch"
  // shape is exactly how the one destination that must never skip
  // confirmation would silently start skipping it).
  const handleQuickSend = async (dest: RecentDestination) => {
    if (REQUIRES_CONFIRMATION[dest.type]) {
      if (dest.type === 'portal_chat') {
        setPortalChatPrefill({ contactId: dest.contactId, accountId: dest.accountId, label: dest.label })
        setDestinationChoice('portal_chat')
      }
      return
    }
    setQuickSending(true)
    try {
      if (dest.type === 'sticky_note') {
        await attachCaptureToNote(captureId, dest.id, resend)
      } else if (dest.type === 'team_chat') {
        await sendCaptureToTeamChat(captureId, dest.id, resend)
      }
      addRecentDestination(dest)
      onDone()
    } catch (err) {
      setQuickSending(false)
      onError(err instanceof Error ? err.message : 'Could not send it there. Please try again.')
    }
  }

  if (destinationChoice === null) {
    return (
      <div className="flex flex-col gap-3">
        {recents.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-zinc-400">Send to the same place again:</p>
            <div className="flex flex-col gap-1">
              {recents.map((r) => {
                const Icon = r.type === 'sticky_note' ? StickyNote : r.type === 'team_chat' ? MessageSquare : Send
                const key = r.type === 'portal_chat' ? `portal_chat-${r.contactId}-${r.accountId ?? ''}` : `${r.type}-${r.id}`
                return (
                  <button
                    key={key}
                    onClick={() => void handleQuickSend(r)}
                    disabled={quickSending}
                    className="flex items-center gap-2 truncate rounded-md border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 disabled:opacity-40"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="truncate">{r.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setDestinationChoice('sticky_note')}
            className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
          >
            <StickyNote className="h-4 w-4 text-zinc-500" />
            {recents.length > 0 ? 'A different sticky note' : 'A sticky note'}
          </button>
          <button
            onClick={() => setDestinationChoice('team_chat')}
            className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
          >
            <MessageSquare className="h-4 w-4 text-zinc-500" />
            {recents.length > 0 ? 'A different team chat conversation' : 'A team chat conversation'}
          </button>
          <button
            onClick={() => setDestinationChoice('portal_chat')}
            className="flex items-center gap-2 rounded-md border border-zinc-200 px-4 py-3 text-left text-sm hover:bg-zinc-50"
          >
            <Send className="h-4 w-4 text-zinc-500" />
            A client portal chat
          </button>
        </div>
      </div>
    )
  }

  if (destinationChoice === 'sticky_note') {
    return <NoteDestinationPicker captureId={captureId} resend={resend} onAttached={() => onDone()} onError={onError} />
  }

  if (destinationChoice === 'team_chat') {
    return <TeamChatDestinationPicker captureId={captureId} resend={resend} onSent={() => onDone()} onError={onError} />
  }

  return (
    <PortalChatDestinationPicker
      captureId={captureId}
      imageFile={imageFile}
      imageUrl={imageUrl}
      resend={resend}
      prefilled={portalChatPrefill}
      onSent={(label) => onDone(label)}
      onError={onError}
    />
  )
}
