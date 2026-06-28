'use server'

/**
 * Portal Team Access — teammate username login.
 * Runs on the already-public /portal/login route (no middleware change needed).
 * Resolves username → the teammate's auth email server-side, then signs in
 * (sets the session cookie). Generic error on any failure — never reveal whether
 * a username exists.
 */
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { isPartner, getPartnerForUser, hasAnyPartnerScope } from '@/lib/partner-auth'
import { resolveAuthEmailForUsername } from '@/lib/portal/team/server'
import {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_MAX_FAILURES,
} from '@/lib/portal/rate-limit'

export async function teammateLogin(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  // Brute-force guard (security audit 2026-06-13, H10): lock out after
  // LOGIN_MAX_FAILURES failures per IP+username for 15 minutes. Keyed on a
  // lowercased username so the lockout follows the targeted account, plus the
  // caller IP so one attacker can't lock everyone out from a single source.
  const hdrs = headers()
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim()
    || hdrs.get('x-real-ip')
    || 'unknown'
  const rlKey = `teammate-login:${ip}:${(username || '').toLowerCase().trim()}`

  const rl = checkLoginRateLimit(rlKey)
  if (!rl.allowed) {
    return {
      ok: false,
      error: `Too many failed attempts. Please try again in about ${Math.ceil((rl.retryAfter ?? 0) / 60)} minutes.`,
    }
  }

  const email = await resolveAuthEmailForUsername(username)
  if (!email) {
    recordLoginFailure(rlKey)
    return { ok: false, error: 'Invalid username or password' }
  }

  const supabase = createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    recordLoginFailure(rlKey)
    return { ok: false, error: 'Invalid username or password' }
  }

  // Success — reset the counter so a legitimate user isn't penalized later.
  clearLoginFailures(rlKey)
  return { ok: true }
}

// Surface the constant so callers/tests reference one source of truth.
export const TEAMMATE_LOGIN_MAX_FAILURES = LOGIN_MAX_FAILURES

/**
 * Login-admission gate for a freshly-authenticated partner. The login page is a
 * client component and only sees app_metadata (role, contact_id) — partner_scope
 * lives in the RLS-protected client_partners table, so the check must run
 * server-side (service role). Returns true only when the caller is a partner
 * with a NON-EMPTY scope; a scopeless / unlinked partner is rejected so a rogue
 * partner account never holds a usable session. Per-surface scope (e.g.
 * 'td_communication' for /collab) is still enforced separately at each surface.
 */
export async function partnerLoginAllowed(): Promise<boolean> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isPartner(user)) return false
  const partner = await getPartnerForUser(user)
  return hasAnyPartnerScope(partner?.partner_scope)
}
