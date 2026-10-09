import { describe, it, expect } from 'vitest'
import {
  normalizeGroupName, validateNewGroup, validateAddMembers, isGroupMember, otherMembers,
  MIN_GROUP_MEMBERS, MAX_GROUP_MEMBERS, MAX_GROUP_NAME,
} from '@/lib/team/groups-rules'

const STAFF = ['antonio', 'luca', 'jodi', 'support']

describe('normalizeGroupName', () => {
  it('trims, collapses spaces and caps the length', () => {
    expect(normalizeGroupName('  Office   team ')).toBe('Office team')
    expect(normalizeGroupName('x'.repeat(200))).toHaveLength(MAX_GROUP_NAME)
  })
  it('refuses anything that is not a usable string', () => {
    for (const bad of [null, undefined, 5, {}, '', '   ']) expect(normalizeGroupName(bad)).toBe('')
  })
})

describe('validateNewGroup', () => {
  const base = { creatorId: 'antonio', staffIds: STAFF }
  it('creates a group of three: me, Luca and Jodi', () => {
    const r = validateNewGroup({ ...base, name: 'Office', memberIds: ['luca', 'jodi'] })
    expect(r).toEqual({ ok: true, name: 'Office', members: ['antonio', 'luca', 'jodi'] })
  })
  it('needs a name', () => {
    expect(validateNewGroup({ ...base, name: ' ', memberIds: ['luca', 'jodi'] }).ok).toBe(false)
  })
  it('needs at least three people counting the creator (two is just a direct message)', () => {
    expect(MIN_GROUP_MEMBERS).toBe(3)
    expect(validateNewGroup({ ...base, name: 'x', memberIds: ['luca'] }).ok).toBe(false)
    expect(validateNewGroup({ ...base, name: 'x', memberIds: [] }).ok).toBe(false)
    // the creator picked twice, or picked themself, is still two people
    expect(validateNewGroup({ ...base, name: 'x', memberIds: ['luca', 'luca', 'antonio'] }).ok).toBe(false)
  })
  it('refuses unknown people instead of dropping them silently', () => {
    const r = validateNewGroup({ ...base, name: 'x', memberIds: ['luca', 'stranger'] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not on the team/)
  })
  it('refuses a malformed member list', () => {
    expect(validateNewGroup({ ...base, name: 'x', memberIds: 'luca' }).ok).toBe(false)
    expect(validateNewGroup({ ...base, name: 'x', memberIds: ['luca', 5] }).ok).toBe(false)
    expect(validateNewGroup({ ...base, name: 'x', memberIds: ['luca', ''] }).ok).toBe(false)
  })
  it('caps the size', () => {
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 5 }, (_, i) => `u${i}`)
    expect(validateNewGroup({ creatorId: 'antonio', staffIds: [...many, 'antonio'], name: 'x', memberIds: many }).ok).toBe(false)
  })
  it('does not mutate or depend on the creator being in staffIds', () => {
    expect(validateNewGroup({ creatorId: 'antonio', staffIds: ['luca', 'jodi'], name: 'x', memberIds: ['luca', 'jodi'] }).ok).toBe(true)
  })
})

describe('validateAddMembers', () => {
  const current = ['antonio', 'luca', 'jodi']
  it('adds real staff who are not in yet', () => {
    expect(validateAddMembers({ userIds: ['support'], currentMembers: current, staffIds: STAFF })).toEqual({ ok: true, toAdd: ['support'] })
  })
  it('ignores people already in, and says so when there is nobody new', () => {
    expect(validateAddMembers({ userIds: ['luca', 'support', 'support'], currentMembers: current, staffIds: STAFF })).toEqual({ ok: true, toAdd: ['support'] })
    const r = validateAddMembers({ userIds: ['luca'], currentMembers: current, staffIds: STAFF })
    expect(r.ok).toBe(false)
  })
  it('refuses strangers, an empty pick and the size cap', () => {
    expect(validateAddMembers({ userIds: ['stranger'], currentMembers: current, staffIds: STAFF }).ok).toBe(false)
    expect(validateAddMembers({ userIds: [], currentMembers: current, staffIds: STAFF }).ok).toBe(false)
    expect(validateAddMembers({ userIds: 'x', currentMembers: current, staffIds: STAFF }).ok).toBe(false)
    const full = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => `u${i}`)
    expect(validateAddMembers({ userIds: ['support'], currentMembers: full, staffIds: STAFF }).ok).toBe(false)
  })
})

describe('membership helpers', () => {
  it('a group is visible only to its members', () => {
    expect(isGroupMember(['a', 'b'], 'a')).toBe(true)
    expect(isGroupMember(['a', 'b'], 'c')).toBe(false)
    expect(isGroupMember(null, 'a')).toBe(false)
    expect(isGroupMember(['a'], null)).toBe(false)
  })
  it('notifies everyone but the sender (and anyone excluded)', () => {
    expect(otherMembers(['a', 'b', 'c'], 'a')).toEqual(['b', 'c'])
    expect(otherMembers(['a', 'b', 'c'], 'a', ['c'])).toEqual(['b'])
    expect(otherMembers([], 'a')).toEqual([])
  })
})
