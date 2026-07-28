/**
 * Visibility gate for the portal "Enable notifications" card.
 *
 * The card closes the mobile gap in the push-adoption funnel: install nudges
 * exist (dashboard install card, floating install prompt, What's New), but on
 * phones nothing asks for the notification permission after install — the
 * compact PushToggle in the header is desktop-only (hidden lg:flex in
 * app/portal/layout.tsx) and the full toggle is buried in Settings. Push is
 * the thing that stops the fallback notification EMAILS, so the card shows
 * exactly when enabling it is possible and missing.
 *
 * Pure function so the rules are unit-testable without a browser.
 */

export const PUSH_CARD_SNOOZE_DAYS = 30
export const PUSH_CARD_DISMISS_KEY = 'enable-push-card-dismissed'

export interface PushCardEnv {
  /** Running as an installed PWA (display-mode: standalone). iOS only allows
   * web push inside the installed app, so standalone is the precondition. */
  standalone: boolean
  /** Browser exposes serviceWorker + PushManager. */
  pushSupported: boolean
  permission: NotificationPermission
  /** An active push subscription already exists for this device. */
  subscribed: boolean
  /** Timestamp (ms) of the last dismissal, or null if never dismissed. */
  dismissedAt: number | null
  /** Current time (ms) — injected for testability. */
  now: number
}

export function shouldShowEnablePushCard(env: PushCardEnv): boolean {
  if (!env.standalone) return false
  if (!env.pushSupported) return false
  // 'denied' can only be undone in OS/browser settings — a card with a button
  // that always fails would be worse than nothing.
  if (env.permission === 'denied') return false
  if (env.subscribed) return false
  if (env.dismissedAt !== null) {
    const snoozeMs = PUSH_CARD_SNOOZE_DAYS * 24 * 60 * 60 * 1000
    if (env.now - env.dismissedAt < snoozeMs) return false
  }
  return true
}
