import { describe, it, expect } from 'vitest'
import { currentMemberCounts, pickMainContacts, type AccountContactLink } from '@/lib/crm-lists/people'
import { ListStyles } from '@/components/lists/list-styles'

const link = (account_id: string, name: string | null, is_primary: boolean | null, ended_at: string | null = null): AccountContactLink => ({
  account_id,
  is_primary,
  ended_at,
  contact: name ? { full_name: name, email: `${name.toLowerCase()}@example.com` } : null,
})

describe('pickMainContacts', () => {
  it('prefers the primary contact whose link has not ended', () => {
    const r = pickMainContacts([link('a', 'Second', false), link('a', 'Prime', true), link('b', 'Solo', null)])
    expect(r.a.name).toBe('Prime')
    expect(r.b.name).toBe('Solo')
  })
  it('never shows a former member while a current one exists', () => {
    const r = pickMainContacts([link('a', 'Former', true, '2026-01-01T00:00:00Z'), link('a', 'Current', false)])
    expect(r.a.name).toBe('Current')
  })
  it('shows nothing when every link has ended or the contact is missing', () => {
    const r = pickMainContacts([link('a', 'Former', true, '2026-01-01T00:00:00Z'), link('b', null, true)])
    expect(r).toEqual({})
  })
  it('keeps the first of equal candidates', () => {
    expect(pickMainContacts([link('a', 'One', false), link('a', 'Two', false)]).a.name).toBe('One')
  })
})

describe('currentMemberCounts', () => {
  it('counts members with no end date or an end date still ahead, per company', () => {
    const r = currentMemberCounts(
      [
        { account_id: 'a', end_date: null },
        { account_id: 'a', end_date: '2027-01-01' },
        { account_id: 'a', end_date: '2025-06-30' },
        { account_id: 'b', end_date: '2026-11-14' },
        { account_id: 'c', end_date: null },
      ],
      '2026-11-14',
    )
    expect(r).toEqual({ a: 2, c: 1 })
  })
  it('is empty with no rows', () => {
    expect(currentMemberCounts([], '2026-11-14')).toEqual({})
  })
})

describe('ListStyles', () => {
  const css = (n: number) => (ListStyles({ minWidth: n }) as unknown as { props: { children: string } }).props.children
  it('brings the columns back only from the tablet width up, and only when the table has the room', () => {
    const c = css(1180.2)
    expect(c).toContain('@media (min-width:768px){@container lists (min-width:1181px)')
    expect(c).toContain('.lc-row{grid-template-columns:var(--cols)}')
  })
  it('hides the fields-as-columns and shows the small line by default', () => {
    const c = css(900)
    expect(c.startsWith('.lc-x,.lc-xf{display:none}.lc-m{display:block}')).toBe(true)
  })
})
