/**
 * WHERE THE MEMBER LIST COMES FROM — the union, and why it is a union.
 *
 * Switching categorisation to the curated members list ALONE was the first plan
 * and it was wrong twice, both in the silent direction:
 *
 *  - COVERAGE. 47 of 330 accounts have a curated members list; 283 have none
 *    (production, 2026-08-04). A single-owner company's owner exists only as a
 *    linked contact, so a members-only roster turns their every draw into a
 *    deducted business expense — and nothing reports that a roster was empty.
 *  - HISTORY. The curated list is current state with no dates, and the
 *    client-facing form DELETES every row before re-inserting. A member who
 *    left mid-year vanishes (Titan 2025). Contact links are never unlinked, so
 *    they still carry the people the tax year needs.
 *
 * Over-including costs a visible, correctable review card. Under-including
 * costs a silent deduction on a filed return. These tests pin the asymmetry.
 */

import { describe, it, expect } from 'vitest'
import { fetchMemberRoster, type RosterDb } from '@/lib/tax/member-roster'

/** Minimal stand-in for the query builder shape the reader uses. */
function fakeDb(opts: {
  members?: Array<{ full_name: string | null; company_name: string | null; member_type: string | null }>
  contacts?: Array<{ first_name: string | null; last_name: string | null } | null>
  failMembers?: boolean
  failContacts?: boolean
}): RosterDb {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              if (table === 'members') {
                if (opts.failMembers) return Promise.reject(new Error('members read down'))
                return Promise.resolve({ data: opts.members ?? [] })
              }
              if (opts.failContacts) return Promise.reject(new Error('contacts read down'))
              return Promise.resolve({ data: (opts.contacts ?? []).map(c => ({ contacts: c })) })
            },
          }
        },
      }
    },
  }
}

describe('fetchMemberRoster — the union', () => {
  it('uses the curated members list when it exists', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [{ full_name: 'Gabriele Finelli', company_name: null, member_type: 'individual' }],
    }), 'acct')
    expect(r.names).toEqual(['Gabriele Finelli'])
    expect(r.fromMembers).toBe(1)
  })

  /** The 283-of-330 case: no curated list at all. */
  it('falls back to linked contacts when there is no curated list', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [],
      contacts: [{ first_name: 'Maria', last_name: 'Rossi' }],
    }), 'acct')
    expect(r.names).toEqual(['Maria Rossi'])
    expect(r.fromMembers).toBe(0)
    expect(r.fromContacts).toBe(1)
  })

  /** The Titan case: a member who left mid-year is gone from the curated list. */
  it('keeps a departed member who survives only as a linked contact', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [{ full_name: 'Matthew Finelli', company_name: null, member_type: 'individual' }],
      contacts: [{ first_name: 'Luca', last_name: 'Caruso' }],
    }), 'acct')
    expect(r.names).toContain('Matthew Finelli')
    expect(r.names).toContain('Luca Caruso')
  })

  it('takes a company member from company_name', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [{ full_name: null, company_name: 'F.INVEST Holding LLC', member_type: 'company' }],
    }), 'acct')
    expect(r.names).toEqual(['F.INVEST Holding LLC'])
  })

  it('folds a person present in both sources into one name', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [{ full_name: 'Nicolò Patti', company_name: null, member_type: 'individual' }],
      contacts: [{ first_name: 'Nicolo', last_name: 'Patti' }],
    }), 'acct')
    expect(r.names).toEqual(['Nicolò Patti'])
  })

  /**
   * THE PRODUCTION HAZARD. Ten linked contacts across six companies with bank
   * data have NULL first AND last name. An empty string matches every row.
   */
  it('never lets a blank contact record into the roster, and reports it', async () => {
    const r = await fetchMemberRoster(fakeDb({
      members: [],
      contacts: [
        { first_name: null, last_name: null },
        { first_name: 'Andrea', last_name: 'Santellocco' },
      ],
    }), 'acct')
    expect(r.names).toEqual(['Andrea Santellocco'])
    expect(r.names).not.toContain('')
    expect(r.unusable).toBe(1)
  })

  it('an account with nothing on file yields an empty roster, not a blank name', async () => {
    const r = await fetchMemberRoster(fakeDb({ members: [], contacts: [] }), 'acct')
    expect(r.names).toEqual([])
  })

  /**
   * A read failure must not silently produce "this company has no owners" from
   * the source that IS available — that would deduct every draw for the year.
   */
  it('survives one source failing and still uses the other', async () => {
    const a = await fetchMemberRoster(fakeDb({
      failMembers: true,
      contacts: [{ first_name: 'Maria', last_name: 'Rossi' }],
    }), 'acct')
    expect(a.names).toEqual(['Maria Rossi'])

    const b = await fetchMemberRoster(fakeDb({
      members: [{ full_name: 'Gabriele Finelli', company_name: null, member_type: 'individual' }],
      failContacts: true,
    }), 'acct')
    expect(b.names).toEqual(['Gabriele Finelli'])
  })

  it('is deterministic — the curated spelling wins and order is stable', async () => {
    const args = {
      members: [
        { full_name: 'Josè Muñoz', company_name: null, member_type: 'individual' },
        { full_name: 'Lucia Terracciano', company_name: null, member_type: 'individual' },
      ],
      contacts: [{ first_name: 'Jose', last_name: 'Munoz' }],
    }
    const first = await fetchMemberRoster(fakeDb(args), 'acct')
    const second = await fetchMemberRoster(fakeDb(args), 'acct')
    expect(first.names).toEqual(second.names)
    expect(first.names).toEqual(['Josè Muñoz', 'Lucia Terracciano'])
  })
})
