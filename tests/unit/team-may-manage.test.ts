import { describe, it, expect, vi } from 'vitest'
import {
  decideMayManageTeam,
  mayManageTeam,
  isCurrentLink,
  isCurrentMemberRow,
  OWNER_MEMBER_ROLES,
  type ManageInputs,
  type ManageLink,
  type ManageMemberRow,
} from '@/lib/portal/team/may-manage'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'

const NOW = new Date('2026-11-17T12:00:00.000Z')
const link = (over: Partial<ManageLink> = {}): ManageLink => ({ role: 'owner', ended_at: null, access_revoked_at: null, access_until: null, ...over })
const member = (contact_id: string | null, over: Partial<ManageMemberRow> = {}): ManageMemberRow => ({ contact_id, start_date: null, end_date: null, ...over })
const input = (over: Partial<ManageInputs> = {}): ManageInputs => ({ contactId: 'C1', link: link(), members: [], ...over })
const ok = (i: ManageInputs) => decideMayManageTeam(i, NOW)

describe('single-owner company (no members list)', () => {
  it.each(['owner', 'Owner', 'Member', 'member', 'Sole Member', '  Sole Member '])('the %s link may manage', (role) => {
    expect(ok(input({ link: link({ role }) }))).toEqual({ ok: true, reason: 'ok', matchedBy: 'no_list' })
  })
  it.each(['authorized_representative', 'Partner - Tax/NHR Consultant (Portugal)', "Collaborator - Client Communications (Francesco Valentini's team)", 'accountant', '', null])('the %s link may NOT', (role) => {
    expect(ok(input({ link: link({ role }) })).reason).toBe('not_owner_or_member')
  })
  it('only the three owner/member roles exist', () => {
    expect([...OWNER_MEMBER_ROLES]).toEqual(['owner', 'member', 'sole member'])
  })
})

describe('several-owner company (the members list decides who the owners are)', () => {
  const list = [member('C1'), member('C2')]
  it('a current member on the list may manage — and so may the other one', () => {
    expect(ok(input({ members: list })).ok).toBe(true)
    expect(ok(input({ contactId: 'C2', members: list })).ok).toBe(true)
  })
  it('a "Member" link that is NOT on the members list may not (stale / stray link)', () => {
    const r = ok(input({ contactId: 'C9', link: link({ role: 'Member' }), members: list }))
    expect(r).toEqual({ ok: false, reason: 'not_on_members_list' })
  })
  it('a member who LEFT (end date passed) may not, even with an old link', () => {
    const r = ok(input({ members: [member('C1', { end_date: '2026-10-01' }), member('C2')] }))
    expect(r.reason).toBe('not_on_members_list')
  })
  it('a member whose end date is today or earlier is gone; a future end date still counts', () => {
    expect(ok(input({ members: [member('C1', { end_date: '2026-11-17' }), member('C2')] })).ok).toBe(false)
    expect(ok(input({ members: [member('C1', { end_date: '2026-12-31' }), member('C2')] })).ok).toBe(true)
  })
  it('a member who has not started yet is not current (and does not make the list "current")', () => {
    expect(ok(input({ members: [member('C1', { start_date: '2027-01-01' }), member('C2')] })).ok).toBe(false)
    // only future / ended rows: no current list, so the link role decides
    expect(ok(input({ members: [member('C1', { start_date: '2027-01-01' })] })).ok).toBe(true)
  })
  it('a members row with no contact and no matching name never matches anyone', () => {
    expect(ok(input({ contactId: 'C9', contactName: 'Zed Nobody', link: link({ role: 'Member' }), members: [member(null, { full_name: 'Someone Else' }), member('C2')] })).ok).toBe(false)
  })
  it('matched by contact is reported as such', () => {
    expect(ok(input({ members: list })).matchedBy).toBe('contact')
  })
})

describe('an owner on the members list whose row was never linked to their contact (the real data gap)', () => {
  const unlinked = [member(null, { full_name: 'Arturo Paturzo' }), member(null, { full_name: 'Davide Paturzo' })]
  it('is recognised by their exact name (case and spaces ignored)', () => {
    const r = ok(input({ contactName: '  arturo   PATURZO ', members: unlinked }))
    expect(r).toEqual({ ok: true, reason: 'ok', matchedBy: 'name' })
  })
  it('a different name is not recognised, even with an owner link', () => {
    expect(ok(input({ contactName: 'Arturo Paturzi', members: unlinked })).reason).toBe('not_on_members_list')
  })
  it('a blank name never matches a blank row name', () => {
    expect(ok(input({ contactName: '', members: [member(null, { full_name: '' })] })).ok).toBe(false)
    expect(ok(input({ contactName: null, members: [member(null, { full_name: null })] })).ok).toBe(false)
  })
  it('a row that IS linked to someone else is never matched by name', () => {
    expect(ok(input({ contactName: 'Arturo Paturzo', members: [member('C2', { full_name: 'Arturo Paturzo' })] })).reason).toBe('not_on_members_list')
  })
  it('a name match does not rescue a person who left, a wrong role, or a missing link', () => {
    expect(ok(input({ contactName: 'Arturo Paturzo', members: [member(null, { full_name: 'Arturo Paturzo', end_date: '2026-01-01' }), member('C2')] })).reason).toBe('not_on_members_list')
    expect(ok(input({ contactName: 'Arturo Paturzo', link: link({ role: 'authorized_representative' }), members: unlinked })).reason).toBe('not_owner_or_member')
    expect(ok(input({ contactName: 'Arturo Paturzo', link: null, members: unlinked })).reason).toBe('no_link')
  })
})

