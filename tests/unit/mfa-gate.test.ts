import { describe, it, expect, beforeAll } from 'vitest'
import { resolveMfaGate, isWithinGrace } from '@/lib/auth/mfa-gate'
import {
  signMfaRememberDevice,
  verifyMfaRememberDevice,
  MFA_RD_TTL_MS,
} from '@/lib/auth/mfa-remember-device'
import {
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
  BACKUP_CODE_COUNT,
} from '@/lib/auth/mfa-backup-codes'

const NOW = 1_800_000_000_000

describe('resolveMfaGate — the six session states (council-enumerated)', () => {
  const base = {
    subject: true,
    exempt: false,
    hasVerifiedFactor: false,
    aal: 'aal1' as const,
    rememberedDevice: false,
    graceUntilRaw: undefined,
    now: NOW,
  }

  it('non-subject sessions (clients, partner) always pass', () => {
    expect(resolveMfaGate({ ...base, subject: false })).toBe('allow')
    expect(resolveMfaGate({ ...base, subject: false, hasVerifiedFactor: true })).toBe('allow')
  })

  it('no factor + expired/absent grace → enroll (fail closed)', () => {
    expect(resolveMfaGate(base)).toBe('enroll')
  })

  it('no factor + within grace → allow (nudge happens on the page)', () => {
    expect(resolveMfaGate({ ...base, graceUntilRaw: new Date(NOW + 86_400_000).toISOString() })).toBe('allow')
  })

  it('factor + aal1 → verify — and grace NEVER exempts an enrolled user', () => {
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true })).toBe('verify')
    expect(resolveMfaGate({
      ...base, hasVerifiedFactor: true,
      graceUntilRaw: new Date(NOW + 86_400_000).toISOString(),
    })).toBe('verify')
  })

  it('factor + aal1 + verified remember-device → allow', () => {
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true, rememberedDevice: true })).toBe('allow')
  })

  it('factor + aal2 → allow', () => {
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true, aal: 'aal2' })).toBe('allow')
  })

  it('undecodable aal (null) is NOT aal2 — fail closed to verify', () => {
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true, aal: null })).toBe('verify')
  })
})

describe('owner exemption — the only way OFF stays off (Antonio 2026-08-07)', () => {
  const base = {
    subject: true,
    exempt: true,
    hasVerifiedFactor: false,
    aal: 'aal1' as const,
    rememberedDevice: false,
    graceUntilRaw: undefined,
    now: NOW,
  }

  it('exempt + no authenticator → allowed even with grace long expired', () => {
    expect(resolveMfaGate(base)).toBe('allow')
  })

  it('exempt does NOT weaken an account that still HAS an authenticator', () => {
    // Otherwise flipping the exemption would silently drop protection on a
    // protected account, and the holder would believe they were covered.
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true })).toBe('verify')
    expect(resolveMfaGate({ ...base, hasVerifiedFactor: true, aal: 'aal2' })).toBe('allow')
  })

  it('exemption is per-account — a non-exempt staff account is unaffected', () => {
    expect(resolveMfaGate({ ...base, exempt: false })).toBe('enroll')
  })

  it('exemption never applies to a non-subject session (clients stay out of scope)', () => {
    expect(resolveMfaGate({ ...base, subject: false })).toBe('allow')
  })
})

describe('isWithinGrace — fail-closed env parsing (Security minor)', () => {
  it('absent → enforce', () => {
    expect(isWithinGrace(undefined, NOW)).toBe(false)
    expect(isWithinGrace('', NOW)).toBe(false)
  })
  it('garbage → enforce, never NaN semantics', () => {
    expect(isWithinGrace('not-a-date', NOW)).toBe(false)
  })
  it('past date → enforce', () => {
    expect(isWithinGrace(new Date(NOW - 1000).toISOString(), NOW)).toBe(false)
  })
  it('future date → grace', () => {
    expect(isWithinGrace(new Date(NOW + 1000).toISOString(), NOW)).toBe(true)
  })
})

describe('remember-device cookie', () => {
  beforeAll(() => {
    process.env.API_SECRET_TOKEN = 'test-secret-for-mfa-rd'
  })

  it('round-trips for the same user + version', async () => {
    const token = await signMfaRememberDevice({ userId: 'user-a', version: 0 }, NOW)
    expect(await verifyMfaRememberDevice(token, 'user-a', 0, NOW)).toBe(true)
  })

  it('rejects a DIFFERENT user (shared-machine protection)', async () => {
    const token = await signMfaRememberDevice({ userId: 'user-a', version: 0 }, NOW)
    expect(await verifyMfaRememberDevice(token, 'user-b', 0, NOW)).toBe(false)
  })

  it('rejects after a version bump (admin reset revokes all devices)', async () => {
    const token = await signMfaRememberDevice({ userId: 'user-a', version: 0 }, NOW)
    expect(await verifyMfaRememberDevice(token, 'user-a', 1, NOW)).toBe(false)
  })

  it('rejects after expiry (30 days)', async () => {
    const token = await signMfaRememberDevice({ userId: 'user-a', version: 0 }, NOW)
    expect(await verifyMfaRememberDevice(token, 'user-a', 0, NOW + MFA_RD_TTL_MS + 1)).toBe(false)
  })

  it('rejects tampered payloads and garbage', async () => {
    const token = await signMfaRememberDevice({ userId: 'user-a', version: 0 }, NOW)
    const [body, sig] = token.split('.')
    expect(await verifyMfaRememberDevice(`${body}x.${sig}`, 'user-a', 0, NOW)).toBe(false)
    expect(await verifyMfaRememberDevice('garbage', 'user-a', 0, NOW)).toBe(false)
    expect(await verifyMfaRememberDevice(null, 'user-a', 0, NOW)).toBe(false)
  })

  it('is domain-separated from the view-as token format (same secret, different HMAC input)', async () => {
    // A view-as-style token signed WITHOUT the domain prefix must not verify.
    const { signViewAs } = await import('@/lib/portal/view-as')
    const viewAsToken = await signViewAs({ contactId: 'user-a', adminId: 'x' }, 60_000, NOW)
    expect(await verifyMfaRememberDevice(viewAsToken, 'user-a', 0, NOW)).toBe(false)
  })
})

describe('backup codes', () => {
  it('generates the declared count, all unique, ≥26 chars of Crockford base32', () => {
    const { codes, hashes } = generateBackupCodes()
    expect(codes).toHaveLength(BACKUP_CODE_COUNT)
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT)
    expect(new Set(hashes).size).toBe(BACKUP_CODE_COUNT)
    for (const code of codes) {
      expect(normalizeBackupCode(code)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }
  })

  it('hash is insensitive to dashes, spaces, and case (hand-typed tolerance)', () => {
    const { codes, hashes } = generateBackupCodes()
    const sloppy = codes[0].toLowerCase().replace(/-/g, ' ')
    expect(hashBackupCode(sloppy)).toBe(hashes[0])
  })

  it('different codes hash differently', () => {
    expect(hashBackupCode('AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-A'))
      .not.toBe(hashBackupCode('BBBBB-BBBBB-BBBBB-BBBBB-BBBBB-B'))
  })
})
