/**
 * Team Chat "on behalf of" — the council-pinned rule (2026-07-29, dev job
 * 8537adf9): on ANY ambiguity the acting user is NULL and everyone is notified.
 * A wrong guess silences the wrong person's notifications — the original bug
 * inverted — so these tests pin every degrade-to-null path.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeOnBehalfOfUserId, resolveActingUser } from '@/lib/team/acting-user'
import { CLAUDE_SENDER_UUID } from '@/lib/team/workspace'

const ANTONIO = { id: '12dadc46-e431-4d11-9fe0-5c561d38737a', email: 'antonio.durante@tonydurante.us' }
const LUCA = { id: '30c2cd96-03e4-43cf-9536-81d961b18b1d', email: 'luca@tonydurante.us' }
const STAFF = [ANTONIO, LUCA]

describe('sanitizeOnBehalfOfUserId', () => {
  it('accepts a plain uuid', () => {
    expect(sanitizeOnBehalfOfUserId(ANTONIO.id)).toBe(ANTONIO.id)
  })
  it('rejects the Claude sentinel — Claude cannot dictate to itself', () => {
    expect(sanitizeOnBehalfOfUserId(CLAUDE_SENDER_UUID)).toBeNull()
    expect(sanitizeOnBehalfOfUserId(CLAUDE_SENDER_UUID.toUpperCase())).toBeNull()
  })
  it('rejects non-uuid garbage (display names, labels, empties, non-strings)', () => {
    expect(sanitizeOnBehalfOfUserId('Antonio Durante')).toBeNull()
    expect(sanitizeOnBehalfOfUserId('team-chat:Antonio')).toBeNull()
    expect(sanitizeOnBehalfOfUserId('')).toBeNull()
    expect(sanitizeOnBehalfOfUserId(null)).toBeNull()
    expect(sanitizeOnBehalfOfUserId(42)).toBeNull()
  })
})

describe('resolveActingUser — unknown means null means notify everyone', () => {
  it('resolves a staff uuid', () => {
    expect(resolveActingUser(STAFF, ANTONIO.id)).toBe(ANTONIO.id)
  })
  it('resolves a staff email, case-insensitively', () => {
    expect(resolveActingUser(STAFF, 'Antonio.Durante@TonyDurante.us')).toBe(ANTONIO.id)
    expect(resolveActingUser(STAFF, LUCA.email)).toBe(LUCA.id)
  })
  it('COUNCIL RULE: a uuid that is not staff resolves to null, never a guess', () => {
    expect(resolveActingUser(STAFF, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBeNull()
  })
  it('COUNCIL RULE: an unknown email resolves to null', () => {
    expect(resolveActingUser(STAFF, 'client@example.com')).toBeNull()
  })
  it('COUNCIL RULE: empty / missing input resolves to null', () => {
    expect(resolveActingUser(STAFF, '')).toBeNull()
    expect(resolveActingUser(STAFF, null)).toBeNull()
    expect(resolveActingUser(STAFF, undefined)).toBeNull()
  })
  it('the Claude sentinel never resolves even if somehow listed', () => {
    expect(resolveActingUser([...STAFF, { id: CLAUDE_SENDER_UUID, email: 'claude@x' }], CLAUDE_SENDER_UUID)).toBeNull()
  })
  it('a display name (the actor audit label shape) resolves to null', () => {
    expect(resolveActingUser(STAFF, 'Antonio Durante')).toBeNull()
    expect(resolveActingUser(STAFF, 'team-chat:Antonio Durante')).toBeNull()
  })
})
