/**
 * "Block portal login" on a company also switches off the company's TEAM logins (dev job e59dd470, 20 Nov bug hunt D#10):
 *   - block: every ACTIVE team login is switched off with the block's reason; owner-off, TD-off-for-another-reason and removed logins are left alone;
 *   - restore: ONLY the logins this block switched off come back; everything else stays as it is;
 *   - one login failing never stops the others; an unreadable list throws (the route reports it).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/portal/team/server', () => ({ switchTeammateOff: vi.fn(), switchTeammateOn: vi.fn() }))

import {
  COMPANY_BLOCK_REASON,
  describeCompanyBlock,
  switchOffCompanyLogins,
  switchOnCompanyLogins,
  type BlockLoginRow,
  type CompanyBlockDeps,
} from '@/lib/portal/team/company-block'
import { TeamSwitchError } from '@/lib/portal/team/switch'

const td = { kind: 'td' as const, staffEmail: 'staff@example.com', ip: '1.1.1.1' }
const row = (over: Partial<BlockLoginRow>): BlockLoginRow => ({ id: 'x', username: 'x', status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null, ...over })
const active = (id: string) => row({ id, username: id })
const ownerOff = (id: string) => row({ id, username: id, status: 'revoked', switched_off_at: '2026-11-01T00:00:00Z', switched_off_by: 'owner', switched_off_reason: 'on holiday' })
const tdOffOther = (id: string) => row({ id, username: id, status: 'revoked', switched_off_at: '2026-11-01T00:00:00Z', switched_off_by: 'td', switched_off_reason: 'asked by the owner' })
const blocked = (id: string) => row({ id, username: id, status: 'revoked', switched_off_at: '2026-11-01T00:00:00Z', switched_off_by: 'td', switched_off_reason: COMPANY_BLOCK_REASON })
const removed = (id: string) => row({ id, username: id, status: 'revoked' })

function deps(rows: BlockLoginRow[], over: Partial<CompanyBlockDeps> = {}) {
  const off = vi.fn(async () => undefined)
  const on = vi.fn(async () => undefined)
  const d: CompanyBlockDeps = { listLogins: async () => rows, switchOff: off, switchOn: on, ...over }
  return { d, off, on }
}

describe('switchOffCompanyLogins (block)', () => {
  it('switches off every active login with the block reason, as the staff actor', async () => {
    const { d, off } = deps([active('a'), active('b')])
    const r = await switchOffCompanyLogins('acc1', td, d)
    expect(r).toEqual({ changed: 2, alreadyBlocked: 0, skipped: 0, failed: [] })
    expect(off).toHaveBeenCalledTimes(2)
    expect(off).toHaveBeenCalledWith('a', 'acc1', td, COMPANY_BLOCK_REASON)
  })
  it('leaves an owner-switched-off, another-reason TD-off and a removed login alone (not this block\'s to touch)', async () => {
    const { d, off } = deps([ownerOff('o'), tdOffOther('t'), removed('r'), active('a')])
    const r = await switchOffCompanyLogins('acc1', td, d)
    expect(r).toMatchObject({ changed: 1, skipped: 3 })
    expect(off).toHaveBeenCalledTimes(1)
    expect(off).toHaveBeenCalledWith('a', 'acc1', td, COMPANY_BLOCK_REASON)
  })
  it('a second press (or the "force" run) counts logins this block already switched off and does not switch them again', async () => {
    const { d, off } = deps([blocked('a'), active('b')])
    const r = await switchOffCompanyLogins('acc1', td, d)
    expect(r).toMatchObject({ changed: 1, alreadyBlocked: 1, skipped: 0 })
    expect(off).toHaveBeenCalledTimes(1)
  })
  it('a company with no team logins is a normal empty result', async () => {
    const { d, off } = deps([])
    expect(await switchOffCompanyLogins('acc1', td, d)).toEqual({ changed: 0, alreadyBlocked: 0, skipped: 0, failed: [] })
    expect(off).not.toHaveBeenCalled()
  })
  it('one login failing is reported and the others are still switched off (a partly failed switch-off is named)', async () => {
    const off = vi.fn(async (id: string) => { if (id === 'b') throw new TeamSwitchError('ban_failed', 'Switched off, but the sign-in could not be fully blocked. Please try again.') })
    const { d } = deps([active('a'), active('b'), active('c')], { switchOff: off })
    const r = await switchOffCompanyLogins('acc1', td, d)
    expect(r.changed).toBe(2)
    expect(r.failed).toEqual([{ loginId: 'b', username: 'b', error: 'Switched off, but the sign-in could not be fully blocked. Please try again.' }])
    expect(off).toHaveBeenCalledTimes(3)
  })
  it('a login that someone switched off or removed a moment ago is skipped, not reported as a failure', async () => {
    const off = vi.fn(async (id: string) => { throw new TeamSwitchError(id === 'a' ? 'already_off' : 'removed', 'x') })
    const { d } = deps([active('a'), active('b')], { switchOff: off })
    expect(await switchOffCompanyLogins('acc1', td, d)).toMatchObject({ changed: 0, skipped: 2, failed: [] })
  })
  it('an unreadable list THROWS (the route reports it) — never "no team logins"', async () => {
    const { d, off } = deps([], { listLogins: async () => { throw new Error('db down') } })
    await expect(switchOffCompanyLogins('acc1', td, d)).rejects.toThrow('db down')
    expect(off).not.toHaveBeenCalled()
  })
})

describe('switchOnCompanyLogins (restore)', () => {
  it('switches back on ONLY the logins this block switched off', async () => {
    const { d, on } = deps([blocked('a'), blocked('b'), ownerOff('o'), tdOffOther('t'), removed('r'), active('c')])
    const r = await switchOnCompanyLogins('acc1', td, d)
    expect(r).toMatchObject({ changed: 2, skipped: 2, failed: [] }) // owner-off + other TD-off are left off; removed and active are not counted
    expect(on).toHaveBeenCalledTimes(2)
    expect(on).toHaveBeenCalledWith('a', 'acc1', td)
    expect(on).toHaveBeenCalledWith('b', 'acc1', td)
  })
  it('a login switched on a moment ago is skipped; a real failure is reported and the others still come back', async () => {
    const on = vi.fn(async (id: string) => {
      if (id === 'a') throw new TeamSwitchError('not_off', 'x')
      if (id === 'b') throw new TeamSwitchError('shares_failed', 'We could not end the personal-document sharing')
    })
    const { d } = deps([blocked('a'), blocked('b'), blocked('c')], { switchOn: on })
    const r = await switchOnCompanyLogins('acc1', td, d)
    expect(r).toMatchObject({ changed: 1, skipped: 1 })
    expect(r.failed).toEqual([{ loginId: 'b', username: 'b', error: 'We could not end the personal-document sharing' }])
  })
  it('an unreadable list throws', async () => {
    const { d } = deps([], { listLogins: async () => { throw new Error('db down') } })
    await expect(switchOnCompanyLogins('acc1', td, d)).rejects.toThrow('db down')
  })
})

describe('COMPANY_BLOCK_REASON and describeCompanyBlock', () => {
  it('the reason fits the 500-character team-record limit and is plain English', () => {
    expect(COMPANY_BLOCK_REASON.length).toBeLessThanOrEqual(500)
    expect(COMPANY_BLOCK_REASON).toMatch(/blocked/i)
  })
  it('says what happened in one plain sentence', () => {
    expect(describeCompanyBlock('deactivate', { changed: 2, alreadyBlocked: 1, skipped: 1, failed: [] })).toBe('3 team logins switched off; 1 left as they were')
    expect(describeCompanyBlock('deactivate', { changed: 1, alreadyBlocked: 0, skipped: 0, failed: [] })).toBe('1 team login switched off')
    expect(describeCompanyBlock('activate', { changed: 2, alreadyBlocked: 0, skipped: 0, failed: [] })).toBe('2 team logins switched back on')
    expect(describeCompanyBlock('deactivate', { changed: 0, alreadyBlocked: 0, skipped: 0, failed: [] })).toBe('')
  })
  it('names the logins that could not be handled and points to the Team card', () => {
    const t = describeCompanyBlock('deactivate', { changed: 1, alreadyBlocked: 0, skipped: 0, failed: [{ loginId: 'b', username: 'anna', error: 'x' }] })
    expect(t).toContain('1 team login switched off')
    expect(t).toContain('1 could not be switched off (anna)')
    expect(t).toContain('Team card')
  })
  it('an unreadable list is said plainly and never reads as "no team logins"', () => {
    expect(describeCompanyBlock('deactivate', null, 'db down')).toMatch(/could not be checked \(db down\).*Team card/)
  })
})
