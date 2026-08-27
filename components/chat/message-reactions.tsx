'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { SmilePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { summarizeReactions, type MessageReaction } from '@/lib/portal/reactions'
import { FastTooltip } from '@/components/ui/fast-tooltip'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

/**
 * Reaction strip rendered under a single chat message. Shared by the client
 * portal chat and the CRM staff chat.
 *
 * - Existing reactions render as pills (emoji + count); the viewer's own
 *   reactions are highlighted. Tapping a pill toggles the viewer's reaction.
 * - The full emoji picker opens on the "add" (smiley-plus) button. The picker
 *   keeps its own "recently used" row at the top, so re-using the last emoji is
 *   fast WITHOUT stamping a standalone emoji button under every message (that
 *   earlier design read as if every message had been reacted to — removed).
 * - Self-contained: POSTs to the react endpoint and lets realtime reconcile the
 *   row. `onReacted` lets a parent without realtime (CRM contact detail) refetch.
 */
export function MessageReactions({
  messageId,
  reactions,
  viewerReactorId,
  locale = 'en',
  align = 'left',
  staffLabel = 'Team',
  onReacted,
}: {
  messageId: string
  reactions: MessageReaction[] | null | undefined
  viewerReactorId: string | null | undefined
  locale?: string
  align?: 'left' | 'right'
  staffLabel?: string
  onReacted?: () => void
}) {
  const [showPicker, setShowPicker] = useState(false)
  const [busy, setBusy] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPicker) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPicker])

  const react = useCallback(async (emoji: string) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/portal/chat/message/${messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || (locale === 'it' ? 'Reazione non riuscita — riprova.' : 'Could not react — please try again.'))
      }
      onReacted?.()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : (locale === 'it' ? 'Reazione non riuscita.' : 'Could not react.'))
    } finally {
      setBusy(false)
    }
  }, [messageId, busy, locale, onReacted])

  const groups = summarizeReactions(reactions, viewerReactorId, staffLabel)

  return (
    <div className={cn('flex flex-wrap items-center gap-1', align === 'right' ? 'justify-end' : 'justify-start')}>
      {groups.map(g => (
        <FastTooltip key={g.emoji} label={g.names.join(', ')}>
          <button
            type="button"
            onClick={() => react(g.emoji)}
            disabled={busy}
            aria-label={g.names.join(', ')}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors disabled:opacity-60',
              g.mine
                ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50'
            )}
          >
            <span className="text-sm leading-none">{g.emoji}</span>
            <span className="tabular-nums">{g.count}</span>
          </button>
        </FastTooltip>
      ))}

      {/* Add a reaction — opens the full picker (which surfaces recently-used
          emojis at the top for fast re-use). */}
      <div className="relative" ref={pickerRef}>
        <FastTooltip label={locale === 'it' ? 'Aggiungi reazione' : 'Add reaction'}>
          <button
            type="button"
            onClick={() => setShowPicker(v => !v)}
            disabled={busy}
            aria-label={locale === 'it' ? 'Aggiungi reazione' : 'Add reaction'}
            className="inline-flex items-center justify-center rounded-full p-1 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors disabled:opacity-60"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
        </FastTooltip>
        {showPicker && (
          <div className={cn('absolute z-50 bottom-full mb-1', align === 'right' ? 'right-0' : 'left-0')}>
            <EmojiPicker
              onEmojiClick={(emojiData: { emoji: string }) => {
                react(emojiData.emoji)
                setShowPicker(false)
              }}
              lazyLoadEmojis
              width={300}
              height={380}
            />
          </div>
        )}
      </div>
    </div>
  )
}
