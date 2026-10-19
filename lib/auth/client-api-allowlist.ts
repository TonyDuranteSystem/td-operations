/**
 * Which `/api/*` paths a logged-in portal CLIENT (auth role 'client') may call.
 *
 * WHY THIS EXISTS: the middleware's client bounce (`isDashboardPath`) deliberately excludes
 * `/api`, so before this allowlist an API route inherited only "is logged in". Any staff route
 * that checked only for a user — invoice send/remind/PDF, bank-feed matching, admin actions —
 * was reachable by a client with a portal login (dev job f6ea4420). Patching each route one by
 * one leaves the next new route open; this is the single doorway instead: deny-by-default for
 * clients, with the portal's own surface listed explicitly.
 *
 * Paths in the middleware's PUBLIC_PREFIXES return before the role check, so they never reach
 * this predicate and need no entry here (e.g. the signing/forms APIs, td-bank-details).
 *
 * Inventory behind this list (2026-10-02, every browser call reachable from app/portal,
 * components/portal, lib/portal and the shared components they import):
 *   - everything under /api/portal/            — the client-facing portal API family
 *   - /api/forms/lookup/{token}/{code}         — app/portal/form/[token]/[access_code]
 *   - /api/td-communication/ai/generate        — wizard AI text (route itself checks isClient);
 *                                                EXACT path: the rest of /api/td-communication
 *                                                holds partner and staff routes.
 *
 * WARNING — /api/portal/ is NOT client-only. It also hosts STAFF routes (admin/create-user,
 * admin/notify-launch, decisions/create, resolve-issue, chat/search-accounts, chat/polish, ...).
 * This allowlist lets clients through to all of /api/portal/, so every staff route placed there
 * MUST carry its own staff check (requireStaffRoute / isDashboardUser). Prefer putting new
 * staff routes outside /api/portal/, where this middleware guard protects them by default.
 *
 * Adding a CLIENT portal feature that calls a new non-/api/portal path? Add it here in the same
 * change (the scan test in tests/unit/client-api-allowlist.test.ts will fail until you do).
 * A missing entry fails CLOSED: the client sees a 403, never staff data.
 */

export const CLIENT_API_PREFIXES: readonly string[] = ['/api/portal/', '/api/forms/lookup/']

export const CLIENT_API_EXACT_PATHS: readonly string[] = ['/api/td-communication/ai/generate']

/** True when a client session may reach this `/api` pathname. */
export function isClientAllowedApiPath(pathname: string): boolean {
  if (CLIENT_API_EXACT_PATHS.includes(pathname)) return true
  return CLIENT_API_PREFIXES.some(prefix => pathname.startsWith(prefix))
}
