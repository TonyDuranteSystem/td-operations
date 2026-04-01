'use client'

import { useEffect, useRef, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { MessageSquare } from 'lucide-react'

/**
 * Global realtime notification listener for the CRM dashboard.
 * Mounted at layout level — always active regardless of which page the user is on.
 *
 * Listens to:
 * - portal_messages (client messages) — sound + toast + badge update
 * - internal_messages (team messages) — sound + toast
 *
 * This is what makes the CRM feel like a live app instead of a static website.
 */
export function RealtimeNotifications() {
  const pathname = usePathname()
  const router = useRouter()
  const pathnameRef = useRef(pathname)
  const audioCtxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  const playSound = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext()
      }
      const ctx = audioCtxRef.current

      const play = () => {
        const now = ctx.currentTime
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0.3, now)
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35)
        gain.connect(ctx.destination)

        const osc1 = ctx.createOscillator()
        osc1.type = 'sine'
        osc1.frequency.setValueAtTime(800, now)
        osc1.connect(gain)
        osc1.start(now)
        osc1.stop(now + 0.1)

        const osc2 = ctx.createOscillator()
        osc2.type = 'sine'
        osc2.frequency.setValueAtTime(1000, now + 0.1)
        osc2.connect(gain)
        osc2.start(now + 0.1)
        osc2.stop(now + 0.25)
      }

      if (ctx.state === 'suspended') {
        ctx.resume().then(play)
      } else {
        play()
      }
    } catch {
      // Audio not available
    }
  }, [])

  useEffect(() => {
    const supabase = createClient()

    // ─── Listen for new client portal messages ───────────
    const portalChannel = supabase
      .channel('global-portal-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: 'sender_type=eq.client',
        },
        async (payload) => {
          // Don't notify if already on portal-chats page looking at this thread
          const isOnChats = pathnameRef.current === '/portal-chats'

          // Play sound regardless of which page (unless already on chats)
          if (!isOnChats) {
            playSound()
          }

          // Fetch company name for the toast
          const accountId = payload.new?.account_id
          const contactId = payload.new?.contact_id
          let senderName = 'A client'

          if (accountId) {
            const { data } = await supabase
              .from('accounts')
              .select('company_name')
              .eq('id', accountId)
              .single()
            if (data?.company_name) senderName = data.company_name
          } else if (contactId) {
            const { data } = await supabase
              .from('contacts')
              .select('full_name')
              .eq('id', contactId)
              .single()
            if (data?.full_name) senderName = data.full_name
          }

          const messagePreview = typeof payload.new?.message === 'string'
            ? payload.new.message.slice(0, 80)
            : ''

          // Show toast with click-to-navigate
          if (!isOnChats) {
            toast(
              `New message from ${senderName}`,
              {
                description: messagePreview || 'New portal chat message',
                icon: <MessageSquare className="h-4 w-4 text-blue-500" />,
                duration: 8000,
                action: {
                  label: 'Open',
                  onClick: () => {
                    if (accountId) {
                      router.push(`/portal-chats?account=${accountId}`)
                    } else {
                      router.push('/portal-chats')
                    }
                  },
                },
              }
            )
          }
        }
      )
      .subscribe()

    // ─── Listen for new internal team messages ────────────
    const internalChannel = supabase
      .channel('global-internal-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'internal_messages',
        },
        (payload) => {
          const isOnChats = pathnameRef.current === '/portal-chats'
          const senderName = payload.new?.sender_name || 'Team member'

          if (!isOnChats) {
            playSound()

            toast(
              `Team: ${senderName}`,
              {
                description: typeof payload.new?.message === 'string'
                  ? payload.new.message.slice(0, 80)
                  : 'New team message',
                icon: <MessageSquare className="h-4 w-4 text-orange-500" />,
                duration: 6000,
                action: {
                  label: 'Open',
                  onClick: () => router.push('/portal-chats'),
                },
              }
            )
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(portalChannel)
      supabase.removeChannel(internalChannel)
    }
  }, [playSound, router])

  // This component renders nothing — it's a listener only
  return null
}
