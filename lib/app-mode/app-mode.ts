/**
 * App mode — "is this page being shown inside the TD Social iPhone app?" (dev job 2072bc3e, Step 1b of the
 * approved plan; docs/systems/social-app.md).
 *
 * The native app adds ` TDSocial/<version>` to its web view's browser name (the user agent). The server reads
 * it ONCE per page load and every screen that must look different inside the app follows that one answer.
 *
 * It is a LAYOUT hint, never a security switch: the client controls its own user agent, so nothing here may
 * ever grant or hide data — every login, two-step check and permission rule runs exactly as before, app or no
 * app. (Same idea as lib/embed/embedded-request.ts, which does it for floating windows.)
 */
export const APP_MODE_UA_TOKEN = 'TDSocial/'

/** True only when the browser name carries the app's token. Anything missing or odd is a normal browser. */
export function isAppModeUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && userAgent.includes(APP_MODE_UA_TOKEN)
}

/**
 * The CLIENT iPhone app (dev job 056a70d0, docs/systems/client-app.md): its web view adds ` TDClient/<version>` to the browser name.
 * Same rules as above: a layout hint only, exact and case-sensitive, never a security switch. It is a separate token on purpose, so a
 * staff page opened in TD Social and a portal page opened in the client app can never be mistaken for each other. Only the portal
 * (`app/portal/layout.tsx`) listens for it; the staff screens keep listening for `TDSocial/`.
 */
export const CLIENT_APP_UA_TOKEN = 'TDClient/'

export function isClientAppUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && userAgent.includes(CLIENT_APP_UA_TOKEN)
}
