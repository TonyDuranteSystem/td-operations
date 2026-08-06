/**
 * PWA install-funnel events — shared types, validation, and client helper.
 * (Phase 2 of install adoption, dev job 8f38add1.)
 *
 * The table (`pwa_events`) is anonymous funnel telemetry ONLY. Per-account
 * "receiving push" truth is derived live from `push_subscriptions` in
 * lib/portal/pwa-stats.ts — never stored here (council D6b: a stored flag
 * goes stale-true forever; subscriptions self-prune on dead endpoints).
 *
 * Validation is a pure function so the server route's acceptance rules are
 * unit-testable without HTTP.
 */

import { INSTALL_SRC_VALUES, type InstallDevice, type InstallSrc } from './install-page-mode'

export const PWA_EVENT_VALUES = [
  'page_view',
  'installed',
  'standalone_launch',
  'standalone_authenticated',
] as const

export type PwaEventName = (typeof PWA_EVENT_VALUES)[number]

export const PWA_DEVICE_VALUES = ['android', 'ios', 'desktop'] as const

/** Once-per-device dedup keys (localStorage). Cleared only when the browser
 *  profile is wiped — acceptable: these gate telemetry, not behavior. */
export const PWA_DEDUP_KEYS = {
  installed: 'pwa-evt-installed',
  standaloneLaunch: 'pwa-evt-standalone-launch',
  standaloneAuthenticated: 'pwa-evt-standalone-auth',
} as const

export interface PwaEventPayload {
  event: PwaEventName
  src?: InstallSrc
  device?: InstallDevice
}

const MAX_BODY_KEYS = 3

/**
 * Strict payload validation for the public endpoint: known event, known src,
 * known device, NO unknown fields (an anonymous endpoint must never store
 * attacker-shaped data). Returns null on anything off-spec.
 */
export function parsePwaEventPayload(body: unknown): PwaEventPayload | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length > MAX_BODY_KEYS) return null
  if (keys.some(k => !['event', 'src', 'device'].includes(k))) return null

  const event = record.event
  if (typeof event !== 'string' || !(PWA_EVENT_VALUES as readonly string[]).includes(event)) {
    return null
  }

  const out: PwaEventPayload = { event: event as PwaEventName }

  if (record.src !== undefined) {
    if (
      typeof record.src !== 'string' ||
      !(INSTALL_SRC_VALUES as readonly string[]).includes(record.src)
    ) return null
    out.src = record.src as InstallSrc
  }

  if (record.device !== undefined) {
    if (
      typeof record.device !== 'string' ||
      !(PWA_DEVICE_VALUES as readonly string[]).includes(record.device)
    ) return null
    out.device = record.device as InstallDevice
  }

  return out
}

/** Fire-and-forget client-side event post. Never throws, never surfaces an
 *  error to the user — telemetry must not break the page (R099 does not
 *  apply: there is nothing actionable for a client in a failed event log). */
export function postPwaEvent(payload: PwaEventPayload): void {
  if (typeof window === 'undefined') return
  try {
    void fetch('/api/portal/pwa-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch { /* ignore */ }
}

/** Post an event at most once per device (localStorage-gated). */
export function postPwaEventOnce(
  dedupKey: string,
  payload: PwaEventPayload,
): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (localStorage.getItem(dedupKey)) return false
    localStorage.setItem(dedupKey, String(Date.now()))
  } catch {
    return false
  }
  postPwaEvent(payload)
  return true
}
