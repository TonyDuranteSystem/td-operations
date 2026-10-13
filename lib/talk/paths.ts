/**
 * Paths and address rules for TD Talk — the standalone Team Chat app (dev job c1e326dd).
 *
 * Pure on purpose (no DOM, no Next): the layout, the page, the notification pop-ups and the unit tests
 * all share ONE definition of "is this a TD Talk address", so they cannot drift apart.
 *
 * Why no trailing slash anywhere: Next answers `/talk/` with a redirect to `/talk`, and a manifest scope of
 * `/talk/` would then NOT contain the page the app really opens on (the same gap pwa.md documents for the
 * portal's `/portal` vs `/portal/`). The app's scope is therefore the plain prefix `/talk`.
 */

/** The app's one address (start_url, manifest scope and service-worker scope). */
export const TALK_BASE = '/talk'

/** The TD Talk TAB inside the CRM (left menu, above Home): the same simple chat, shown inside the CRM frame. */
export const TD_TALK_TAB = '/td-talk'

/** The CRM's own Team Chat page — what the server's notifications and links point at. */
export const TEAM_CHAT_BASE = '/team-chat'

/** True for `/talk` and anything under it — never for look-alikes such as `/talking` or `/talk-sw.js`. */
export function isTalkPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false
  return pathname === TALK_BASE || pathname.startsWith(`${TALK_BASE}/`)
}

/** True for the CRM's TD Talk tab (`/td-talk`) and anything under it. */
export function isTdTalkTabPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false
  return pathname === TD_TALK_TAB || pathname.startsWith(`${TD_TALK_TAB}/`)
}

/** The TD Talk chat in either place it lives: the standalone app (`/talk`) or the CRM tab (`/td-talk`). */
export function isTalkSurfacePath(pathname: string | null | undefined): boolean {
  return isTalkPath(pathname) || isTdTalkTabPath(pathname)
}

/** True for `/team-chat` and anything under it. */
export function isTeamChatPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false
  return pathname === TEAM_CHAT_BASE || pathname.startsWith(`${TEAM_CHAT_BASE}/`)
}

/** The base address of "the chat" for whichever app the person is in — used to build deep links. */
export function teamChatBase(pathname: string | null | undefined): string {
  if (isTdTalkTabPath(pathname)) return TD_TALK_TAB
  return isTalkPath(pathname) ? TALK_BASE : TEAM_CHAT_BASE
}

/**
 * A "where to go after login / two-step check" address, accepted ONLY when it points into TD Talk.
 * Anything else — another path, an absolute URL, `//host`, backslashes, control characters — is refused
 * (null) so the login page keeps its normal behaviour and can never be turned into an open redirect.
 */
export function safeTalkNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  const pathOnly = raw.split(/[?#]/)[0]
  return isTalkPath(pathOnly) ? raw : null
}

/**
 * Where a notification tap should land inside TD Talk. The server builds `/team-chat?thread=…` links for the
 * CRM; the TD Talk service worker applies the same rule (public/talk-sw.js — kept in step by a test):
 * a Team Chat address becomes the same query on `/talk`, a TD Talk address stays, and anything else
 * (another page, another site) becomes plain `/talk` so a tap can never leave the app.
 */
export function talkUrlFor(raw: unknown, origin: string): string {
  try {
    const u = new URL(String(raw ?? ''), origin)
    if (u.origin !== origin) return TALK_BASE
    if (isTalkPath(u.pathname)) return u.pathname + u.search + u.hash
    if (isTeamChatPath(u.pathname)) return TALK_BASE + u.search + u.hash
    return TALK_BASE
  } catch {
    return TALK_BASE
  }
}

/**
 * Add the current page's TD Talk return address (`?next=`) to another internal path, so the destination survives
 * a hop through the two-step check. Returns the path unchanged when there is no valid TD Talk address.
 * Browser-only (reads the current address) — pass `search` explicitly in tests.
 */
export function withTalkNext(path: string, search?: string): string {
  const q = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const next = safeTalkNext(new URLSearchParams(q).get('next'))
  return next ? `${path}?next=${encodeURIComponent(next)}` : path
}