describe('a company that is itself a member', () => {
  it('its representative (the contact on that row, with an owner/member link) may manage', () => {
    const members = [member('CMAIN'), member('CREP') /* the company-member's row points at its representative */]
    expect(ok(input({ contactId: 'CREP', link: link({ role: 'Member' }), members })).ok).toBe(true)
  })
  it('a representative who is only an "authorized representative" may NOT', () => {
    const members = [member('CMAIN'), member('CREP')]
    expect(ok(input({ contactId: 'CREP', link: link({ role: 'authorized_representative' }), members })).reason).toBe('not_owner_or_member')
  })
})

describe('the link itself', () => {
  it('no link to THIS company (an owner of ANOTHER company) may not', () => {
    expect(ok(input({ link: null }))).toEqual({ ok: false, reason: 'no_link' })
  })
  it('an ended link, a revoked access or an expired access may not', () => {
    expect(ok(input({ link: link({ ended_at: '2026-09-01T00:00:00Z' }) })).reason).toBe('link_ended')
    expect(ok(input({ link: link({ access_revoked_at: '2026-09-01T00:00:00Z' }) })).reason).toBe('link_ended')
    expect(ok(input({ link: link({ access_until: '2026-11-01T00:00:00Z' }) })).reason).toBe('link_ended')
  })
  it('an access that runs until later still counts', () => {
    expect(ok(input({ link: link({ access_until: '2026-12-01T00:00:00Z' }) })).ok).toBe(true)
  })
  it('no contact at all may not', () => {
    expect(ok(input({ contactId: '' })).reason).toBe('no_contact')
  })
  it('the helpers agree', () => {
    expect(isCurrentLink(link(), NOW)).toBe(true)
    expect(isCurrentLink(link({ ended_at: 'x' }), NOW)).toBe(false)
    expect(isCurrentMemberRow(member('C1'), NOW)).toBe(true)
    expect(isCurrentMemberRow(member('C1', { end_date: '2026-11-16' }), NOW)).toBe(false)
  })
})

describe('mayManageTeam / isAccountAdmin (the database wrapper)', () => {
  const deps = (gather: () => Promise<{ link: ManageLink | null; members: ManageMemberRow[]; contactName?: string | null }>) => ({ gather, now: () => NOW })

  it('true for a current owner', async () => {
    expect(await mayManageTeam('C1', 'A1', deps(async () => ({ link: link(), members: [] })))).toBe(true)
  })
  it('false for an empty contact or company without asking the database', async () => {
    const gather = vi.fn()
    expect(await mayManageTeam('', 'A1', deps(gather))).toBe(false)
    expect(await mayManageTeam('C1', '', deps(gather))).toBe(false)
    expect(gather).not.toHaveBeenCalled()
  })
  it('passes the person\'s name on, so an unlinked members row can be recognised', async () => {
    expect(await mayManageTeam('C1', 'A1', deps(async () => ({ link: link(), members: [member(null, { full_name: 'Ada Lovelace' })], contactName: 'ada lovelace' })))).toBe(true)
    expect(await mayManageTeam('C1', 'A1', deps(async () => ({ link: link(), members: [member(null, { full_name: 'Ada Lovelace' })], contactName: 'Grace Hopper' })))).toBe(false)
  })
  it('FAILS CLOSED when the database cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await mayManageTeam('C1', 'A1', deps(async () => { throw new Error('db down') }))).toBe(false)
    spy.mockRestore()
  })
  it('isAccountAdmin is the same rule (the seven callers keep their name)', async () => {
    expect(await isAccountAdmin('C1', 'A1', deps(async () => ({ link: link({ role: 'authorized_representative' }), members: [] })))).toBe(false)
    expect(await isAccountAdmin('C1', 'A1', deps(async () => ({ link: link(), members: [member('C1')] })))).toBe(true)
  })
})
