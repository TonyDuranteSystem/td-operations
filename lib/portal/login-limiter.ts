/**
 * The wrong-password counter the team-login sign-in uses, with TWO homes for the count:
 *
 *   - the DATABASE (portal_login_attempts, one atomic function — scripts/migrations/20261121-0300-portal-login-attempts.sql): ONE count for every
 *     server. On the live site simultaneous requests are served by several servers; a count kept in each server's memory let a burst of guesses
 *     through (measured on production, 21 Nov 2026: 14 parallel guesses, none locked).
 *   - the server's MEMORY (lib/portal/rate-limit.ts): the same rules, used whenever the database counter is missing or erroring, so a database
 *     fault can never stop colleagues signing in (it falls back to exactly how it behaved before).
 *
 * `reserve` CHECKS and COUNTS an attempt in ONE atomic step (in memory: one synchronous step; in the database: one locked function call), so
 * many attempts at the same moment are admitted exactly up to the limit. A refused attempt is not counted.
 *
 * Pure of Next.js and the database client (the database call is passed in): the wiring that uses the real client is login-limiter-default.ts.
 */
import {
  checkLoginRateLimit, clearLoginFailures, recordLoginFailure, releaseLoginAttempt,
} from '@/lib/portal/rate-limit'

export interface LoginLimiter {
  /** Admit one attempt and count it, unless the key is locked (then nothing is counted and `retryAfter` says how many seconds are left). */
  reserve(key: string, maxFailures: number): Promise<{ allowed: boolean; retryAfter?: number }>
  /** Give ONE counted attempt back (the attempt turned out to be a success). Never reopens a locked key. */
  release(key: string): Promise<void>
  /** Forget the key (the sign-in worked). */
  clear(key: string): Promise<void>
}

/** The per-server counter (lib/portal/rate-limit.ts) behind the same three steps. */
export function memoryLoginLimiter(): LoginLimiter {
  return {
    async reserve(key, maxFailures) {
      // check and count in one synchronous step: nothing can run in between
      const c = checkLoginRateLimit(key)
      if (!c.allowed) return { allowed: false, retryAfter: c.retryAfter }
      recordLoginFailure(key, { maxFailures })
      return { allowed: true }
    },
    async release(key) { releaseLoginAttempt(key) },
    async clear(key) { clearLoginFailures(key) },
  }
}

/** A database function call: `rpc('portal_login_reserve', { … })` on the server's database client. */
export type RpcCall = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>

/** The shared counter in the database. Throws on any error or unexpected answer, so the caller can fall back. */
export function databaseLoginLimiter(rpc: RpcCall, windowSeconds = 900): LoginLimiter {
  return {
    async reserve(key, maxFailures) {
      const { data, error } = await rpc('portal_login_reserve', { p_key: key, p_max: maxFailures, p_window_seconds: windowSeconds })
      if (error) throw new Error(`portal_login_reserve: ${error.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as { allowed?: unknown; retry_after_seconds?: unknown } | null | undefined
      if (!row || typeof row.allowed !== 'boolean') throw new Error('portal_login_reserve: unexpected answer')
      return row.allowed ? { allowed: true } : { allowed: false, retryAfter: Number(row.retry_after_seconds) || undefined }
    },
    async release(key) {
      const { error } = await rpc('portal_login_release', { p_key: key })
      if (error) throw new Error(`portal_login_release: ${error.message}`)
    },
    async clear(key) {
      const { error } = await rpc('portal_login_clear', { p_key: key })
      if (error) throw new Error(`portal_login_clear: ${error.message}`)
    },
  }
}

/**
 * The shared counter first; the per-server counter whenever the shared one fails. After a failure the shared counter is left alone for `pauseMs`
 * (so a missing table or a database fault does not add a failing call to every attempt), then tried again. A fault is logged once a minute.
 */
export function layeredLoginLimiter(
  primary: LoginLimiter,
  fallback: LoginLimiter,
  opts: { now?: () => number; pauseMs?: number; log?: (message: string) => void } = {},
): LoginLimiter {
  const now = opts.now ?? (() => Date.now())
  const pauseMs = opts.pauseMs ?? 30_000
  const log = opts.log ?? ((m: string) => console.error(m)) // eslint-disable-line no-console -- a fault in the shared counter must be visible in the server log
  let pausedUntil = 0
  let lastLogAt = -Infinity

  async function run<T>(op: (l: LoginLimiter) => Promise<T>): Promise<T> {
    const t = now()
    if (t >= pausedUntil) {
      try {
        return await op(primary)
      } catch (err) {
        pausedUntil = t + pauseMs
        if (t - lastLogAt >= 60_000) {
          lastLogAt = t
          log(`[login-limiter] shared counter unavailable, using the per-server counter for ${Math.round(pauseMs / 1000)}s: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return op(fallback)
  }

  return {
    reserve: (key, maxFailures) => run((l) => l.reserve(key, maxFailures)),
    release: (key) => run((l) => l.release(key)),
    clear: (key) => run((l) => l.clear(key)),
  }
}
