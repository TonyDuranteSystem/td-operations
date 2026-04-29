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
