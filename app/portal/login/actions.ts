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
import { resolveTeamLoginByUsername } from '@/lib/portal/team/server'
import { teamLoginAttempt, type TeamLoginDeps } from '@/lib/portal/team/login-flow'
import { defaultLoginLimiter } from '@/lib/portal/login-limiter-default'

export async function teammateLogin(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  // Guessing protection (security audit 2026-06-13 H10; reworked after the 20 Nov 2026 bug hunt): one exact spelling of a username,
  // every attempt counted BEFORE the slow steps in a counter shared by every server (database, with the per-server counter as fallback), a per-address and a per-login cap. The rules and reasons are in
  // lib/portal/team/login-guard.ts; the order of the steps is lib/portal/team/login-flow.ts (tested without a database).
  const hdrs = headers()
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim()
    || hdrs.get('x-real-ip')
    || 'unknown'

  const deps: TeamLoginDeps = {
    limiter: defaultLoginLimiter(),
    resolve: resolveTeamLoginByUsername,
    signIn: async (email, pwd) => {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithPassword({ email, password: pwd })
      return !error
    },
  }
  return teamLoginAttempt(deps, { ip, username, password })
}

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
