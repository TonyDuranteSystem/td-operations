/**
 * Dev job `61f184ca` — a company member's Operating Agreement address.
 *
 * Michele Cotti (AI Venture Labs LLC) opened the Generate Documents screen and
 * saw his own Portuguese HOME address printed against Whalecot Consulting LLC,
 * the Florida company that is the member of record. The data was correct; the
 * screen resolved `representative_address_* ?? address_*`, so the person who
 * signs for the entity outranked the entity.
 *
 * These tests pin the rule and the two places that must agree on it. The
 * FIXTURE IS THE REAL RECORD: the member rows below are the production shape of
 * account 12dadc46 (read-only, 2026-08-12) — a company member holding a US
 * company address plus a foreign representative address, beside two individual
 * members. A test on invented data would have passed against the old code too.
 *
 * SCOPE NOTE: individual members keep their PRE-EXISTING contact-first precedence
 * — the change that made them read the member row was cancelled with the wider
 * owner-of-record work. Whether the member row should win for individuals is
 * REPORT-ONLY on dev job 271bbe46.
 *
 * R086: every new function in lib/ gets a unit test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  chooseWholeAddress,
  resolveMemberAddress,
  formatMemberAddress,
  formatMemberAddressRow,
  isMemberAddressEmpty,
  EMPTY_MEMBER_ADDRESS,
  type MemberAddressRow,
} from '@/lib/members/member-address'

// ─── Fixtures: the production shape of AI Venture Labs LLC ──────────────────

/** members 2804aefe — Whalecot Consulting LLC. FL company address, PT rep address. */
const WHALECOT = {
  id: '2804aefe',
  member_type: 'company',
  full_name: null,
  company_name: 'Whalecot Consulting LLC',
  email: null,
  ownership_pct: 59,
  is_primary: false,
  contact_id: 'contact-michele',
  representative_name: 'Michele Cotti',
  representative_email: 'michele@example.com',
  representative_phone: null,
  ein: null,
  address_street: '10225 Ulmerton Rd 3D',
  address_city: 'Largo',
  address_state: 'FL',
  address_zip: '33771',
  address_country: 'United States',
  representative_address_street: 'PRACETA PEDRO IVO, N.° 5',
  representative_address_city: 'Amadora',
  representative_address_state: 'Amadora',
  representative_address_zip: '2700-652',
  representative_address_country: 'Portugal',
}

/** members 0e2a69d8 — Michele himself, individual, 1%. */
const MICHELE = {
  id: '0e2a69d8',
  member_type: 'individual',
  full_name: 'Michele Cotti',
  company_name: null,
  email: 'michele@example.com',
  ownership_pct: 1,
  is_primary: true,
  contact_id: 'contact-michele',
  representative_name: null,
  representative_email: null,
  representative_phone: null,
  ein: null,
  address_street: 'PRACETA PEDRO IVO, 5',
  address_city: 'AMADORA',
  address_state: 'AMADORA',
  address_zip: '2700-652',
  address_country: 'Portugal',
  representative_address_street: null,
  representative_address_city: null,
  representative_address_state: null,
  representative_address_zip: null,
  representative_address_country: null,
}

/** members 8a1e30fe — Gaia Pellegrinelli, individual, 40%. */
const GAIA = {
  id: '8a1e30fe',
  member_type: 'individual',
  full_name: 'Gaia Pellegrinelli',
  company_name: null,
  email: 'gaia@example.com',
  ownership_pct: 40,
  is_primary: false,
  contact_id: 'contact-gaia',
  representative_name: null,
  representative_email: null,
  representative_phone: null,
  ein: null,
  address_street: 'via giacomo leopardi 20',
  address_city: 'Rogno',
  address_state: 'BG',
  address_zip: '24060',
  address_country: 'Italy',
  representative_address_street: null,
  representative_address_city: null,
  representative_address_state: null,
  representative_address_zip: null,
  representative_address_country: null,
}

// ─── The rule itself ────────────────────────────────────────────────────────

