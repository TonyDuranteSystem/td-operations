import { describe, it, expect } from 'vitest'
import {
  toSnapshot,
  isEscalated,
  classifyFindings,
  shouldSendAuditEmail,
  type FindingSnapshot,
} from '@/lib/cron/audit-email-state'

const f = (check_name: string, severity: string, records_affected: number) => ({
  check_name, severity, records_affected,
})

describe('toSnapshot', () => {
  it('reduces findings to check_name → {severity,count}', () => {
    expect(toSnapshot([f('a', 'P0', 3), f('b', 'P2', 10)])).toEqual({
      a: { severity: 'P0', count: 3 },
      b: { severity: 'P2', count: 10 },
    })
  })
})

describe('isEscalated', () => {
  it('false when no previous entry (that is NEW, not escalated)', () => {
    expect(isEscalated(undefined, { severity: 'P0', count: 5 })).toBe(false)
  })
  it('true when severity worsens', () => {
    expect(isEscalated({ severity: 'P2', count: 5 }, { severity: 'P0', count: 5 })).toBe(true)
  })
  it('false when severity improves or count drops', () => {
    expect(isEscalated({ severity: 'P0', count: 50 }, { severity: 'P1', count: 50 })).toBe(false)
    expect(isEscalated({ severity: 'P1', count: 50 }, { severity: 'P1', count: 10 })).toBe(false)
  })
  it('count growth must be >=20% AND >=5 rows', () => {
    // 10 → 200: +190, way over both thresholds
    expect(isEscalated({ severity: 'P1', count: 10 }, { severity: 'P1', count: 200 })).toBe(true)
    // 3 → 4: +1, below the 5-row floor (avoids tiny-count noise)
    expect(isEscalated({ severity: 'P1', count: 3 }, { severity: 'P1', count: 4 })).toBe(false)
    // 100 → 106: +6 rows but only 6% — below the 20% floor
    expect(isEscalated({ severity: 'P1', count: 100 }, { severity: 'P1', count: 106 })).toBe(false)
    // 10 → 15: +5 rows and +50% — escalates
    expect(isEscalated({ severity: 'P1', count: 10 }, { severity: 'P1', count: 15 })).toBe(true)
  })
})

describe('classifyFindings', () => {
  const prev: FindingSnapshot = {
    recurring_one: { severity: 'P1', count: 10 },
    escalating_one: { severity: 'P1', count: 10 },
  }
  it('labels new / escalated / recurring and flags notable', () => {
    const res = classifyFindings(
      [f('recurring_one', 'P1', 10), f('escalating_one', 'P1', 200), f('brand_new', 'P0', 1)],
      prev,
    )
    const byName = Object.fromEntries(res.classified.map(c => [c.finding.check_name, c.status]))
    expect(byName).toEqual({ recurring_one: 'recurring', escalating_one: 'escalated', brand_new: 'new' })
    expect(res.hasNotable).toBe(true)
    expect(res.notableCount).toBe(2)
  })
  it('all-recurring → not notable', () => {
    const res = classifyFindings([f('recurring_one', 'P1', 10)], prev)
    expect(res.hasNotable).toBe(false)
    expect(res.notableCount).toBe(0)
  })
  it('empty previous → everything is new', () => {
    const res = classifyFindings([f('x', 'P0', 1), f('y', 'P2', 2)], {})
    expect(res.classified.every(c => c.status === 'new')).toBe(true)
    expect(res.hasNotable).toBe(true)
  })
})

describe('shouldSendAuditEmail', () => {
  const now = new Date('2026-06-17T12:00:00Z')
  it('never sends when nothing notable', () => {
    expect(shouldSendAuditEmail({ hasNotable: false, lastEmailedAt: null, now })).toBe(false)
  })
  it('sends when notable and never emailed before', () => {
    expect(shouldSendAuditEmail({ hasNotable: true, lastEmailedAt: null, now })).toBe(true)
  })
  it('throttles within 24h even with notable findings', () => {
    expect(shouldSendAuditEmail({ hasNotable: true, lastEmailedAt: '2026-06-17T00:00:00Z', now })).toBe(false) // 12h ago
  })
  it('sends when notable and >=24h since last email', () => {
    expect(shouldSendAuditEmail({ hasNotable: true, lastEmailedAt: '2026-06-16T11:00:00Z', now })).toBe(true) // 25h ago
  })
  it('honors a custom interval', () => {
    expect(shouldSendAuditEmail({ hasNotable: true, lastEmailedAt: '2026-06-17T10:00:00Z', now, minIntervalHours: 1 })).toBe(true) // 2h ago, min 1h
  })
})
