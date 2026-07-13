import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_BUCKETS,
  DEFAULT_OPEN_BUCKETS,
  bucketKeyOf,
  groupIntoSections,
  badgeTextFor,
  type ClientGroupLike,
} from '@/lib/team/conversation-buckets'

function group(bucket: string | null, opts?: { lead_status?: string; key?: string }): ClientGroupLike {
  return {
    key: opts?.key ?? `k:${bucket}`,
    label: bucket ?? 'x',
    threads: [{ client_bucket: bucket, lead_status: opts?.lead_status }],
  }
}

describe('bucketKeyOf', () => {
  it('reads the bucket off the first thread', () => {
    expect(bucketKeyOf(group('active_client'))).toBe('active_client')
    expect(bucketKeyOf(group('partner'))).toBe('partner')
    expect(bucketKeyOf(group('offboarded'))).toBe('offboarded')
  })
  it('falls back to internal for null / unknown / empty', () => {
    expect(bucketKeyOf(group(null))).toBe('internal')
    expect(bucketKeyOf(group('nonsense'))).toBe('internal')
    expect(bucketKeyOf({ key: 'k', label: 'x', threads: [] })).toBe('internal')
  })
})

describe('groupIntoSections', () => {
  it('orders sections by CONVERSATION_BUCKETS and drops empty ones', () => {
    const secs = groupIntoSections([
      group('offboarded'),
      group('active_client'),
      group('partner'),
    ])
    expect(secs.map(s => s.meta.key)).toEqual(['active_client', 'partner', 'offboarded'])
  })

  it('preserves incoming group order within a section', () => {
    const secs = groupIntoSections([
      group('active_client', { key: 'a' }),
      group('active_client', { key: 'b' }),
      group('active_client', { key: 'c' }),
    ])
    expect(secs).toHaveLength(1)
    expect(secs[0].groups.map(g => g.key)).toEqual(['a', 'b', 'c'])
  })

  it('groups mixed buckets correctly', () => {
    const secs = groupIntoSections([
      group('lead'),
      group('active_client'),
      group('lead'),
      group(null),
    ])
    const byKey = Object.fromEntries(secs.map(s => [s.meta.key, s.groups.length]))
    expect(byKey).toEqual({ active_client: 1, lead: 2, internal: 1 })
  })

  it('returns empty for no groups', () => {
    expect(groupIntoSections([])).toEqual([])
  })
})

describe('badgeTextFor', () => {
  it('uses the bucket badge by default', () => {
    expect(badgeTextFor(group('active_client'))).toBe('Active')
    expect(badgeTextFor(group('individual'))).toBe('Individual')
    expect(badgeTextFor(group('offboarded'))).toBe('Off-boarded')
  })
  it('appends the lead stage for leads', () => {
    expect(badgeTextFor(group('lead', { lead_status: 'Offer Sent' }))).toBe('Lead · Offer Sent')
  })
  it('plain Lead when no stage', () => {
    expect(badgeTextFor(group('lead'))).toBe('Lead')
  })
})

describe('config sanity', () => {
  it('default-open = the four active sections', () => {
    expect(DEFAULT_OPEN_BUCKETS).toEqual(['active_client', 'lead', 'partner', 'individual'])
  })
  it('every bucket has non-empty section + badge', () => {
    for (const m of CONVERSATION_BUCKETS) {
      expect(m.section.length).toBeGreaterThan(0)
      expect(m.badge.length).toBeGreaterThan(0)
      expect(m.badgeClass).toContain('bg-')
    }
  })
})