describe('resolveMemberAddress — company members', () => {
  it('THE BUG: returns the entity address, never the representative personal address', () => {
    const parts = resolveMemberAddress(WHALECOT as MemberAddressRow)

    expect(parts.line1).toBe('10225 Ulmerton Rd 3D')
    expect(parts.city).toBe('Largo')
    expect(parts.state).toBe('FL')
    expect(parts.country).toBe('United States')

    // The precise failure Michele reported, pinned as a negative.
    expect(parts.line1).not.toBe('PRACETA PEDRO IVO, N.° 5')
    expect(JSON.stringify(parts)).not.toContain('Portugal')
    expect(JSON.stringify(parts)).not.toContain('PRACETA')
  })

  it('carries the postal code — the screen used to drop it while the document kept it', () => {
    expect(resolveMemberAddress(WHALECOT as MemberAddressRow).zip).toBe('33771')
    expect(formatMemberAddressRow(WHALECOT as MemberAddressRow)).toContain('33771')
  })

  it('formats the full one-line address that goes into the agreement', () => {
    expect(formatMemberAddressRow(WHALECOT as MemberAddressRow))
      .toBe('10225 Ulmerton Rd 3D, Largo, FL, 33771, United States')
  })

  it('NEGATIVE CELL: a company with no address of its own substitutes NOTHING', () => {
    const noAddress = {
      ...WHALECOT,
      address_street: null, address_city: null, address_state: null,
      address_zip: null, address_country: null,
    }
    const parts = resolveMemberAddress(noAddress as MemberAddressRow)

    // Not the representative's, not a default, not a placeholder — empty.
    expect(isMemberAddressEmpty(parts)).toBe(true)
    expect(formatMemberAddressRow(noAddress as MemberAddressRow)).toBeNull()
    expect(JSON.stringify(parts)).not.toContain('PRACETA')
  })

  it('treats a blank-string address as absent rather than as an empty address', () => {
    const blank = {
      ...WHALECOT,
      address_street: '   ', address_city: '', address_state: null,
      address_zip: '  ', address_country: '',
    }
    expect(isMemberAddressEmpty(resolveMemberAddress(blank as MemberAddressRow))).toBe(true)
    expect(formatMemberAddressRow(blank as MemberAddressRow)).toBeNull()
  })
})

describe('resolveMemberAddress — individual members', () => {
  it('reads the member row when no contact record overrides it', () => {
    expect(formatMemberAddressRow(MICHELE as MemberAddressRow))
      .toBe('PRACETA PEDRO IVO, 5, AMADORA, AMADORA, 2700-652, Portugal')
    expect(formatMemberAddressRow(GAIA as MemberAddressRow))
      .toBe('via giacomo leopardi 20, Rogno, BG, 24060, Italy')
  })

  it('is empty when the row has no address and nothing overrides it', () => {
    const bare = {
      ...MICHELE,
      address_street: null, address_city: null, address_state: null,
      address_zip: null, address_country: null,
    }
    expect(formatMemberAddressRow(bare as MemberAddressRow)).toBeNull()
  })
})

describe('chooseWholeAddress — one record or the other, never a field from each', () => {
  const CONTACT = { line1: 'Via Milano 3', city: 'Milano', state: 'MI', zip: null, country: 'Italy' }
  const MEMBER_ROW = { line1: 'Via Roma 1', city: 'Rogno', state: 'BG', zip: '24060', country: 'Italy' }

  it('THE MIXING DEFECT: a preferred record missing ONE field does not borrow it from the other', () => {
    // Resolving per field (which is what adding the postal code did) gave the
    // contact's street with the member row's postal code — an address that exists
    // in NEITHER record, printed into a legal document. 17 production contacts have
    // a street and no postal code.
    const chosen = chooseWholeAddress(CONTACT, MEMBER_ROW)
    expect(chosen).toEqual(CONTACT)
    expect(chosen.zip).toBeNull()
    expect(chosen.zip).not.toBe('24060')
    expect(chosen.line1).not.toBe('Via Roma 1')
  })

  it('takes the fallback WHOLE when the preferred record is empty', () => {
    expect(chooseWholeAddress(EMPTY_MEMBER_ADDRESS, MEMBER_ROW)).toEqual(MEMBER_ROW)
  })

  it('treats a blank-string record as empty, so it does not win over a real address', () => {
    const blank = { line1: '  ', city: '', state: null, zip: '   ', country: '' }
    expect(chooseWholeAddress(resolveMemberAddress({
      member_type: 'individual', address_street: blank.line1, address_city: blank.city,
      address_state: blank.state, address_zip: blank.zip, address_country: blank.country,
    } as MemberAddressRow), MEMBER_ROW)).toEqual(MEMBER_ROW)
  })

  it('returns an empty address when neither record holds anything — substitutes nothing', () => {
    expect(chooseWholeAddress(EMPTY_MEMBER_ADDRESS, EMPTY_MEMBER_ADDRESS)).toEqual(EMPTY_MEMBER_ADDRESS)
  })
})

