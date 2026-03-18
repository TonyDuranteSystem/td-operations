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
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  // Load initial messages
  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const res = await fetch(`/api/portal/chat?account_id=${accountId}&limit=50`)
        if (res.ok) {
          const data = await res.json()
          setMessages(data.messages ?? [])
        }
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [accountId])

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
  const sendMessage = useCallback(async (message: string) => {
    if (!message.trim() || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, message }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to send')
      }

      // Message will appear via realtime subscription
    } catch (error) {
      throw error
    } finally {
      setSending(false)
    }
  }, [accountId, sending])

  return { messages, loading, sending, sendMessage }
}
