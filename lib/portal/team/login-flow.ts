/**
 * The team-login username sign-in, as one function with its dependencies passed in (so it runs without a database in tests and the
 * server action in app/portal/login/actions.ts only wires the real ones). Rules and reasons: login-guard.ts.
 *
 * Order matters:
 *   1. refuse early while the address, or this username from this address, is locked
 *   2. COUNT this attempt now — before any await — so a burst of parallel guesses cannot all pass step 1 (JavaScript runs 1 and 2 in one
 *      uninterrupted step, so the sixth parallel guess already sees five)
 *   3. an unusable username is refused here, never reaching the database
 *   4. look the login up (exact, never a pattern), then refuse while THAT LOGIN is locked from all addresses together, and count it
 *   5. check the password; a success refunds the counted attempt on the shared counters and clears this address+username counter
 * Every failure answers the same words, so nothing reveals whether a username exists.
 */
import {
  ACCOUNT_MAX_FAILURES, IP_MAX_FAILURES, INVALID_LOGIN_MESSAGE, canonicalTeamUsername, lockedLoginMessage, teamLoginKeys,
} from './login-guard'

export interface TeamLoginDeps {
  checkLimit: (key: string) => { allowed: boolean; retryAfter?: number }
  recordFailure: (key: string, opts?: { maxFailures?: number }) => void
  release: (key: string) => void
  clear: (key: string) => void
  /** Exact lookup of an active team login by its canonical username. */
  resolve: (username: string) => Promise<{ teamMemberId: string; email: string } | null>
  signIn: (email: string, password: string) => Promise<boolean>
}

export async function teamLoginAttempt(
  deps: TeamLoginDeps,
  input: { ip: string; username: unknown; password: string },
): Promise<{ ok: boolean; error?: string }> {
  const name = canonicalTeamUsername(input.username)
  const { ipKey, nameKey } = teamLoginKeys(input.ip, name)

  for (const key of [ipKey, nameKey]) {
    const rl = deps.checkLimit(key)
    if (!rl.allowed) return { ok: false, error: lockedLoginMessage(rl.retryAfter) }
  }
  deps.recordFailure(ipKey, { maxFailures: IP_MAX_FAILURES })
  deps.recordFailure(nameKey)

  if (!name) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  const found = await deps.resolve(name)
  if (!found) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  const { accountKey } = teamLoginKeys(input.ip, name, found.teamMemberId)
  if (accountKey) {
    const acct = deps.checkLimit(accountKey)
    if (!acct.allowed) return { ok: false, error: lockedLoginMessage(acct.retryAfter) }
    deps.recordFailure(accountKey, { maxFailures: ACCOUNT_MAX_FAILURES })
  }

  const good = await deps.signIn(found.email, input.password).catch(() => false)
  if (!good) return { ok: false, error: INVALID_LOGIN_MESSAGE }

  deps.clear(nameKey)
  deps.release(ipKey)
  if (accountKey) deps.release(accountKey)
  return { ok: true }
}
