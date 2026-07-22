'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'

/**
 * Shared realtime CONNECTION LIFECYCLE for browser subscriptions.
 *
 * WHY THIS EXISTS (2026-07-22, Antonio: "the portal should refresh itself, I
 * shouldn't have to reload"). Before this hook, all 17 hand-rolled channels in
 * the app called `.subscribe()` bare — no status callback, no reconnect, no
 * wake-from-background handling. Antonio runs the whole CRM as an installed
 * phone PWA, and docs/systems/pwa.md records that "a backgrounded phone PWA is
 * a live controlled client for weeks". The socket dies while the phone sleeps,
 * nothing notices, and the user returns to a screen that looks current and is
 * frozen.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ────────────────────────────────────
 * Reconnecting is NOT enough, and reconnect-without-resync is WORSE than doing
 * nothing. Postgres changefeeds have NO REPLAY: resubscribing resumes the
 * stream from *now*. Every consumer in this codebase applies deltas
 * (`setCount(prev => prev + 1)`, append-to-list), so anything that arrived
 * during the outage is lost permanently — the badge stays N low and the missed
 * messages never appear, while the UI now looks confidently live.
 *
 * Therefore `onResync` is REQUIRED, not optional, and it fires on every
 * successful (re)subscribe AND whenever the tab becomes visible. Consumers must
 * use it to refetch AUTHORITATIVE state (a count endpoint, a list refetch, a
 * router.refresh()), never to resume a delta stream. If you find yourself
 * passing an empty onResync, you are re-introducing the exact bug this hook
 * exists to prevent.
 *
 * ── SCOPE: CONNECTION ONLY ────────────────────────────────────────────────
 * This hook deliberately does NOT touch payloads and does NOT debounce. Two
 * existing consumers have delta semantics that a shared coalescing layer would
 * silently corrupt: the portal sidebar badge needs each individual UPDATE's
 * `payload.old` (via REPLICA IDENTITY FULL) to decide +1 vs -1, and the portal
 * chat hook attaches per-filter handler PAIRS whose insert/update distinction
 * would be lost. Handlers are attached by the consumer in `setup` and receive
 * raw payloads. Debounce, if needed, belongs to the consumer.
 *
 * Client-side only. Never open a realtime channel from a server route with the
 * service key — that leaks a socket per warm serverless instance.
 */
export interface UseRealtimeChannelOptions {
  /** Stable channel name. Changing it tears down and re-subscribes. */
  channelName: string
  /** Attach handlers here. Called once per (re)subscribe with a fresh channel. */
  setup: (channel: RealtimeChannel) => RealtimeChannel
  /**
   * REQUIRED. Refetch authoritative state — a count, a list, a router.refresh().
   * Fires on every successful (re)subscribe and on tab-visible. See the note
   * above: this is what makes reconnect safe rather than actively misleading.
   */
  onResync: () => void
  /** Set false to skip subscribing entirely (e.g. no contact id yet). */
  enabled?: boolean
}

const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
/** Don't hammer a resync when the tab is toggled rapidly. */
export const RESYNC_MIN_INTERVAL_MS = 3_000

/**
 * Reconnect backoff. Exported as a pure function so the policy is unit-tested:
 * this repo has no React test environment (node-only vitest), so the wiring is
 * verified in the browser and the DECISIONS are verified here.
 */
export function nextRetryDelayMs(attempt: number): number {
  if (attempt < 0) return BASE_RETRY_MS
  // 2 ** large overflows to Infinity; Math.min still clamps, but guard anyway.
  const raw = BASE_RETRY_MS * 2 ** attempt
  return Number.isFinite(raw) ? Math.min(raw, MAX_RETRY_MS) : MAX_RETRY_MS
}

/**
 * Throttle gate for resyncs. Rapid tab-flipping must not storm the server, but
 * a genuine wake after minutes/days must always get through.
 */
export function shouldResync(lastResyncAt: number, now: number): boolean {
  return now - lastResyncAt >= RESYNC_MIN_INTERVAL_MS
}

export function useRealtimeChannel({ channelName, setup, onResync, enabled = true }: UseRealtimeChannelOptions) {
  // Refs so a consumer re-render (new closure identity) never tears down and
  // re-subscribes the socket — that would reconnect-loop on every keystroke.
  const setupRef = useRef(setup)
  const onResyncRef = useRef(onResync)
  useEffect(() => { setupRef.current = setup }, [setup])
  useEffect(() => { onResyncRef.current = onResync }, [onResync])

  const lastResyncRef = useRef(0)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const supabase = createClient()
    let channel: RealtimeChannel | null = null

    const resync = () => {
      const now = Date.now()
      if (!shouldResync(lastResyncRef.current, now)) return
      lastResyncRef.current = now
      try {
        onResyncRef.current()
      } catch (err) {
        console.error(`[realtime:${channelName}] resync threw:`, err)
      }
    }

    const scheduleReconnect = () => {
      if (cancelled || retryTimer) return
      // Exponential backoff capped at MAX_RETRY_MS. `attempt` also re-runs this
      // effect, which builds a brand-new channel — Supabase does not reliably
      // revive a channel that has already errored out.
      const delay = nextRetryDelayMs(attempt)
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!cancelled) setAttempt(a => a + 1)
      }, delay)
    }

    channel = setupRef.current(supabase.channel(channelName))

    channel.subscribe((status) => {
      if (cancelled) return
      if (status === 'SUBSCRIBED') {
        // Reset backoff and catch up on whatever we missed while disconnected.
        if (attempt !== 0) setAttempt(0)
        resync()
        return
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // Bare .subscribe() used to swallow this entirely — the screen simply
        // stopped updating with no signal to anyone.
        console.warn(`[realtime:${channelName}] ${status} — reconnecting`)
        scheduleReconnect()
      }
    })

    // Wake-from-background. A phone PWA can sit suspended for days; on return we
    // resync unconditionally (cheap, throttled) and rebuild the channel if it is
    // no longer joined.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || cancelled) return
      resync()
      if (channel && channel.state !== 'joined') {
        console.warn(`[realtime:${channelName}] socket not joined on wake (${channel.state}) — reconnecting`)
        scheduleReconnect()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onVisibility)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onVisibility)
      if (channel) supabase.removeChannel(channel)
    }
  }, [channelName, enabled, attempt])
}
