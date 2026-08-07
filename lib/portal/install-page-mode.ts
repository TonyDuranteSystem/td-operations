/**
 * Pure mode/language resolver for the public PWA install page
 * (/portal/install). All branching lives here, unit-testable without a
 * browser; the page component only feeds the environment in and renders the
 * returned mode. (Same pure-gate pattern as lib/portal/install-state.ts.)
 *
 * Council-reviewed decisions baked in (dev job 8f38add1, 2026-08-06):
 * - iPadOS masquerades as a Mac (desktop UA) — only the client can correct it
 *   via platform + maxTouchPoints, so the server first-paint may say desktop
 *   and the client refinement must win.
 * - iOS in-app WebViews (Gmail, Instagram…) cannot Add-to-Home-Screen and
 *   SFSafariViewController is UA-identical to Safari — detection is BEST
 *   EFFORT ONLY. The iOS UI must always show the "Open in Safari" escape
 *   hatch regardless of the detected mode; 'ios-inapp' merely escalates it.
 * - Android's beforeinstallprompt may never fire (already installed, older
 *   browser, WebView) — the Install button must degrade to manual ⋮-menu
 *   instructions after a timeout instead of sitting dead.
 */

export type InstallDevice = 'android' | 'ios' | 'desktop'

/** How far the client got waiting for Android's beforeinstallprompt. */
export type InstallPromptState = 'waiting' | 'captured' | 'timeout'

export type InstallPageMode =
  | 'installed'
  | 'ios-safari'
  | 'ios-inapp'
  | 'android-waiting'
  | 'android-prompt'
  | 'android-manual'
  | 'desktop'

export type InstallLanguage = 'en' | 'it'

/** Channel tags accepted on ?src= — anything else is dropped, never stored.
 *  Keep identical to the pwa_events src CHECK constraint (last synced by
 *  migration 20260806-2130-pwa-src-portal-nudge.sql). */
export const INSTALL_SRC_VALUES = [
  'qr-print',
  'qr-desktop',
  'email-sig',
  'chat',
  'fallback-email',
  'onboarding',
  'campaign',
  'guide',
  'portal-nudge',
] as const

export type InstallSrc = (typeof INSTALL_SRC_VALUES)[number]

/** sessionStorage key the Phase-2 events endpoint will read for attribution. */
export const INSTALL_SRC_STORAGE_KEY = 'pwa-install-src'

export function normalizeInstallSrc(raw: string | null | undefined): InstallSrc | null {
  if (!raw) return null
  return (INSTALL_SRC_VALUES as readonly string[]).includes(raw) ? (raw as InstallSrc) : null
}

/**
 * Device family from the user agent. Server-side there is no touch info, so
 * iPadOS-with-desktop-UA resolves to 'desktop' — the client refinement passes
 * platform/maxTouchPoints and corrects it.
 */
export function detectDevice(
  userAgent: string,
  touch?: { platform?: string; maxTouchPoints?: number },
): InstallDevice {
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios'
  // An explicit Android UA always wins — checked BEFORE the iPadOS heuristic,
  // because emulators/DevTools pair an Android UA with the host's MacIntel
  // platform and multi-touch, which would misroute Android to the iOS guide
  // (caught in browser QA, 2026-08-06).
  if (/Android/i.test(userAgent)) return 'android'
  // iPadOS 13+ default "Request Desktop Website": Macintosh UA, but Macs have
  // no multi-touch — maxTouchPoints > 1 is the documented tell.
  if (touch?.platform === 'MacIntel' && (touch.maxTouchPoints ?? 0) > 1) return 'ios'
  return 'desktop'
}

// Known in-app browser markers. Deliberately incomplete (SFSafariViewController
// is undetectable) — see module header: iOS always shows the Safari hatch.
const IN_APP_BROWSER_RE =
  /(Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger|Snapchat|LinkedInApp|Twitter|GSA\/|; ?wv\))/i

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP_BROWSER_RE.test(userAgent)
}

export interface InstallModeEnv {
  device: InstallDevice
  /** display-mode: standalone, or navigator.standalone on iOS. */
  standalone: boolean
  inAppBrowser: boolean
  installPrompt: InstallPromptState
}

export function resolveInstallPageMode(env: InstallModeEnv): InstallPageMode {
  if (env.standalone) return 'installed'
  if (env.device === 'ios') return env.inAppBrowser ? 'ios-inapp' : 'ios-safari'
  if (env.device === 'android') {
    // Android WebViews can't fire beforeinstallprompt — go straight to the
    // manual path (which tells the user to open the page in Chrome).
    if (env.inAppBrowser) return 'android-manual'
    switch (env.installPrompt) {
      case 'captured':
        return 'android-prompt'
      case 'timeout':
        return 'android-manual'
      default:
        return 'android-waiting'
    }
  }
  return 'desktop'
}

/**
 * Pick EN/IT for the sessionless public page. Accepts an Accept-Language
 * header string or navigator.languages-style array. Highest q-ranked match of
 * a supported language wins; anything else falls back to English.
 */
export function resolveInstallLanguage(
  input: string | readonly string[] | null | undefined,
): InstallLanguage {
  if (!input) return 'en'
  const parts = Array.isArray(input) ? input : String(input).split(',')
  const ranked = parts
    .map((part, index) => {
      const [tag, ...params] = String(part).trim().split(';')
      const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='))
      const parsed = qParam ? parseFloat(qParam.slice(2)) : 1
      // Stable order for equal q: earlier tags keep priority.
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(parsed) ? parsed : 0, index }
    })
    .filter(entry => entry.tag)
    .sort((a, b) => (b.q - a.q) || (a.index - b.index))
  for (const { tag } of ranked) {
    if (tag === 'it' || tag.startsWith('it-')) return 'it'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}
