import { describe, it, expect } from 'vitest'
import { planLoginCleanup } from '@/lib/portal/login-cleanup'

describe('planLoginCleanup', () => {
  it('Adam case: two logins, keeps the one matching the canonical email, deletes the stray', () => {
    const r = planLoginCleanup(
      [
        { id: 'stray', email: 'mihalyadam12@gmail.com' },
        { id: 'canon', email: 'mihalo@tuta.com' },
      ],
      'mihalo@tuta.com',
    )
    expect(r.keepId).toBe('canon')
    expect(r.deleteIds).toEqual(['stray'])
    expect(r.warning).toBeUndefined()
  })

  it('single canonical login: deletes nothing', () => {
    const r = planLoginCleanup([{ id: 'a', email: 'x@y.com' }], 'x@y.com')
    expect(r.keepId).toBe('a')
    expect(r.deleteIds).toEqual([])
  })

  it('multiple strays: keeps canonical, deletes all others', () => {
    const r = planLoginCleanup(
      [
        { id: 'c', email: 'real@x.com' },
        { id: 's1', email: 'old1@x.com' },
        { id: 's2', email: 'old2@x.com' },
      ],
      'real@x.com',
    )
    expect(r.keepId).toBe('c')
    expect(new Set(r.deleteIds)).toEqual(new Set(['s1', 's2']))
  })

  it('SAFETY: no login matches the canonical email → delete NOTHING + warning', () => {
    const r = planLoginCleanup(
      [{ id: 'a', email: 'wrong@x.com' }, { id: 'b', email: 'also@x.com' }],
      'real@x.com',
    )
    expect(r.keepId).toBeNull()
    expect(r.deleteIds).toEqual([])
    expect(r.warning).toBeTruthy()
  })

  it('email match is case-insensitive and trims', () => {
    const r = planLoginCleanup(
      [{ id: 'c', email: '  Real@X.COM ' }, { id: 's', email: 'stray@x.com' }],
      'real@x.com',
    )
    expect(r.keepId).toBe('c')
    expect(r.deleteIds).toEqual(['s'])
  })

  it('no logins at all → nothing to do, no warning', () => {
    const r = planLoginCleanup([], 'x@y.com')
    expect(r).toEqual({ keepId: null, deleteIds: [], canonicalEmail: 'x@y.com' })
  })

  it('blank canonical email → deletes nothing (cannot identify canonical)', () => {
    const r = planLoginCleanup([{ id: 'a', email: 'x@y.com' }], '')
    expect(r.keepId).toBeNull()
    expect(r.deleteIds).toEqual([])
  })
})
