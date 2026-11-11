import { headers } from 'next/headers'
import { isAppModeUserAgent, isClientAppUserAgent } from '@/lib/app-mode/app-mode'
import { isClientAppEnabled } from '@/lib/portal-app/enabled'

/**
 * App mode for the CURRENT request (server components and layouts only). Reads the browser name once; layouts
 * hand the answer to <AppModeProvider> so client components can follow it (useAppMode).
 */
export function getAppMode(): boolean {
  return isAppModeUserAgent(headers().get('user-agent'))
}

/** The same for the CLIENT iPhone app (portal pages only): true when the browser name carries `TDClient/`. */
export function getClientAppMode(): boolean {
  return isClientAppUserAgent(headers().get('user-agent'))
}

/**
 * Client app mode that FOLLOWS THE SWITCH (bug hunt 2026-11-10, finding 3): the browser name carries `TDClient/` AND `client_app_enabled` is on.
 * When Antonio turns the app off (or the settings read fails: it fails closed) the phone's pages draw as the normal website, with its own side menu
 * and sign-out, instead of leaving a person on an app-style page with no bar, no Menu list and no way out (the app's native bar is hidden when the
 * server answers "not switched on"). Every portal page that draws app-only things asks THIS, never `getClientAppMode()` directly.
 */
export async function getClientAppModeActive(): Promise<boolean> {
  if (!getClientAppMode()) return false
  return isClientAppEnabled()
}
