'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { SmilePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { summarizeReactions, type MessageReaction } from '@/lib/portal/reactions'
import { shouldPulseReaction, reactionInstanceKey } from '@/lib/portal/notification-read'
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
  seenKeys,
  onReactionsSeen,
}: {
  messageId: string
  reactions: MessageReaction[] | null | undefined
  viewerReactorId: string | null | undefined
  locale?: string
  align?: 'left' | 'right'
  staffLabel?: string
  onReacted?: () => void
  /** Portal only, on the viewer's OWN message: the reaction keys already seen on this device. When given,
   *  team reactions not in it pulse until they have really been on screen. Undefined = feature off (CRM
   *  side, other people's messages). */
  seenKeys?: ReadonlySet<string>
  /** Called once a pulsing reaction has been visible long enough to count as seen (with its keys). */
  onReactionsSeen?: (keys: string[]) => void
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
  const now = Date.now()
  // The keys of the team reactions of this emoji that still need the viewer's eyes.
  const unseenKeysFor = (emoji: string): string[] =>
    seenKeys === undefined || !Array.isArray(reactions)
      ? []
      : reactions
          .filter(r => r?.emoji === emoji && shouldPulseReaction(r, messageId, seenKeys, now))
          .map(r => reactionInstanceKey(messageId, r))

  return (
    <div className={cn('flex flex-wrap items-center gap-1', align === 'right' ? 'justify-end' : 'justify-start')}>
      {groups.map(g => {
        const unseen = unseenKeysFor(g.emoji)
        return (
          <FastTooltip key={g.emoji} label={g.names.join(', ')}>
            <ReactionPill
              emoji={g.emoji}
              count={g.count}
              mine={g.mine}
              label={g.names.join(', ')}
              busy={busy}
              onToggle={() => react(g.emoji)}
              unseenKeys={unseen}
              onSeen={onReactionsSeen}
            />
          </FastTooltip>
        )
      })}

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

/** How long, and how much of the pill, must be on screen before it counts as "seen". */
const SEEN_VISIBLE_RATIO = 0.6
const SEEN_VISIBLE_MS = 2000

/**
 * One emoji pill. When it carries reactions the viewer has not seen it pulses, and it reports them as
 * seen only after it has really been on screen (≥60% inside the viewport, tab visible) for 2 s — not after
 * a timer, so a 👍 hidden under a panel or scrolled away keeps asking for attention.
 */
function ReactionPill({
  emoji, count, mine, label, busy, onToggle, unseenKeys, onSeen,
}: {
  emoji: string
  count: number
  mine: boolean
  label: string
  busy: boolean
  onToggle: () => void
  unseenKeys: string[]
  onSeen?: (keys: string[]) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const attention = unseenKeys.length > 0
  const keysId = unseenKeys.join('\n')
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen

  useEffect(() => {
    if (!attention || !ref.current || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let inView = false
    const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
    const arm = () => {
      clear()
      if (!inView || document.visibilityState !== 'visible') return
      timer = setTimeout(() => onSeenRef.current?.(keysId.split('\n')), SEEN_VISIBLE_MS)
    }
    const io = new IntersectionObserver(
      entries => { inView = entries.some(e => e.isIntersecting && e.intersectionRatio >= SEEN_VISIBLE_RATIO); arm() },
      { threshold: [0, SEEN_VISIBLE_RATIO, 1] },
    )
    io.observe(ref.current)
    const onVis = () => arm()
    document.addEventListener('visibilitychange', onVis)
    return () => { clear(); io.disconnect(); document.removeEventListener('visibilitychange', onVis) }
  }, [attention, keysId])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors disabled:opacity-60',
        attention && 'reaction-attention',
        mine
          ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50'
      )}
    >
      <span className="text-sm leading-none">{emoji}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  )
}
