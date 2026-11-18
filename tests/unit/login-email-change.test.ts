import { describe, it, expect } from 'vitest'
import {
  LOGIN_EMAIL_CHANGE as L,
  checkStartAllowed,
  checkUndo,
  cleanCode,
  countsAsPasswordAttempt,
  formatCodeForEmail,
  generateCode,
  generateUndoToken,
  hashSecret,
  hashesMatch,
  isFailure,
  isPlausibleEmail,
  isUuid,
  judgeAttempt,
  loginIdentityFromUser,
  normalizeEmail,
  parseUndoToken,
  passwordAttemptAllowed,
  passwordProblem,
  resendWaitSeconds,
  withAltEmail,
  withoutAltEmail,
  type CountedAttempt,
} from '@/lib/portal/login-email-change'

const NOW = new Date('2026-11-18T15:00:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)
const MIN = 60_000

describe('emails', () => {
  it('normalizes: trim + lower-case, anything else is empty', () => {
    expect(normalizeEmail('  Maria.Rossi@Example.COM ')).toBe('maria.rossi@example.com')
    expect(normalizeEmail(undefined)).toBe('')
    expect(normalizeEmail(42)).toBe('')
  })
  it('accepts normal addresses', () => {
    for (const e of ['a@b.co', 'maria.rossi@example.com', 'first+tag@sub.example.org', 'o_brien@example.it']) expect(isPlausibleEmail(e)).toBe(true)
  })
  it('refuses broken addresses', () => {
    for (const e of ['', 'plain', '@example.com', 'a@', 'a@b', 'a@b.', 'a@.com', 'a@b..com', 'a b@example.com', 'a@@example.com', 'a@b@c.com', '<a@b.com>', 'a,b@example.com', 'a@b.c', 'x'.repeat(250) + '@example.com']) {
      expect(isPlausibleEmail(e), e).toBe(false)
    }
  })
})

describe('the code', () => {
  it('is always 6 digits, zero-padded, and not always the same', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = generateCode()
      expect(c).toMatch(/^\d{6}$/)
      seen.add(c)
    }
    expect(seen.size).toBeGreaterThan(100)
  })
  it('cleans what the client typed and formats it for the email', () => {
    expect(cleanCode(' 483 291 ')).toBe('483291')
    expect(cleanCode('48-32a91')).toBe('483291')
    expect(cleanCode(null)).toBe('')
    expect(formatCodeForEmail('483291')).toBe('483 291')
    expect(formatCodeForEmail('123')).toBe('123')
  })
})

describe('hashes', () => {
  it('are stable, keyed and bound to the request id', () => {
    const h = hashSecret('key', 'req-1', '483291')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSecret('key', 'req-1', '483291')).toBe(h)
    expect(hashSecret('other-key', 'req-1', '483291')).not.toBe(h)
    expect(hashSecret('key', 'req-2', '483291')).not.toBe(h)
    expect(hashSecret('key', 'req-1', '483292')).not.toBe(h)
  })
  it('compare in constant time and never match junk', () => {
    const h = hashSecret('k', 'r', 'v')
    expect(hashesMatch(h, h)).toBe(true)
    expect(hashesMatch(h, hashSecret('k', 'r', 'w'))).toBe(false)
    expect(hashesMatch(null, h)).toBe(false)
    expect(hashesMatch(h, undefined)).toBe(false)
    expect(hashesMatch('', '')).toBe(false)
    expect(hashesMatch('zz', 'zz')).toBe(false)
    expect(hashesMatch(h, h.slice(0, 62))).toBe(false)
  })
})

