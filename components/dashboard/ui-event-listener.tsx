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
import { useWakeSignal } from '@/lib/hooks/use-wake-signal'

/** kind → react-query keys to invalidate */
const UI_EVENT_QUERY_KEYS: Record<string, string[]> = {
  todo: ['open-message-actions', 'action-board-columns', 'portal-chat-whats-new-counts'],
  tasks: ['portal-chat-thread-tasks'],
  // BOTH note feeds, plus Staff Alerts (a read computed FROM the same notes/replies —
  // no separate emit needed, it rides the existing 'notes' kind for free).
  // 'staff-notes-active' alone left the Notes page (which reads 'staff-notes-all')
  // stale on a change made in another tab or by a teammate — local mutations
  // invalidated both by hand, the bus only the first.
  notes: ['staff-notes-active', 'staff-notes-all', 'staff-alerts'],
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

/**
 * Query keys refreshed when the user COMES BACK to the app after being away.
 *
 * This is deliberately its OWN list and not a reuse of the two registries above.
 * Those exist to route a specific DB event; between them they cover 8 keys and
 * omit the two things a returning user is most likely to be staring at — the
 * open client conversation and the open staff DM. Reusing them would have been
 * convenient and wrong (caught by the senior engineer and the bug hunter, who
 * both landed on it independently).
 *
 * EVERY key here was checked GET-by-GET for Gmail/Drive. Check the GET handler
 * specifically, not the route file: several routes call Gmail in POST (sending)
 * while their GET is pure DB — /api/portal/chat is exactly that, and a
 * file-level grep marks it expensive and is wrong.
 *
 * ⛔ NEVER add these — their GET hits Gmail live, and the default INBOX list is
 * ~300 metadata calls per load. A bulk action has already starved the per-user
 * Gmail quota and blanked the inbox (docs/systems/inbox.md):
 *     inbox-conversations, inbox-messages, inbox-stats,
 *     gmail-labels, client-emails, email-unread
 * Those surfaces stay fresh via Gmail push + their own polls, which is correct.
 */
const WAKE_QUERY_KEYS = [
  // Portal chats — the thread list AND the conversation currently on screen.
  'portal-chat-threads',
  'portal-chat-messages',
  'portal-chat-whats-new-counts',
  'portal-chat-thread-tasks',
  // Team workspace — the DM list AND the open thread.
  'internal-threads',
  'internal-thread-messages',
  // To-Do board / action cards.
  'action-board-columns',
  'open-message-actions',
  'message-actions',
  // Per-client activity panels.
  'entity-summary-todos',
  'entity-summary-whatsnew',
  'entity-summary-workflow',
  'thread-whats-new',
  // Staff sticky notes (both feeds — see the note on UI_EVENT_QUERY_KEYS) + Staff Alerts.
  'staff-notes-active',
  'staff-notes-all',
  'staff-alerts',
  // WhatsApp thread messages (stored in our DB, not fetched live).
  'whatsapp-messages',
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
      .subscribe((status) => {
        // This channel is the CRM's cross-tab bus and was a bare .subscribe():
        // a dropped socket was silently permanent and nobody could tell.
        //
        // supabase-js rejoins on its own (RealtimeChannel schedules a rejoin
        // timer on error/timeout, RealtimeClient reconnects the socket with
        // stepped backoff) — so we deliberately do NOT add a retry ladder here.
        // A previous attempt did, and tearing the channel down on each retry
        // fought the library's own rejoin and could leave the socket manually
        // disconnected FOREVER. Two states are the exception: the library
        // abandons the channel on CLOSED and on a postgres_changes binding
        // mismatch, removing it from the socket with no timer pending. Those
        // need exactly one re-create, which is what the remount below does.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`[ui-events] channel ${status}`)
        }
        if (status === 'SUBSCRIBED') {
          // A rejoin re-fires SUBSCRIBED on the SAME channel (its receive hooks
          // survive the resend), and postgres_changes has NO REPLAY — anything
          // that landed while we were disconnected is gone. So catch up on
          // authoritative state. Must be idempotent: SUBSCRIBED can fire more
          // than once per rejoin.
          for (const key of WAKE_QUERY_KEYS) {
            queryClient.invalidateQueries({ queryKey: [key] })
          }
        }
      })

    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── COME BACK TO THE APP → CATCH UP ──────────────────────────────────────
  // The socket's own recovery can take ~25-50s to even notice it died (that is
  // the heartbeat interval, and timers are frozen while the app is suspended),
  // so waiting for the rejoin is not good enough. This is the trigger that
  // makes the CRM current the moment Antonio switches back to it.
  //
  // invalidateQueries defaults to refetchType 'active', so only MOUNTED queries
  // actually re-request — the rest are just marked stale. No Gmail key is in
  // the list, so a tab-back can never re-run the ~300-call inbox query.
  useWakeSignal({
    onWake: () => {
      for (const key of WAKE_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      // Server-rendered dashboard pages don't live in react-query. Reuse the
      // same throttle the ui_events path uses so a wake plus a burst of events
      // can't stack refreshes.
      const now = Date.now()
      if (now - lastRefreshRef.current > REFRESH_THROTTLE_MS) {
        lastRefreshRef.current = now
        router.refresh()
      }
    },
  })

  return null
}
