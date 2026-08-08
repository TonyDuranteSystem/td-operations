/**
 * THE staff-MFA gate decision (dev job de4564ee) — pure function, no I/O,
 * exactly the install-state/push-card pattern: middleware feeds the session
 * state in, gets a verdict out, and every branch is unit-testable.
 *
 * Council-fixed rules baked in:
 *  - Role-agnostic input: the caller decides who is "subject" (today: staff
 *    via isStaffAuthRole; a future client-MFA phase passes its own flag —
 *    nothing staff-shaped in here).
 *  - aal comes from the SAME access token getUser() just validated; the
 *    caller passes it. Undecodable aal ⇒ caller passes null ⇒ treated as
 *    NOT aal2 (fail closed).
 *  - Remember-device satisfies the gate only when the cookie was verified
 *    (signature, userId match, version match) by the caller.
 *  - Grace: absent/unparseable deadline ⇒ ENFORCE (fail closed — a typo'd
 *    env must never silently disable MFA). Before the deadline, un-enrolled
 *    users are NUDGED (enroll page offers skip per-request — never a
 *    persisted skip flag); enrolled users are always challenged.
 */

export type MfaVerdict = 'allow' | 'enroll' | 'verify'

export interface MfaGateEnv {
  /** Is this session subject to MFA at all (today: staff/admin roles)? */
  subject: boolean
  /** Session has a VERIFIED TOTP factor (from the server-validated user). */
  hasVerifiedFactor: boolean
  /** aal claim from the validated access token; null when undecodable. */
  aal: 'aal1' | 'aal2' | null
  /** A remember-device cookie passed full verification (sig+userId+version). */
  rememberedDevice: boolean
  /** MFA_GRACE_UNTIL raw env value (ISO date) — parsed HERE so the fail-closed
   *  rule lives in the tested function, not in middleware. */
  graceUntilRaw: string | undefined
  /** Injectable clock for tests. */
  now: number
}

/** Exported for tests + the enroll page's own "can I still skip?" check. */
export function isWithinGrace(graceUntilRaw: string | undefined, now: number): boolean {
  if (!graceUntilRaw) return false // absent ⇒ enforce
  const t = new Date(graceUntilRaw).getTime()
  if (!Number.isFinite(t)) return false // garbage ⇒ enforce (fail closed)
  return now < t
}

export function resolveMfaGate(env: MfaGateEnv): MfaVerdict {
  if (!env.subject) return 'allow'

  if (env.hasVerifiedFactor) {
    // Enrolled: the challenge is never grace-exempt — an enrolled user who
    // could skip verification would make enrollment itself meaningless.
    if (env.aal === 'aal2') return 'allow'
    if (env.rememberedDevice) return 'allow'
    return 'verify'
  }

  // Not enrolled.
  if (isWithinGrace(env.graceUntilRaw, env.now)) return 'allow'
  return 'enroll'
}
