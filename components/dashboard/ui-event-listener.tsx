'use client'

/**
 * UiEventListener — dashboard live-update bus, CLIENT side.
 *
 * Mounted ONCE in the dashboard layout. Subscribes via supabase_realtime to:
 *  - ui_events (server emits after writes — see lib/ui-events.ts) → maps the
 *    kind to react-query invalidations, dispatches a DOM CustomEvent
 *    ('td-ui-event') for non-react-query consumers (e.g. the action board),
 *    and throttled-router.refresh()es for server-rendered surfaces;
 *  - portal_messages INSERT → refreshes the Portal Chats thread list /
 *    counters in every open tab, no hard refresh.
 *
 * Antonio 2026-07-08: "when we work on two or three tabs, or I'm on one PC
 * and the team on another, updates must appear immediately in all tabs."
 */

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'

/** kind → react-query keys to invalidate */
const UI_EVENT_QUERY_KEYS: Record<string, string[]> = {
  todo: ['open-message-actions', 'action-board-columns', 'portal-chat-whats-new-counts'],
  tasks: ['portal-chat-thread-tasks'],
  // BOTH note feeds. 'staff-notes-active' alone left the Notes page (which reads
  // 'staff-notes-all') stale on a change made in another tab or by a teammate —
  // local mutations invalidated both by hand, the bus only the first.
  notes: ['staff-notes-active', 'staff-notes-all'],
}

/** kinds that also refresh server-rendered pages (throttled) */
const REFRESH_KINDS = new Set(['tasks'])
const REFRESH_THROTTLE_MS = 5_000

/** Query keys refreshed when a portal chat message lands anywhere */
const PORTAL_MESSAGE_KEYS = [
  'portal-chat-threads',
  'portal-chat-whats-new-counts',
  'internal-threads',
]

export function UiEventListener() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const lastRefreshRef = useRef(0)

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()

    const channel = supabase
      .channel('td-ui-event-bus')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ui_events' },
        (msg) => {
          const kind = (msg.new as { kind?: string })?.kind
          if (!kind) return
          for (const key of UI_EVENT_QUERY_KEYS[kind] ?? []) {
            queryClient.invalidateQueries({ queryKey: [key] })
          }
          document.dispatchEvent(
            new CustomEvent('td-ui-event', { detail: { kind, payload: (msg.new as { payload?: unknown })?.payload } })
          )
          if (REFRESH_KINDS.has(kind)) {
            const now = Date.now()
            if (now - lastRefreshRef.current > REFRESH_THROTTLE_MS) {
              lastRefreshRef.current = now
              router.refresh()
            }
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'portal_messages' },
        () => {
          for (const key of PORTAL_MESSAGE_KEYS) {
            queryClient.invalidateQueries({ queryKey: [key] })
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
