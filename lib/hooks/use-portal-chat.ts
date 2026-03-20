'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { PortalMessage } from '@/lib/types'

/**
 * Real-time chat hook using Supabase Realtime.
 * Subscribes to portal_messages for the given account_id.
 */
export function usePortalChat(accountId: string) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  // Load initial messages + mark as read
  useEffect(() => {
    async function load() {
      setLoading(true)
      setHasMore(true)
      try {
        const res = await fetch(`/api/portal/chat?account_id=${accountId}&limit=50`)
        if (res.ok) {
          const data = await res.json()
          const msgs = data.messages ?? []
          setMessages(msgs)
          setHasMore(msgs.length >= 50)
          // Mark admin messages as read (client has seen them)
          fetch('/api/portal/chat/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id: accountId }),
          }).catch(() => {})
        }
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [accountId])

  // Load older messages
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = messages[0]
      const res = await fetch(`/api/portal/chat?account_id=${accountId}&limit=50&before=${oldest.created_at}`)
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
  }, [accountId, messages, loadingMore, hasMore])

  // Subscribe to realtime
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`portal-chat-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          const newMessage = payload.new as PortalMessage
          setMessages(prev => {
            // Avoid duplicates (from optimistic insert)
            if (prev.some(m => m.id === newMessage.id)) return prev
            return [...prev, newMessage]
          })
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [accountId])

  // Send message
  const sendMessage = useCallback(async (message: string, attachment?: { url: string; name: string }) => {
    if ((!message.trim() && !attachment) || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          message: message || (attachment ? `[Attachment: ${attachment.name}]` : ''),
          attachment_url: attachment?.url,
          attachment_name: attachment?.name,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to send')
      }

      // Add message to state immediately (don't rely solely on realtime)
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
  }, [accountId, sending])

  return { messages, loading, sending, sendMessage, loadMore, loadingMore, hasMore }
}
