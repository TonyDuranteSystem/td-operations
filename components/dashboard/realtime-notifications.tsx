'use client'

import { useEffect, useRef, useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { MessageSquare, CreditCard, PenTool, FileText } from 'lucide-react'
import { channelNotifiesStaff } from '@/lib/team/channel-notify'

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
  const currentUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // Fetch the current user ID once so we can filter out own messages
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      currentUserIdRef.current = data.user?.id ?? null
    })
  }, [])

  // Thread ids that should ping me: the DMs I'm in, the client conversations I'm
  // a participant of (opened / posted / shared into), AND every WORK CHANNEL.
  //
  // Channels were deliberately excluded until 2026-07-24 ("never plain channel
  // chatter"). Antonio: "There is only Luca and me... I have to know everything
  // because I work on the bugs." So a channel post now pops up here too — the
  // same rule the send route uses to decide the push, read from the SAME
  // predicate (channelNotifiesStaff) so the phone and the screen cannot
  // disagree about what is worth telling you.
  //
  // Refreshed every 60s so a brand-new DM, conversation or channel starts
  // pinging within a minute.
  const myDmThreadIdsRef = useRef<Set<string>>(new Set())
  const myConversationThreadIdsRef = useRef<Set<string>>(new Set())
  const myChannelThreadIdsRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/team/threads')
        .then(r => r.json())
        .then((d: { threads?: Array<{ id: string; thread_type?: string; is_participant?: boolean; channel_slug?: string | null; channel_name?: string | null; label?: string | null }> }) => {
          if (cancelled || !Array.isArray(d.threads)) return
          myDmThreadIdsRef.current = new Set(
            d.threads.filter(t => t.thread_type === 'dm').map(t => t.id),
          )
          myConversationThreadIdsRef.current = new Set(
            d.threads.filter(t => t.thread_type === 'discussion' && t.is_participant).map(t => t.id),
          )
          myChannelThreadIdsRef.current = new Map(
            d.threads
              .filter(t => (t.thread_type === 'channel' || t.thread_type === 'general')
                && channelNotifiesStaff(t.channel_slug ?? t.channel_name ?? null))
              .map(t => [t.id, t.channel_slug ?? t.channel_name ?? t.label ?? 'team']),
          )
        })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

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
    //
    // BOTH INSERT and UPDATE. An @claude answer in Team Chat is written by
    // REPLACING the "…" placeholder message — an UPDATE — so an INSERT-only
    // listener showed a toast saying literally "…" and never showed the answer
    // that followed (found by the bug hunter, 2026-07-24). Placeholder bodies
    // are skipped on insert; the update that replaces one is what pops up.
    const PENDING_PLACEHOLDERS = ['…', '⋯']

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifyForInternalMessage = (row: any, isUpdate: boolean) => {
      // Don't notify while you are LOOKING at team chat — you can see it.
      // NOTE: /portal-chats used to be suppressed here too, which meant a team
      // message arriving while Antonio worked in Portal Chats produced no signal
      // at all (the floating chat also stays quiet there). He asked for the
      // pop-up "wherever I am", so only the team-chat page is silent.
      const p = pathnameRef.current
      if (p === '/team-chat' || p.startsWith('/team-chat/')) return

      // Don't notify for own messages.
      if (row?.sender_id && row.sender_id === currentUserIdRef.current) return
      // A soft-deleted / retracted message must never surface its body.
      if (row?.deleted_at) return

      const body = typeof row?.message === 'string' ? row.message : ''
      // "Claude is thinking" is not news. The answer arrives as an UPDATE.
      if (PENDING_PLACEHOLDERS.includes(body.trim())) return
      // An UPDATE is only interesting when it turned a placeholder into an
      // answer. Every other update (an edit, a reaction write) would otherwise
      // re-toast a message the user has already seen.
      if (isUpdate && !PENDING_PLACEHOLDERS.includes(String(row?.old_message ?? '').trim())) return

      const mine = currentUserIdRef.current
      const mentionsMe = !!mine && Array.isArray(row?.mentioned_user_ids)
        && row.mentioned_user_ids.includes(mine)
      const threadId = row?.thread_id
      const isMyDm = !!threadId && myDmThreadIdsRef.current.has(threadId)
      const isMyConversation = !!threadId && myConversationThreadIdsRef.current.has(threadId)
      const channelLabel = threadId ? myChannelThreadIdsRef.current.get(threadId) : undefined
      if (!mentionsMe && !isMyDm && !isMyConversation && !channelLabel) return

      const senderName = row?.sender_name || 'Team member'
      // Deep-link INTO the thread when the message belongs to one, so the click
      // lands on the bug rather than the channel's stream.
      const rootId = row?.root_id as string | null | undefined
      const url = threadId
        ? `/team-chat?thread=${threadId}${rootId ? `&root=${rootId}` : ''}`
        : '/team-chat'

      playSound()

      toast(
        mentionsMe ? `@mention · ${senderName}`
          : isMyDm ? `DM · ${senderName}`
          : channelLabel ? `#${channelLabel} · ${senderName}`
          : `Conversation · ${senderName}`,
        {
          description: body.slice(0, 80) || 'New team message',
          icon: <MessageSquare className="h-4 w-4 text-orange-500" />,
          duration: 6000,
          action: { label: 'Open', onClick: () => router.push(url) },
        }
      )
    }

    const internalChannel = supabase
      .channel('global-internal-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'internal_messages',
        },
        (payload) => notifyForInternalMessage(payload.new, false),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'internal_messages',
        },
        (payload) => {
          // Supabase only sends the previous row when the table is REPLICA
          // IDENTITY FULL. When it does, use it to tell "placeholder became an
          // answer" from an ordinary edit; when it doesn't, `payload.old` is
          // just the primary key and we stay SILENT rather than re-toasting
          // every edit.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const old = payload.old as any
          if (typeof old?.message !== 'string') return
          notifyForInternalMessage({ ...payload.new, old_message: old.message }, true)
        },
      )
      .subscribe()


    // ─── Listen for business events in action_log ─────────
    // No server-side filter — client-side filtering for business events only.
    // Volume is ~60-300/day total, client silently ignores non-matching types.
    const NOTIFY_TYPES = new Set(['payment_confirmed', 'ss4_signed', 'lease_signed', 'oa_signed', 'oa_partial_signed', 'form_submitted', 'form_completed'])
    const actionLogChannel = supabase
      .channel('global-action-log')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'action_log',
        },
        (payload) => {
          const actionType = payload.new?.action_type as string
          if (!NOTIFY_TYPES.has(actionType)) return // Skip non-business events silently

          const summary = (payload.new?.summary as string)?.slice(0, 80) || actionType
          const accountId = payload.new?.account_id as string | null
          const contactId = payload.new?.contact_id as string | null

          playSound()

          // Determine toast style by event category
          let title = 'Activity'
          let icon = <FileText className="h-4 w-4 text-blue-500" />
          let color = 'blue'
          let linkPath = '/'

          if (actionType === 'payment_confirmed') {
            title = 'Payment Received'
            icon = <CreditCard className="h-4 w-4 text-emerald-500" />
            color = 'emerald'
          } else if (['ss4_signed', 'lease_signed', 'oa_signed', 'oa_partial_signed'].includes(actionType)) {
            title = 'Document Signed'
            icon = <PenTool className="h-4 w-4 text-violet-500" />
            color = 'violet'
          } else {
            title = 'Form Submitted'
          }

          if (accountId) linkPath = `/accounts/${accountId}`
          else if (contactId) linkPath = `/contacts/${contactId}`

          // Suppress color lint — used for future styling
          void color

          toast(title, {
            description: summary,
            icon,
            duration: 8000,
            action: {
              label: 'View',
              onClick: () => router.push(linkPath),
            },
          })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(portalChannel)
      supabase.removeChannel(internalChannel)
      supabase.removeChannel(actionLogChannel)
    }
  }, [playSound, router])

  // This component renders nothing — it's a listener only
  return null
}
