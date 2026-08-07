/**
 * THE one install-nudge brain (Phase 3 / D9, dev job 8f38add1).
 *
 * Before this module, four uncoordinated surfaces nudged install/push
 * (floating prompt with a 30-day dismiss, permanent-dismiss dashboard
 * banner, snoozable enable-push card, install page) — a client who
 * dismissed one still got the others, and a client who installed could
 * still see stale banners. Now every portal nudge decision flows through
 * resolveInstallNudge, and there is NO dismissal input at all:
 * Antonio's explicit spec (2026-08-06, overriding the council's
 * dismissible recommendation) is that the nudge is FIXED — it disappears
 * only when the client is installed AND receiving push. It must never
 * block reading or answering messages: it renders as a compact in-flow
 * banner, never a modal or interstitial.
 *
 * Pure function so the rules are unit-testable without a browser.
 */

export type InstallNudge = 'install' | 'push' | 'none'

export interface InstallNudgeEnv {
  /** Viewport/UA says phone or tablet (the install nudge is mobile-only —
   *  desktop browsers get the sidebar "Get the app" entry instead). */
  isMobile: boolean
  /** Running as the installed app (display-mode: standalone). */
  standalone: boolean
  /** Browser exposes serviceWorker + PushManager. */
  pushSupported: boolean
  permission: NotificationPermission
  /** An active push subscription already exists for this device. */
  subscribed: boolean
}

export function resolveInstallNudge(env: InstallNudgeEnv): InstallNudge {
  // Funnel complete on this device → total silence everywhere (D9).
  if (env.standalone && env.subscribed) return 'none'

  // Installed but not receiving push → the push stage, on any device
  // (standalone desktop installs exist too; the ask is identical).
  if (env.standalone) {
    if (!env.pushSupported) return 'none'
    // 'denied' is only reversible in OS settings — a button that always
    // fails is worse than nothing (rule inherited from the retired
    // push-card-visibility gate).
    if (env.permission === 'denied') return 'none'
    return 'push'
  }

  // Not installed → the install stage, mobile browsers only.
  if (env.isMobile) return 'install'

  return 'none'
}
