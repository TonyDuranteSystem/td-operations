import { describe, it, expect, beforeAll } from 'vitest'
import { signViewAs, verifyViewAs, AUTH_TOKEN_TTL_MS, MARKER_TTL_MS } from '@/lib/portal/view-as'

// The helper signs with API_SECRET_TOKEN; set a deterministic test secret.
beforeAll(() => {
  process.env.API_SECRET_TOKEN = 'test-secret-for-view-as-unit-tests'
})

const ADMIN = '11111111-1111-1111-1111-111111111111'
const CONTACT = '22222222-2222-2222-2222-222222222222'
const NOW = 1_700_000_000_000

describe('view-as token signing', () => {
  it('round-trips a valid payload', async () => {
    const token = await signViewAs({ contactId: CONTACT, adminId: ADMIN }, AUTH_TOKEN_TTL_MS, NOW)
    const payload = await verifyViewAs(token, NOW)
    expect(payload).not.toBeNull()
    expect(payload!.contactId).toBe(CONTACT)
    expect(payload!.adminId).toBe(ADMIN)
    expect(payload!.exp).toBe(NOW + AUTH_TOKEN_TTL_MS)
  })

  it('rejects an expired token', async () => {
    const token = await signViewAs({ contactId: CONTACT, adminId: ADMIN }, AUTH_TOKEN_TTL_MS, NOW)
    // verify "now" is just past expiry
    const payload = await verifyViewAs(token, NOW + AUTH_TOKEN_TTL_MS + 1)
    expect(payload).toBeNull()
  })

  it('accepts the marker right up to (but not at) expiry', async () => {
    const token = await signViewAs({ contactId: CONTACT, adminId: ADMIN }, MARKER_TTL_MS, NOW)
    expect(await verifyViewAs(token, NOW + MARKER_TTL_MS - 1)).not.toBeNull()
    expect(await verifyViewAs(token, NOW + MARKER_TTL_MS)).toBeNull()
  })

  it('rejects a tampered payload (signature mismatch)', async () => {
    const token = await signViewAs({ contactId: CONTACT, adminId: ADMIN }, AUTH_TOKEN_TTL_MS, NOW)
    const [body, sig] = token.split('.')
    // Flip the body to a different contactId but keep the old signature.
    const forgedBody = await signViewAs({ contactId: 'deadbeef', adminId: ADMIN }, AUTH_TOKEN_TTL_MS, NOW)
    const forged = `${forgedBody.split('.')[0]}.${sig}`
    expect(await verifyViewAs(forged, NOW)).toBeNull()
    // sanity: untouched token still valid
    expect(await verifyViewAs(`${body}.${sig}`, NOW)).not.toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signViewAs({ contactId: CONTACT, adminId: ADMIN }, AUTH_TOKEN_TTL_MS, NOW)
    const original = process.env.API_SECRET_TOKEN
    process.env.API_SECRET_TOKEN = 'a-completely-different-secret'
    const payload = await verifyViewAs(token, NOW)
    process.env.API_SECRET_TOKEN = original
    expect(payload).toBeNull()
  })

  it('returns null for malformed input', async () => {
    expect(await verifyViewAs(undefined, NOW)).toBeNull()
    expect(await verifyViewAs(null, NOW)).toBeNull()
    expect(await verifyViewAs('', NOW)).toBeNull()
    expect(await verifyViewAs('no-dot-here', NOW)).toBeNull()
    expect(await verifyViewAs('.', NOW)).toBeNull()
    expect(await verifyViewAs('abc.', NOW)).toBeNull()
    expect(await verifyViewAs('.abc', NOW)).toBeNull()
    expect(await verifyViewAs('garbage.signature', NOW)).toBeNull()
  })
})