describe('the "This wasn\'t me" token', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b'
  it('round-trips: <request id>.<secret>', () => {
    const { token, secret } = generateUndoToken(id)
    expect(token.startsWith(`${id}.`)).toBe(true)
    expect(parseUndoToken(token)).toEqual({ requestId: id, secret })
    expect(generateUndoToken(id).secret).not.toBe(secret)
  })
  it('refuses anything that is not that shape', () => {
    for (const bad of [undefined, null, '', 'abc', `${id}`, `${id}.`, `${id}.short`, `not-a-uuid-not-a-uuid-not-a-uuid-xxxx.${'a'.repeat(43)}`, `${id}.${'a'.repeat(43)}!`, `${id}.${'a'.repeat(300)}`, 123]) {
      expect(parseUndoToken(bad as unknown), String(bad)).toBeNull()
    }
  })
  it('knows a uuid', () => {
    expect(isUuid(id)).toBe(true)
    expect(isUuid('nope')).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})

describe('judging a code attempt (the database counted it first)', () => {
  const row = (over: Partial<CountedAttempt> = {}): CountedAttempt => ({
    taken: true, status: 'pending', codeExpiresAt: at(10 * MIN), attempts: 1, lockedUntil: null, ...over,
  })
  it('a right code is ok', () => expect(judgeAttempt(row(), true, NOW)).toEqual({ ok: true }))
  it('no row = not found', () => expect(judgeAttempt(null, true, NOW)).toEqual({ ok: false, reason: 'not_found' }))
  it('a wrong code says how many tries are left', () => {
    expect(judgeAttempt(row({ attempts: 1 }), false, NOW)).toEqual({ ok: false, reason: 'wrong', attemptsLeft: L.maxCodeAttempts - 1 })
    expect(judgeAttempt(row({ attempts: 4 }), false, NOW)).toEqual({ ok: false, reason: 'wrong', attemptsLeft: 1 })
  })
  it('the last wrong code locks, with the wait', () => {
    const j = judgeAttempt(row({ attempts: L.maxCodeAttempts, lockedUntil: at(15 * MIN) }), false, NOW)
    expect(j).toEqual({ ok: false, reason: 'locked', retryAfterSeconds: 900 })
  })
  it('the last attempt can still be the right one', () => {
    expect(judgeAttempt(row({ attempts: L.maxCodeAttempts, lockedUntil: at(15 * MIN) }), true, NOW)).toEqual({ ok: true })
  })
  it('a refused attempt is never compared, even with a matching code', () => {
    expect(judgeAttempt(row({ taken: false, status: 'confirmed' }), true, NOW)).toEqual({ ok: false, reason: 'not_found' })
    expect(judgeAttempt(row({ taken: false, status: 'cancelled' }), true, NOW)).toEqual({ ok: false, reason: 'not_found' })
    expect(judgeAttempt(row({ taken: false, lockedUntil: at(5 * MIN) }), true, NOW)).toMatchObject({ ok: false, reason: 'locked', retryAfterSeconds: 300 })
    expect(judgeAttempt(row({ taken: false, attempts: L.maxCodeAttempts, lockedUntil: at(-MIN) }), true, NOW)).toMatchObject({ ok: false, reason: 'locked' })
    expect(judgeAttempt(row({ taken: false, codeExpiresAt: at(-MIN) }), true, NOW)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('resend and start limits', () => {
  it('a new code only after a minute', () => {
    expect(resendWaitSeconds(at(-10_000), NOW)).toBe(50)
    expect(resendWaitSeconds(at(-61_000), NOW)).toBe(0)
    expect(resendWaitSeconds(at(-60_000), NOW)).toBe(0)
  })
  it('five starts an hour, then the wait is until the oldest leaves the window', () => {
    const starts = [at(-50 * MIN), at(-40 * MIN), at(-30 * MIN), at(-20 * MIN), at(-10 * MIN)]
    expect(checkStartAllowed({ startTimes: starts.slice(1), lockedUntils: [], now: NOW })).toEqual({ ok: true })
    const r = checkStartAllowed({ startTimes: starts, lockedUntils: [], now: NOW })
    expect(r).toEqual({ ok: false, reason: 'too_many_starts', retryAfterSeconds: 10 * 60 })
  })
  it('starts older than the window do not count', () => {
    const old = Array.from({ length: 9 }, (_, i) => at(-(61 + i) * MIN))
    expect(checkStartAllowed({ startTimes: old, lockedUntils: [], now: NOW })).toEqual({ ok: true })
  })
  it('a wrong-code lock still running blocks a new start, an old one does not', () => {
    expect(checkStartAllowed({ startTimes: [], lockedUntils: [at(7 * MIN)], now: NOW })).toEqual({ ok: false, reason: 'locked', retryAfterSeconds: 420 })
    expect(checkStartAllowed({ startTimes: [], lockedUntils: [at(-MIN)], now: NOW })).toEqual({ ok: true })
  })
  it('password attempts: five are judged, the sixth is refused, and only those two statuses count', () => {
    expect(passwordAttemptAllowed(1)).toBe(true)
    expect(passwordAttemptAllowed(L.maxPasswordAttempts)).toBe(true)
    expect(passwordAttemptAllowed(L.maxPasswordAttempts + 1)).toBe(false)
    expect(countsAsPasswordAttempt('password_check')).toBe(true)
    expect(countsAsPasswordAttempt('password_failed')).toBe(true)
    for (const s of ['pending', 'confirmed', 'undone', 'cancelled']) expect(countsAsPasswordAttempt(s)).toBe(false)
  })
})

describe('the undo link', () => {
  const ok = { status: 'confirmed', undoExpiresAt: at(3 * 24 * 60 * MIN), currentLoginEmail: 'New@Example.com', changedTo: 'new@example.com', now: NOW }
  it('works while confirmed, inside 7 days, and the login is still on the new email', () => expect(checkUndo(ok)).toEqual({ ok: true }))
  it('used once = used', () => expect(checkUndo({ ...ok, status: 'undone' })).toEqual({ ok: false, reason: 'used' }))
  it('only a confirmed change can be undone', () => {
    for (const status of ['pending', 'cancelled', 'password_check', 'password_failed']) expect(checkUndo({ ...ok, status })).toEqual({ ok: false, reason: 'unknown' })
  })
  it('expires', () => {
    expect(checkUndo({ ...ok, undoExpiresAt: at(-1) })).toEqual({ ok: false, reason: 'expired' })
    expect(checkUndo({ ...ok, undoExpiresAt: null })).toEqual({ ok: false, reason: 'expired' })
  })
  it('does not undo a change the login has already moved past', () => {
    expect(checkUndo({ ...ok, currentLoginEmail: 'third@example.com' })).toEqual({ ok: false, reason: 'superseded' })
  })
})

describe('the undo password', () => {
  it('needs 8 characters and two equal boxes', () => {
    expect(passwordProblem('short', 'short')).toBe('short')
    expect(passwordProblem(undefined, undefined)).toBe('short')
    expect(passwordProblem('longenough1', 'different1')).toBe('mismatch')
    expect(passwordProblem('longenough1', 'longenough1')).toBeNull()
  })
})

describe('alternate emails on the contact', () => {
  it('adds the old address once, in lower case', () => {
    expect(withAltEmail(['a@x.com'], 'Old@Example.com')).toEqual(['a@x.com', 'old@example.com'])
    expect(withAltEmail(['OLD@example.com'], 'old@example.com')).toEqual(['OLD@example.com'])
    expect(withAltEmail(null, 'old@example.com')).toEqual(['old@example.com'])
    expect(withAltEmail(['', '  '], 'old@example.com')).toEqual(['old@example.com'])
    expect(withAltEmail(['a@x.com'], '')).toEqual(['a@x.com'])
  })
  it('takes it out again, whatever the case', () => {
    expect(withoutAltEmail(['a@x.com', 'OLD@example.com'], 'old@example.com')).toEqual(['a@x.com'])
    expect(withoutAltEmail(null, 'old@example.com')).toEqual([])
  })
})

describe('whose login this is', () => {
  const client = { id: 'u1', email: 'maria@example.com', app_metadata: { role: 'client', contact_id: 'c1' } }
  it('a normal client login is identified by its own id, contact and email', () => {
    expect(loginIdentityFromUser(client)).toEqual({ authUserId: 'u1', contactId: 'c1', currentEmail: 'maria@example.com' })
  })
  it('team logins (no contact), other roles and logins without an email get nothing', () => {
    expect(loginIdentityFromUser(null)).toBeNull()
    expect(loginIdentityFromUser({ ...client, app_metadata: { role: 'client' } })).toBeNull()
    expect(loginIdentityFromUser({ ...client, app_metadata: { role: 'partner', contact_id: 'c1' } })).toBeNull()
    expect(loginIdentityFromUser({ ...client, app_metadata: { role: 'admin', contact_id: 'c1' } })).toBeNull()
    expect(loginIdentityFromUser({ ...client, email: '' })).toBeNull()
    expect(loginIdentityFromUser({ ...client, email: null })).toBeNull()
  })
})

describe('isFailure narrows a result union (the repo builds without strictNullChecks)', () => {
  it('is true only for ok:false', () => {
    expect(isFailure({ ok: false as const, code: 'x' })).toBe(true)
    expect(isFailure({ ok: true as const })).toBe(false)
  })
})
