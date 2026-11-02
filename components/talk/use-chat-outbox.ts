'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newClientId } from '@/lib/chat/client-id'
import { discardMessage, enqueueMessage, flushOutbox, loadOutbox, onOutboxSent, retryMessage, subscribeOutbox, waitingFor } from '@/lib/talk/outbox'
import { localMessage, type OutboxItem, type OutboxTarget } from '@/lib/talk/outbox-rules'
import type { TalkMessage, TalkReplyPreview } from '@/lib/talk/chat-model'

/**
 * The outbox for one open chat (TD Talk, or a TD Marketing chat): `enqueue` keeps the message on the phone and sends it as soon as it can (it returns at once, so the box
 * empties like a normal send); `waiting` are the messages not yet delivered, ready to be drawn at the end of the chat; `onSent` hands over the server's copy when one goes through.
 * Sending runs for every chat of this person, not only the open one, and starts again by itself when the connection comes back.
 */
export function useChatOutbox({ scope, target, userId, onSent }: {
  scope: string
  target: OutboxTarget
  userId: string | null
  onSent: (message: TalkMessage, item: OutboxItem) => void
}) {
  const [, bump] = useState(0)
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => subscribeOutbox(() => bump(n => n + 1)), [])
  useEffect(() => onOutboxSent((item, message) => { if (item.scope === scope && message) onSentRef.current(message as TalkMessage, item) }), [scope])

  // start (what the phone kept from last time goes out now) and start again when the connection or the app comes back
  useEffect(() => {
    if (!userId) return
    const go = () => { void flushOutbox(userId) }
    void loadOutbox().then(go)
    const onVisible = () => { if (document.visibilityState === 'visible') go() }
    window.addEventListener('online', go)
    window.addEventListener('focus', go)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('online', go); window.removeEventListener('focus', go); document.removeEventListener('visibilitychange', onVisible) }
  }, [userId])

  const enqueue = useCallback(async (input: { text: string; files: File[]; replyToId?: string | null; replyPreview?: TalkReplyPreview | null }): Promise<boolean> => {
    if (!userId) return false
    try {
      await enqueueMessage({
        id: newClientId(), scope, target: targetRef.current, senderId: userId, senderName: 'You',
        text: input.text, files: input.files.map(f => ({ name: f.name, type: f.type, blob: f })), replyToId: input.replyToId ?? null, replyPreview: input.replyPreview ?? null,
        createdAt: new Date().toISOString(), uploaded: [], state: 'pending', attempts: 0,
      })
      return true
    } catch { return false }
  }, [scope, userId])

  const retry = useCallback((id: string) => { if (userId) void retryMessage(id, userId) }, [userId])
  const discard = useCallback((id: string) => { void discardMessage(id) }, [])

  return { waiting: waitingFor(scope).map(localMessage), enqueue, retry, discard }
}
