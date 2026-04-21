'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { PortalMessage } from '@/lib/types'

/**
 * Real-time chat hook using Supabase Realtime.
 * Supports both account-based and contact-based chat.
 * - accountId: for LLC-specific conversations (most clients)
 * - contactId: for contacts without accounts (ITIN clients, leads)
 */
export function usePortalChat(accountId: string | null, contactId: string) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  // Determine which param to use for API calls
  const queryParam = accountId ? `account_id=${accountId}` : `contact_id=${contactId}`
  const filterColumn = accountId ? 'account_id' : 'contact_id'
  const filterValue = accountId || contactId

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
          body: JSON.stringify(accountId ? { account_id: accountId } : { contact_id: contactId }),
        }).catch(() => {})
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [accountId, contactId, queryParam])

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
    const channel = supabase
      .channel(`portal-chat-${filterValue}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: `${filterColumn}=eq.${filterValue}`,
        },
        (payload) => {
          const newMessage = payload.new as PortalMessage
          setMessages(prev => {
            if (prev.some(m => m.id === newMessage.id)) return prev
            return [...prev, newMessage]
          })
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'portal_messages',
          filter: `${filterColumn}=eq.${filterValue}`,
        },
        (payload) => {
          const updated = payload.new as PortalMessage & { deleted_at?: string | null }
          // Client view: a soft-delete removes the message from view entirely (decision #2 — fully vanish).
          if (updated.deleted_at) {
            setMessages(prev => prev.filter(m => m.id !== updated.id))
          }
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [filterColumn, filterValue])

  // Send message
  const sendMessage = useCallback(async (message: string, attachment?: { url: string; name: string }, replyToId?: string) => {
    if ((!message.trim() && !attachment) || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId || undefined,
          contact_id: contactId,
          message: message || (attachment ? `[Attachment: ${attachment.name}]` : ''),
          attachment_url: attachment?.url,
          attachment_name: attachment?.name,
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

  return { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore, refresh }
}
