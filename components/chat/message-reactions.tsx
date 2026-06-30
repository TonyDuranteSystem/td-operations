'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { SmilePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  summarizeReactions,
  LAST_REACTION_STORAGE_KEY,
  type MessageReaction,
} from '@/lib/portal/reactions'

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

/**
 * Reaction strip rendered under a single chat message. Shared by the client
 * portal chat and the CRM staff chat.
 *
 * - Existing reactions render as pills (emoji + count); the viewer's own
 *   reactions are highlighted. Tapping a pill toggles the viewer's reaction.
 * - The full emoji picker opens on the "add" button every time (Antonio's
 *   choice), and the LAST picked emoji is remembered (per device) as a one-tap
 *   shortcut next to it.
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
  const [lastEmoji, setLastEmoji] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      setLastEmoji(localStorage.getItem(LAST_REACTION_STORAGE_KEY))
    } catch {
      // localStorage unavailable — no remembered emoji, picker still works.
    }
    // Keep every message row's one-tap shortcut in sync the moment a new emoji
    // is picked anywhere (each row reads localStorage once on mount, so without
    // this the shortcut would only refresh on reload).
    const onPicked = (e: Event) => setLastEmoji((e as CustomEvent<string>).detail)
    window.addEventListener('td-reaction-picked', onPicked)
    return () => window.removeEventListener('td-reaction-picked', onPicked)
  }, [])

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
      try {
        localStorage.setItem(LAST_REACTION_STORAGE_KEY, emoji)
      } catch {
        // ignore — remembering is best-effort
      }
      setLastEmoji(emoji)
      // Broadcast so all other message rows update their one-tap shortcut too.
      try {
        window.dispatchEvent(new CustomEvent('td-reaction-picked', { detail: emoji }))
      } catch {
        // ignore — non-browser / unsupported
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
        <button
          key={g.emoji}
          type="button"
          onClick={() => react(g.emoji)}
          disabled={busy}
          title={g.names.join(', ')}
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
      ))}

      {/* Remembered last-picked emoji — one-tap reuse. Hidden when the viewer
          already reacted with it (the pill above already serves that purpose). */}
      {lastEmoji && !groups.some(g => g.emoji === lastEmoji && g.mine) && (
        <button
          type="button"
          onClick={() => react(lastEmoji)}
          disabled={busy}
          title={locale === 'it' ? `Reagisci con ${lastEmoji}` : `React with ${lastEmoji}`}
          className="inline-flex items-center justify-center rounded-full border border-dashed border-zinc-200 px-1.5 py-0.5 text-sm leading-none text-zinc-400 hover:text-zinc-700 hover:border-zinc-300 transition-colors disabled:opacity-60"
        >
          {lastEmoji}
        </button>
      )}

      {/* Full picker — opens every time. */}
      <div className="relative" ref={pickerRef}>
        <button
          type="button"
          onClick={() => setShowPicker(v => !v)}
          disabled={busy}
          title={locale === 'it' ? 'Aggiungi reazione' : 'Add reaction'}
          className="inline-flex items-center justify-center rounded-full p-1 text-zinc-300 hover:text-zinc-600 hover:bg-zinc-100 transition-colors disabled:opacity-60"
        >
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
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
