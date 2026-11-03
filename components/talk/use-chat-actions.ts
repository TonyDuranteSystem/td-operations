'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newClientId } from '@/lib/chat/client-id'
import { enqueueAction, flushActions, loadActions, onActionDone, onActionFailed, subscribeActions, waitingActions } from '@/lib/talk/outbox-actions'
import type { ChatAction } from '@/lib/talk/outbox-actions-rules'

const NONE: ChatAction[] = []

/** What the screen asks to queue: the rest (id, chat, person, time) is filled in here. */
export type QueueActionInput =
  | { kind: 'edit'; messageId: string; text: string }
  | { kind: 'delete'; messageId: string }
  | { kind: 'react'; messageId: string; emoji: string; on: boolean }

/**
 * The queue of changes to sent messages (edit / delete / react) for the open chat (TD Talk): `queue` keeps a change on the phone and sends it as soon as it can (it returns at once);
 * `waiting` are the changes of this chat not yet on the server, to be laid over the messages (`overlayActions`); `onDone` hands over the server's answer; `onFailed` says why a change was refused.
 * Sending runs for every chat of this person and starts again by itself when the connection or the app comes back.
 */
export function useChatActions({ threadId, userId, onDone, onFailed }: {
  threadId: string | null
  userId: string | null
  onDone: (action: ChatAction, result: unknown) => void
  onFailed: (action: ChatAction, error: string) => void
}) {
  const [version, bump] = useState(0)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const threadRef = useRef(threadId)
  threadRef.current = threadId

  useEffect(() => subscribeActions(() => bump(n => n + 1)), [])
  useEffect(() => onActionDone((a, r) => onDoneRef.current(a, r)), [])
  useEffect(() => onActionFailed((a, e) => onFailedRef.current(a, e)), [])

  useEffect(() => {
    if (!userId) return
    const go = () => { void flushActions(userId) }
    void loadActions().then(go)
    const onVisible = () => { if (document.visibilityState === 'visible') go() }
    window.addEventListener('online', go)
    window.addEventListener('focus', go)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('online', go); window.removeEventListener('focus', go); document.removeEventListener('visibilitychange', onVisible) }
  }, [userId])

  const queue = useCallback(async (input: QueueActionInput): Promise<boolean> => {
    const thread = threadRef.current
    if (!userId || !thread) return false
    try {
      await enqueueAction({ ...input, id: newClientId(), threadId: thread, senderId: userId, createdAt: new Date().toISOString(), attempts: 0 } as ChatAction)
      return true
    } catch { return false }
  }, [userId])

  // a new list only when the queue really changed (the screen's message list is rebuilt from it)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const waiting = useMemo(() => (threadId && userId ? waitingActions(threadId, userId) : NONE), [threadId, userId, version])

  return { waiting, queue }
}
