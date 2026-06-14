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
