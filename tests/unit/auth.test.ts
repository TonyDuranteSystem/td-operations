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

  it('IGNORES a self-written user_metadata role=admin (TD Marketing P1: that field is editable by the account holder)', () => {
    expect(isAdmin(makeUser({ user_metadata: { role: 'admin' } }))).toBe(false)
    expect(isAdmin(makeUser({ app_metadata: { role: 'client' }, user_metadata: { role: 'admin' } }))).toBe(false)
    expect(isAdmin(makeUser({ app_metadata: { role: 'marketing' }, user_metadata: { role: 'admin' } }))).toBe(false)
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
  it('returns true for a team user, false for a login with no role or an unknown role', () => {
    expect(isTeam(makeUser({ email: 'support@tonydurante.us', app_metadata: { role: 'team' } }))).toBe(true)
    expect(isTeam(makeUser({ email: 'support@tonydurante.us' }))).toBe(false) // no role is no longer staff
    expect(isTeam(makeUser({ app_metadata: { role: 'marketing' } }))).toBe(false)
    expect(isTeam(makeUser({ app_metadata: { role: 'contractor' } }))).toBe(false)
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

  it('returns team for a team user and null for roles that are not staff', () => {
    expect(getCrmRole(makeUser({ email: 'support@tonydurante.us', app_metadata: { role: 'team' } }))).toBe('team')
    expect(getCrmRole(makeUser({ email: 'support@tonydurante.us' }))).toBe(null)
    expect(getCrmRole(makeUser({ app_metadata: { role: 'marketing' } }))).toBe(null)
  })

  it('returns null for client', () => {
    expect(getCrmRole(makeUser({ app_metadata: { role: 'client' } }))).toBe(null)
  })

  it('returns null for null user', () => {
    expect(getCrmRole(null)).toBe(null)
  })
})

describe('ADMIN_ONLY_PATHS', () => {
  it('includes dev-tools', () => {
    expect(ADMIN_ONLY_PATHS).toContain('/dev-tools')
  })

  it('includes team-management', () => {
    expect(ADMIN_ONLY_PATHS).toContain('/team-management')
  })

  it('does not include /tasks', () => {
    expect(ADMIN_ONLY_PATHS).not.toContain('/tasks')
  })
})
