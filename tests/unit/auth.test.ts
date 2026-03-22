import { describe, it, expect } from 'vitest'
import { isAdmin, isTeam, isClient, getCrmRole, ADMIN_ONLY_PATHS } from '@/lib/auth'

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-id',
  email: 'test@test.com',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01',
  ...overrides,
} as any)

describe('isAdmin', () => {
  it('returns true for admin email', () => {
    expect(isAdmin(makeUser({ email: 'antonio.durante@tonydurante.us' }))).toBe(true)
  })

  it('returns true for app_metadata role=admin', () => {
    expect(isAdmin(makeUser({ app_metadata: { role: 'admin' } }))).toBe(true)
  })

  it('returns true for user_metadata role=admin', () => {
    expect(isAdmin(makeUser({ user_metadata: { role: 'admin' } }))).toBe(true)
  })

  it('returns false for team user', () => {
    expect(isAdmin(makeUser({ email: 'support@tonydurante.us' }))).toBe(false)
  })

  it('returns false for client', () => {
    expect(isAdmin(makeUser({ app_metadata: { role: 'client' } }))).toBe(false)
  })

  it('returns false for null user', () => {
    expect(isAdmin(null)).toBe(false)
  })
})

describe('isTeam', () => {
  it('returns true for non-admin non-client user', () => {
    expect(isTeam(makeUser({ email: 'support@tonydurante.us' }))).toBe(true)
  })

  it('returns false for admin', () => {
    expect(isTeam(makeUser({ email: 'antonio.durante@tonydurante.us' }))).toBe(false)
  })

  it('returns false for client', () => {
    expect(isTeam(makeUser({ app_metadata: { role: 'client' } }))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isTeam(null)).toBe(false)
  })
})

describe('isClient', () => {
  it('returns true for client role', () => {
    expect(isClient(makeUser({ app_metadata: { role: 'client' } }))).toBe(true)
  })

  it('returns false for admin', () => {
    expect(isClient(makeUser({ email: 'antonio.durante@tonydurante.us' }))).toBe(false)
  })

  it('returns false for team', () => {
    expect(isClient(makeUser({ email: 'support@tonydurante.us' }))).toBe(false)
  })
})

describe('getCrmRole', () => {
  it('returns admin for admin user', () => {
    expect(getCrmRole(makeUser({ email: 'antonio.durante@tonydurante.us' }))).toBe('admin')
  })

  it('returns team for team user', () => {
    expect(getCrmRole(makeUser({ email: 'support@tonydurante.us' }))).toBe('team')
  })

  it('returns null for client', () => {
    expect(getCrmRole(makeUser({ app_metadata: { role: 'client' } }))).toBe(null)
  })

  it('returns null for null user', () => {
    expect(getCrmRole(null)).toBe(null)
  })
})

describe('ADMIN_ONLY_PATHS', () => {
  it('includes invoice-settings', () => {
    expect(ADMIN_ONLY_PATHS).toContain('/invoice-settings')
  })

  it('includes reconciliation', () => {
    expect(ADMIN_ONLY_PATHS).toContain('/reconciliation')
  })

  it('includes portal-launch', () => {
    expect(ADMIN_ONLY_PATHS).toContain('/portal-launch')
  })

  it('does not include /tasks', () => {
    expect(ADMIN_ONLY_PATHS).not.toContain('/tasks')
  })
})
