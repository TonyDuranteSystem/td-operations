/**
 * THE DOOR RULE (TD Marketing P1, dev job 9aec66fa) — pure, no I/O, client-safe.
 *
 * One place that says which kinds of login exist and what a marketing login may open. The middleware calls it for
 * every logged-in request. Everything is CLOSED unless it is on a list: a kind of login this file does not know is
 * turned away (an empty or misspelled role used to count as staff).
 *
 * Roles (auth app_metadata.role, writable only by the service role):
 *   admin, team   — TD staff (see isStaffAuthRole in lib/team/workspace.ts)
 *   client        — portal clients (confined by their own pages/API allow-list, lib/auth/client-api-allowlist.ts)
 *   partner       — external collaborators (confined in the middleware to /collab)
 *   marketing     — Rocco's team: owner and member are DATA (team membership), not different roles
 *
 * Public paths (webhooks, forms, login …) return in the middleware BEFORE any role check and never reach this file.
 */

export const KNOWN_AUTH_ROLES = ['admin', 'team', 'client', 'partner', 'marketing'] as const
export type KnownAuthRole = (typeof KNOWN_AUTH_ROLES)[number]

export const MARKETING_ROLE = 'marketing'
/** Where a marketing login lands, and where a refused marketing page request is sent. */
export const MARKETING_HOME = '/marketing'

export function normalizeRole(role: unknown): string {
  return typeof role === 'string' ? role.trim().toLowerCase() : ''
}

export function isKnownAuthRole(role: unknown): role is KnownAuthRole {
  return (KNOWN_AUTH_ROLES as readonly string[]).includes(normalizeRole(role))
}

export function isMarketingRole(role: unknown): boolean {
  return normalizeRole(role) === MARKETING_ROLE
}

/** Roles that must pass the two-step check: staff (decided elsewhere) and marketing. */
export function isMarketingMfaSubject(role: unknown): boolean {
  return isMarketingRole(role)
}

/**
 * Pages a marketing login may open: the workspace and the two-step pages (exact — enrolling and verifying must be
 * reachable before the second step is done). Nothing else, including "/".
 */
const MARKETING_PAGE_PREFIXES = ['/marketing/'] as const
const MARKETING_PAGE_EXACT = ['/marketing', '/mfa/verify', '/mfa/enroll'] as const

/** APIs a marketing login may call: its own family, the two-step endpoints it needs, nothing else. */
const MARKETING_API_PREFIXES = ['/api/marketing/'] as const
const MARKETING_API_EXACT = ['/api/mfa/backup-verify', '/api/mfa/backup-codes', '/api/mfa/remember'] as const

/** True when a marketing login may reach this pathname (page or API). Everything else is refused. */
export function isMarketingAllowedPath(pathname: string): boolean {
  const p = pathname.split('?')[0].split('#')[0]
  if (p.includes('..') || p.includes('//') || p.includes('\\')) return false
  if ((MARKETING_PAGE_EXACT as readonly string[]).includes(p)) return true
  if ((MARKETING_API_EXACT as readonly string[]).includes(p)) return true
  if (MARKETING_PAGE_PREFIXES.some(x => p.startsWith(x))) return true
  if (MARKETING_API_PREFIXES.some(x => p.startsWith(x))) return true
  return false
}

const PARTNER_EXACT = ['/collab'] as const
const PARTNER_PREFIXES = ['/collab/', '/api/conversations', '/api/td-communication'] as const

export function isPartnerAllowedPath(pathname: string): boolean {
  const p = pathname.split('?')[0]
  return (PARTNER_EXACT as readonly string[]).includes(p) || PARTNER_PREFIXES.some(x => p.startsWith(x))
}

/**
 * The whole rule for one role and one pathname. admin/team: allowed (their pages are guarded by the existing
 * admin-only list and per-route checks). partner and marketing: only their lists. client: the page rules stay in the
 * middleware (clients are bounced from dashboard pages there), and /api is allow-listed by client-api-allowlist.ts.
 * Any other role: refused.
 */
export function isPathAllowedForRole(role: unknown, pathname: string): boolean {
  switch (normalizeRole(role)) {
    case 'admin':
    case 'team':
      return true
    case 'partner':
      return isPartnerAllowedPath(pathname)
    case 'marketing':
      return isMarketingAllowedPath(pathname)
    case 'client':
      return true // see above: confined by the portal rules and the client API allow-list
    default:
      return false
  }
}
