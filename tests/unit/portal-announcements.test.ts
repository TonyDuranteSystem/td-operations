import { describe, it, expect } from 'vitest'
import type { PortalAnnouncement } from '@/components/portal/announcement-banners'

// Helpers that mirror the logic in the API routes

function isValidType(t: string): t is 'info' | 'warning' | 'success' {
  return t === 'info' || t === 'warning' || t === 'success'
}

function sanitizeType(raw: unknown): 'info' | 'warning' | 'success' {
  if (typeof raw === 'string' && isValidType(raw)) return raw
  return 'info'
}

/** Mirrors the date-range filter applied in GET /api/portal/announcements */
function isActiveOnDate(
  row: { active: boolean; active_from: string | null; active_until: string | null },
  today: string, // YYYY-MM-DD
): boolean {
  if (!row.active) return false
  if (row.active_from && row.active_from > today) return false
  if (row.active_until && row.active_until < today) return false
  return true
}

describe('portal-announcements API helpers', () => {
  describe('sanitizeType', () => {
    it('accepts valid types', () => {
      expect(sanitizeType('info')).toBe('info')
      expect(sanitizeType('warning')).toBe('warning')
      expect(sanitizeType('success')).toBe('success')
    })

    it('falls back to info for unknown types', () => {
      expect(sanitizeType('danger')).toBe('info')
      expect(sanitizeType('')).toBe('info')
      expect(sanitizeType(null)).toBe('info')
      expect(sanitizeType(undefined)).toBe('info')
      expect(sanitizeType(42)).toBe('info')
    })
  })
})

describe('isActiveOnDate', () => {
  const base = { active: true, active_from: null, active_until: null }

  it('shows always when no date range set', () => {
    expect(isActiveOnDate(base, '2026-05-21')).toBe(true)
    expect(isActiveOnDate(base, '2099-01-01')).toBe(true)
  })

  it('hides when active=false regardless of dates', () => {
    expect(isActiveOnDate({ ...base, active: false }, '2026-05-21')).toBe(false)
  })

  it('respects active_from — hides before start date', () => {
    expect(isActiveOnDate({ ...base, active_from: '2026-05-21' }, '2026-05-20')).toBe(false)
    expect(isActiveOnDate({ ...base, active_from: '2026-05-21' }, '2026-05-21')).toBe(true)
    expect(isActiveOnDate({ ...base, active_from: '2026-05-21' }, '2026-05-22')).toBe(true)
  })

  it('respects active_until — hides after end date', () => {
    expect(isActiveOnDate({ ...base, active_until: '2026-05-24' }, '2026-05-24')).toBe(true)
    expect(isActiveOnDate({ ...base, active_until: '2026-05-24' }, '2026-05-25')).toBe(false)
  })

  it('shows only within range when both dates set', () => {
    const row = { active: true, active_from: '2026-05-21', active_until: '2026-05-24' }
    expect(isActiveOnDate(row, '2026-05-20')).toBe(false)
    expect(isActiveOnDate(row, '2026-05-21')).toBe(true)
    expect(isActiveOnDate(row, '2026-05-24')).toBe(true)
    expect(isActiveOnDate(row, '2026-05-25')).toBe(false)
  })

  it('single-day range works (active_from === active_until)', () => {
    const row = { active: true, active_from: '2026-05-25', active_until: '2026-05-25' }
    expect(isActiveOnDate(row, '2026-05-24')).toBe(false)
    expect(isActiveOnDate(row, '2026-05-25')).toBe(true)
    expect(isActiveOnDate(row, '2026-05-26')).toBe(false)
  })
})

describe('PortalAnnouncement shape', () => {
  it('has all required fields', () => {
    const ann: PortalAnnouncement = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test',
      message: 'Hello world',
      type: 'info',
      dismissible: true,
    }
    expect(ann.id).toBeTruthy()
    expect(ann.title).toBeTruthy()
    expect(ann.message).toBeTruthy()
    expect(['info', 'warning', 'success']).toContain(ann.type)
    expect(typeof ann.dismissible).toBe('boolean')
  })

  it('supports all three types', () => {
    const types: Array<PortalAnnouncement['type']> = ['info', 'warning', 'success']
    types.forEach(type => {
      const ann: PortalAnnouncement = { id: '1', title: 'T', message: 'M', type, dismissible: true }
      expect(ann.type).toBe(type)
    })
  })
})
