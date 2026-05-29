'use server'

/**
 * Portal Team Access — teammate username login.
 * Runs on the already-public /portal/login route (no middleware change needed).
 * Resolves username → the teammate's auth email server-side, then signs in
 * (sets the session cookie). Generic error on any failure — never reveal whether
 * a username exists.
 */
import { createClient } from '@/lib/supabase/server'
import { resolveAuthEmailForUsername } from '@/lib/portal/team/server'

export async function teammateLogin(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const email = await resolveAuthEmailForUsername(username)
  if (!email) return { ok: false, error: 'Invalid username or password' }

  const supabase = createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, error: 'Invalid username or password' }

  return { ok: true }
}
