'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { PortalMessage, ChatAttachment } from '@/lib/types'

/**
 * Real-time chat hook using Supabase Realtime.
 *
 * PR 2 Step 6 (2026-05-05): one tagged thread per contact. The hook now
 * always threads by contact_id (regardless of accountId), so switching the
 * company switcher in the sidebar does NOT split the thread. accountId is
 * still accepted because:
 *   - Send-side: callers pass it through to tag a message as "company".
 *   - Mark-as-read: the read endpoint accepts both for back-compat.
 */
export function usePortalChat(accountId: string | null, contactId: string) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  // Thread by contact_id for normal clients (unified per-contact thread).
  // Teammates (Portal Team Access) have NO contact_id — their messages are stored
  // by account_id with contact_id NULL, so thread by account for them.
  const threadByAccount = !contactId && !!accountId
  const threadKey = threadByAccount ? 'account_id' : 'contact_id'
  const threadId = threadByAccount ? (accountId as string) : contactId
  const queryParam = `${threadKey}=${threadId}`
  const filterColumn = threadKey
  const filterValue = threadId
  // Mark-as-read body keyed to the same thread dimension.
  const readBody = threadByAccount ? { account_id: accountId } : { contact_id: contactId }

  // Load initial messages + mark as read
  const load = useCallback(async () => {
    setLoading(true)
    setHasMore(true)
    try {
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        const msgs = data.messages ?? []
        setMessages(msgs)
        setHasMore(msgs.length >= 50)
        fetch('/api/portal/chat/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readBody),
        }).catch(() => {})
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
    // readBody is derived from contactId/accountId (same inputs as queryParam).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, queryParam])

  useEffect(() => {
    load()
  }, [load])

  // Refresh without blanking the message list (keeps existing messages visible)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        const msgs = data.messages ?? []
        setMessages(msgs)
        setHasMore(msgs.length >= 50)
      }
    } catch {
      // silent
    }
  }, [queryParam])

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = messages[0]
      const res = await fetch(`/api/portal/chat?${queryParam}&limit=50&before=${oldest.created_at}`)
      if (res.ok) {
        const data = await res.json()
        const older = data.messages ?? []
        setHasMore(older.length >= 50)
        if (older.length > 0) {
          setMessages(prev => [...older, ...prev])
        }
      }
    } catch {
      // silent
    } finally {
      setLoadingMore(false)
    }
  }, [queryParam, messages, loadingMore, hasMore])

  // Subscribe to realtime
  useEffect(() => {
    const supabase = createClient()

    const handleInsert = (payload: { new: unknown }) => {
      const newMessage = payload.new as PortalMessage
      // This hook is client-only. Internal chat-event notes (sender_type='system'
      // carrying the `<!-- chat-event: -->` marker — "Client paid…", "fax to IRS")
      // must never reach the client portal, including via realtime. The server GET
      // excludes them on load; this drops any that arrive live. NOT all system
      // messages: the out-of-office auto-reply is system WITHOUT a marker and IS
      // meant for the client. See sysdoc notification-center-workflow-integration-plan.
      const nm = newMessage as { sender_type?: string; message?: string }
      if (nm.sender_type === 'system' && /<!--\s*chat-event:/.test(nm.message ?? '')) return
      setMessages(prev => {
        if (prev.some(m => m.id === newMessage.id)) return prev
        return [...prev, newMessage]
      })
    }

    const handleUpdate = (payload: { new: unknown }) => {
      const updated = payload.new as PortalMessage & { deleted_at?: string | null }
      // Client view: a soft-delete removes the message from view entirely (decision #2 — fully vanish).
      if (updated.deleted_at) {
        setMessages(prev => prev.filter(m => m.id !== updated.id))
        return
      }
      // Content edit: update the message in place so the client sees the corrected text.
      setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
    }

    // Primary subscription: messages tagged with this contact.
    let channel = supabase
      .channel(`portal-chat-${filterValue}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `${filterColumn}=eq.${filterValue}` }, handleInsert)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `${filterColumn}=eq.${filterValue}` }, handleUpdate)

    // Secondary subscription: admin messages saved with contact_id=NULL but account_id set.
    // This covers replies from the CRM dashboard and MCP tool that historically omitted contact_id.
    // ID-based dedup in handleInsert prevents duplicates for messages that match both filters.
    if (accountId) {
      channel = channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'portal_messages', filter: `account_id=eq.${accountId}` }, handleInsert)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'portal_messages', filter: `account_id=eq.${accountId}` }, handleUpdate)
    }

    channel.subscribe()
    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [filterColumn, filterValue, accountId])

  // Send message. Optional senderContext + tagAccountId let the caller
  // override the picker's tag scope (PR 2 Step 6). Default: senderContext
  // omitted, account_id falls back to the hook's accountId param.
  const sendMessage = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    replyToId?: string,
    senderContext?: 'person' | 'company',
    tagAccountId?: string | null,
    topic?: string | null,
  ) => {
    if ((!message.trim() && (!attachments || attachments.length === 0)) || sending) return

    // Resolve account_id for the message: explicit override → hook default → null.
    // 'person' tag forces account_id to null. 'company' requires an account_id.
    let resolvedAccountId: string | null
    if (senderContext === 'person') {
      resolvedAccountId = null
    } else if (senderContext === 'company') {
      resolvedAccountId = tagAccountId ?? accountId ?? null
    } else {
      resolvedAccountId = tagAccountId !== undefined ? tagAccountId : (accountId ?? null)
    }

    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: resolvedAccountId || undefined,
          contact_id: contactId,
          sender_context: senderContext,
          topic: topic || undefined,
          message: message || '',
          attachments: attachments ?? [],
          reply_to_id: replyToId || undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to send')
      }

      const { message: newMsg } = await res.json()
      if (newMsg) {
        setMessages(prev => {
          if (prev.some(m => m.id === newMsg.id)) return prev
          return [...prev, newMsg]
        })
      }
    } catch (error) {
      throw error
    } finally {
      setSending(false)
    }
  }, [accountId, contactId, sending])

  const topics = Array.from(
    new Set(messages.map(m => m.topic).filter((t): t is string => !!t))
  ).sort()

  return { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh, topics }
}
