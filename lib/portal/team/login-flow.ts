/**
 * The team-login username sign-in, as one function with its dependencies passed in (so it runs without a database in tests and the
 * server action in app/portal/login/actions.ts only wires the real ones). Rules and reasons: login-guard.ts.
 *
 * Order matters:
 *   1. refuse early while this username from this address, or the address, is locked — the check and the count are ONE atomic step
 *   2. so the attempt is COUNTED before any slow step: a burst of guesses, even spread over several servers, is admitted exactly up to the limit
 *   3. an unusable username is refused here, never reaching the database
 *   4. look the login up (exact, never a pattern), then refuse while THAT LOGIN is locked from all addresses together, and count it
 *   5. check the password; a success refunds the counted attempt on the shared counters and clears this address+username counter
 * Every failure answers the same words, so nothing reveals whether a username exists.
 */
import {
  ACCOUNT_MAX_FAILURES, IP_MAX_FAILURES, INVALID_LOGIN_MESSAGE, canonicalTeamUsername, lockedLoginMessage, teamLoginKeys,
} from './login-guard'
import { LOGIN_MAX_FAILURES } from '@/lib/portal/rate-limit'
import type { LoginLimiter } from '@/lib/portal/login-limiter'

export interface TeamLoginDeps {
  /** The wrong-password counter: shared by every server (database) with the per-server counter as its fallback — lib/portal/login-limiter.ts. */
  limiter: LoginLimiter
  /** Exact lookup of an active team login by its canonical username. */
  resolve: (username: string) => Promise<{ teamMemberId: string; email: string } | null>
  signIn: (email: string, password: string) => Promise<boolean>
}

export async function teamLoginAttempt(
  deps: TeamLoginDeps,
  input: { ip: string; username: unknown; password: string },
): Promise<{ ok: boolean; error?: string }> {
  const { limiter } = deps
  const name = canonicalTeamUsername(input.username)
  const { ipKey, nameKey } = teamLoginKeys(input.ip, name)

  // `reserve` checks AND counts in one atomic step, so the attempt is counted before any slow step below
  const byName = await limiter.reserve(nameKey, LOGIN_MAX_FAILURES)
  if (!byName.allowed) return { ok: false, error: lockedLoginMessage(byName.retryAfter) }
  const byAddress = await limiter.reserve(ipKey, IP_MAX_FAILURES)
  if (!byAddress.allowed) {
    await limiter.release(nameKey) // this attempt was refused: it must not use up the address+username counter
    return { ok: false, error: lockedLoginMessage(byAddress.retryAfter) }
  }

  if (!name) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  const found = await deps.resolve(name)
  if (!found) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  const { accountKey } = teamLoginKeys(input.ip, name, found.teamMemberId)
  if (accountKey) {
    const byLogin = await limiter.reserve(accountKey, ACCOUNT_MAX_FAILURES)
    if (!byLogin.allowed) return { ok: false, error: lockedLoginMessage(byLogin.retryAfter) }
  }

  const good = await deps.signIn(found.email, input.password).catch(() => false)
  if (!good) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  await limiter.clear(nameKey)
  await limiter.release(ipKey)
  if (accountKey) await limiter.release(accountKey)
  return { ok: true }
}
