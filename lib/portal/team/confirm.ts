/**
 * Team Powers — confirming a grant of powers: the owner accepts the notice AND re-enters their own password, in the SAME request.
 *
 * Why the password again: a stolen or left-open browser session must not be able to hand a stranger access to the company.
 * Why in the same request: a "confirmed" flag set in one call and used in another could be reused; here the proof travels
 * with the action.
 *
 * Wrong guesses are limited (5 attempts lock the person out of confirming for 15 minutes). Every attempt is COUNTED BEFORE the password is
 * checked, in the shared counter (lib/portal/login-limiter.ts: one count for every server, the per-server counter only as a fallback), so a
 * burst of guesses sent at the same moment is admitted exactly up to the limit — the old check-then-count-afterwards let them all through.
 * A right password clears the count.
 *
 * `checkNoticeAcceptance` compares what the owner SAW with what the server builds from the same facts; they must match
 * word for word, so the saved text is exactly what was read.
 */
import { createClient as createBareClient } from '@supabase/supabase-js'
import { LOGIN_MAX_FAILURES } from '@/lib/portal/rate-limit'
import { defaultLoginLimiter } from '@/lib/portal/login-limiter-default'
import type { LoginLimiter } from '@/lib/portal/login-limiter'
import type { Notice } from './notice'

export interface Confirmation {
  version: string
  /** The exact words the owner read and accepted. */
  text: string
  /** Where the request came from. */
  ip: string | null
}

export type CheckResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string }

export interface PasswordCheckDeps {
  /** True when the email + password are a real sign-in (checked on a throwaway client, never touching the caller's session). */
  signIn: (email: string, password: string) => Promise<boolean>
  /** The wrong-password counter: `reserve` checks AND counts in one step, `clear` forgets the key after a right password. */
  limiter: Pick<LoginLimiter, 'reserve' | 'clear'>
}

const defaultDeps: PasswordCheckDeps = {
  signIn: async (email, password) => {
    // A THROWAWAY client: signing in on the cookie-writing client would replace the caller's session (see change-password).
    const bare = createBareClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await bare.auth.signInWithPassword({ email, password })
    return !error
  },
  // looked up at the moment of use, so importing this file never builds the database-backed counter
  limiter: {
    reserve: (key, maxFailures) => defaultLoginLimiter().reserve(key, maxFailures),
    clear: (key) => defaultLoginLimiter().clear(key),
  },
}

export async function verifyOwnerPassword(
  input: { userId: string; email: string | null | undefined; password: unknown },
  deps: PasswordCheckDeps = defaultDeps,
): Promise<CheckResult<unknown>> {
  const password = typeof input.password === 'string' ? input.password : ''
  if (!password) return { ok: false, status: 400, error: 'Enter your password to confirm.' }
  if (!input.email) return { ok: false, status: 403, error: 'Your login has no email address, so your password cannot be checked here.' }

  const key = `team-confirm:${input.userId}`
  // Check AND count in one step BEFORE the slow password check: guesses sent at the same moment cannot all pass the check first.
  const limit = await deps.limiter.reserve(key, LOGIN_MAX_FAILURES)
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil((limit.retryAfter ?? 900) / 60))
    return { ok: false, status: 429, error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }
  }

  const good = await deps.signIn(input.email, password).catch(() => false)
  if (!good) return { ok: false, status: 403, error: 'That password is not correct.' } // already counted
  await deps.limiter.clear(key)
  return { ok: true }
}

/** The owner accepted THIS notice (this version, these words). `expected` is what the server builds from the same facts. */
export function checkNoticeAcceptance(
  body: { notice_accepted?: unknown; notice_version?: unknown; notice_text?: unknown },
  expected: Notice,
  ip: string | null,
): CheckResult<{ confirmation: Confirmation }> {
  if (body.notice_accepted !== true) {
    return { ok: false, status: 400, error: 'Please tick the box to confirm that you understand and accept responsibility.' }
  }
  if (body.notice_version !== expected.version || body.notice_text !== expected.text) {
    return { ok: false, status: 409, error: 'The notice changed while you were reading it. Please read it again and confirm.' }
  }
  return { ok: true, confirmation: { version: expected.version, text: expected.text, ip } }
}