describe('formatMemberAddress', () => {
  it('returns null rather than a string of stray commas when everything is absent', () => {
    expect(formatMemberAddress(EMPTY_MEMBER_ADDRESS)).toBeNull()
  })

  it('omits only the missing parts, keeping the rest in order', () => {
    expect(formatMemberAddress({
      line1: '30 N Gould St', city: 'Sheridan', state: null, zip: '82801', country: 'USA',
    })).toBe('30 N Gould St, Sheridan, 82801, USA')
  })

  it('handles a null row without throwing', () => {
    expect(formatMemberAddressRow(null)).toBeNull()
    expect(formatMemberAddressRow(undefined)).toBeNull()
  })
})

// ─── The query that feeds the screen ────────────────────────────────────────
//
// Tests the REAL getPortalMembers against mocked rows, not a re-implementation:
// the select list is part of what broke (the zip columns were missing from it),
// so the assertions below check the query shape as well as the mapping.

let mockByTable: Record<string, unknown> = {}
let selects: string[] = []

function makeChain(table: string) {
  const settle = () => Promise.resolve({ data: mockByTable[table] ?? null, error: null })
  const chain = {
    select: vi.fn((cols: string) => { selects.push(cols); return chain }),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => settle()),
    single: vi.fn(() => settle()),
    maybeSingle: vi.fn(() => settle()),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      settle().then(resolve, reject),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}))

import { getPortalMembers } from '@/lib/portal/queries'

beforeEach(() => {
  mockByTable = {}
  selects = []
})

describe('getPortalMembers — the screen the client actually reads', () => {
  it('shows the company address for the company member and the submitted address for each individual', async () => {
    mockByTable.members = [MICHELE, WHALECOT, GAIA]
    mockByTable.contacts = [
      { id: 'contact-michele', first_name: 'Michele', last_name: 'Cotti', citizenship: 'Italian', date_of_birth: '1980-01-01' },
      { id: 'contact-gaia', first_name: 'Gaia', last_name: 'Pellegrinelli', citizenship: 'Italian', date_of_birth: null },
    ]

    const members = await getPortalMembers('12dadc46')
    const whalecot = members.find(m => m.member_type === 'company')!

    expect(whalecot.company_name).toBe('Whalecot Consulting LLC')
    expect(whalecot.address_line1).toBe('10225 Ulmerton Rd 3D')
    expect(whalecot.address_city).toBe('Largo')
    expect(whalecot.address_zip).toBe('33771')
    expect(whalecot.address_country).toBe('United States')

    // The reported symptom, at the layer that produced it.
    expect(JSON.stringify({
      line1: whalecot.address_line1, city: whalecot.address_city,
      state: whalecot.address_state, country: whalecot.address_country,
    })).not.toContain('Portugal')

    // The representative is still surfaced — as a PERSON, without hijacking the
    // entity's address. The member detail card renders these separately.
    expect(whalecot.representative_name).toBe('Michele Cotti')

    const michele = members.find(m => m.member_id === '0e2a69d8')!
    expect(michele.address_line1).toBe('PRACETA PEDRO IVO, 5')
    expect(michele.address_zip).toBe('2700-652')
  })

  it('selects the zip columns — omitting them is how the screen and the document diverged', async () => {
    mockByTable.members = [WHALECOT]
    mockByTable.contacts = []
    await getPortalMembers('12dadc46')

    const memberSelect = selects.find(s => s.includes('representative_address_street'))!
    expect(memberSelect).toContain('address_zip')
    expect(memberSelect).toContain('representative_address_zip')
  })


  it('returns an empty list when the account has no member rows (legacy accounts)', async () => {
    mockByTable.members = []
    expect(await getPortalMembers('legacy-account')).toEqual([])
  })
})
