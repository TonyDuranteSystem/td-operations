import { describe, it, expect, beforeAll } from 'vitest'
import { signOaPass, verifyOaPass, OA_PASS_TTL_MS } from '@/lib/oa/portal-pass'

beforeAll(() => {
  process.env.API_SECRET_TOKEN = 'test-secret-for-oa-portal-pass'
})

const OA_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OA_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CONTACT = '22222222-2222-2222-2222-222222222222'
const NOW = 1_700_000_000_000

describe('OA portal pass', () => {
  it('round-trips a portal pass bound to its agreement', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'portal', sub: CONTACT }, NOW)
    const payload = await verifyOaPass(token, OA_A, NOW)
    expect(payload).not.toBeNull()
    expect(payload!.oaId).toBe(OA_A)
    expect(payload!.kind).toBe('portal')
    expect(payload!.sub).toBe(CONTACT)
    expect(payload!.exp).toBe(NOW + OA_PASS_TTL_MS)
  })

  it('round-trips a staff_preview pass', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'staff_preview' }, NOW)
    const payload = await verifyOaPass(token, OA_A, NOW)
    expect(payload).not.toBeNull()
    expect(payload!.kind).toBe('staff_preview')
  })

  it('REJECTS a pass minted for a different agreement (cross-agreement replay)', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'portal', sub: CONTACT }, NOW)
    // Same valid signature, but presented against agreement B's token.
    expect(await verifyOaPass(token, OA_B, NOW)).toBeNull()
    // Sanity: still valid for its own agreement.
    expect(await verifyOaPass(token, OA_A, NOW)).not.toBeNull()
  })

  it('rejects an expired pass at exactly the TTL boundary', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'portal' }, NOW)
    expect(await verifyOaPass(token, OA_A, NOW + OA_PASS_TTL_MS - 1)).not.toBeNull()
    expect(await verifyOaPass(token, OA_A, NOW + OA_PASS_TTL_MS)).toBeNull()
  })

  it('rejects a tampered oaId (signature mismatch)', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'portal' }, NOW)
    const sig = token.split('.')[1]
    const forgedBody = (await signOaPass({ oaId: OA_B, kind: 'portal' }, NOW)).split('.')[0]
    const forged = `${forgedBody}.${sig}`
    expect(await verifyOaPass(forged, OA_B, NOW)).toBeNull()
  })

  it('rejects a pass signed with a different secret', async () => {
    const token = await signOaPass({ oaId: OA_A, kind: 'portal' }, NOW)
    const original = process.env.API_SECRET_TOKEN
    process.env.API_SECRET_TOKEN = 'a-completely-different-secret'
    const payload = await verifyOaPass(token, OA_A, NOW)
    process.env.API_SECRET_TOKEN = original
    expect(payload).toBeNull()
  })

  it('returns null for malformed input', async () => {
    expect(await verifyOaPass(undefined, OA_A, NOW)).toBeNull()
    expect(await verifyOaPass(null, OA_A, NOW)).toBeNull()
    expect(await verifyOaPass('', OA_A, NOW)).toBeNull()
    expect(await verifyOaPass('no-dot', OA_A, NOW)).toBeNull()
    expect(await verifyOaPass('garbage.sig', OA_A, NOW)).toBeNull()
  })
})
