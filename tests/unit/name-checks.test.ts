import { describe, it, expect } from 'vitest'
import { initNameChecksFromWizard, parseProposedNames, hasFiledName, filedName, allNamesDead, confirmedClientFacingName, nameDedupeKey, addStaffName, MAX_STAFF_NAME_LENGTH, type NameCheck } from '@/lib/flows/name-checks'

describe('initNameChecksFromWizard', () => {
  it('builds entries from the numbered candidates, skipping empties', () => {
    const r = initNameChecksFromWizard({ llc_name_1: 'Aurora LLC', llc_name_2: '  ', llc_name_3: 'Cypress LLC' })
    expect(r).toEqual([
      { name: 'Aurora LLC', source: 'wizard', field: 'llc_name_1', status: 'pending', updated_at: null },
      { name: 'Cypress LLC', source: 'wizard', field: 'llc_name_3', status: 'pending', updated_at: null },
    ])
  })

  it('falls back to a single legacy name field', () => {
    expect(initNameChecksFromWizard({ company_name: 'Solo LLC' })).toEqual([
      { name: 'Solo LLC', source: 'wizard', field: 'company_name', status: 'pending', updated_at: null },
    ])
  })

  it('prefers numbered over legacy', () => {
    const r = initNameChecksFromWizard({ llc_name_1: 'Numbered LLC', company_name: 'Ignored LLC' })
    expect(r).toHaveLength(1)
    expect(r[0].name).toBe('Numbered LLC')
  })

  it('returns [] for null/empty', () => {
    expect(initNameChecksFromWizard(null)).toEqual([])
    expect(initNameChecksFromWizard({})).toEqual([])
  })
})

describe('parseProposedNames', () => {
  it('splits on newlines, commas, semicolons; trims; de-dupes; caps at 5', () => {
    expect(parseProposedNames('Alpha LLC, Beta LLC\nGamma LLC; alpha llc')).toEqual(['Alpha LLC', 'Beta LLC', 'Gamma LLC'])
    expect(parseProposedNames('a,b,c,d,e,f,g')).toHaveLength(5)
  })
  it('handles empty / non-string', () => {
    expect(parseProposedNames('')).toEqual([])
    expect(parseProposedNames('   ')).toEqual([])
    expect(parseProposedNames(undefined)).toEqual([])
    expect(parseProposedNames(42)).toEqual([])
  })
})

describe('hasFiledName', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }
  it('true only when a name is filed', () => {
    expect(hasFiledName([{ ...base, status: 'accepted' }])).toBe(false)
    expect(hasFiledName([{ ...base, status: 'available' }, { ...base, status: 'filed' }])).toBe(true)
    expect(hasFiledName([])).toBe(false)
    expect(hasFiledName(null)).toBe(false)
  })
})

describe('filedName', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }
  it('returns the filed candidate name', () => {
    expect(filedName([{ ...base, name: 'Acme LLC', status: 'available' }, { ...base, name: 'Marinela Marku LLC', status: 'filed' }])).toBe('Marinela Marku LLC')
  })
  it('returns null when nothing is filed', () => {
    expect(filedName([{ ...base, status: 'accepted' }])).toBeNull()
    expect(filedName([])).toBeNull()
    expect(filedName(null)).toBeNull()
    expect(filedName(undefined)).toBeNull()
  })
  it('returns null for a filed entry with a blank name', () => {
    expect(filedName([{ ...base, name: '   ', status: 'filed' }])).toBeNull()
  })
})

describe('allNamesDead', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }

  it('false on an empty list — nothing has died yet, not vacuously true (2026-09-10 fix)', () => {
    expect(allNamesDead([])).toBe(false)
    expect(allNamesDead(null)).toBe(false)
    expect(allNamesDead(undefined)).toBe(false)
  })

  it('false while any candidate is still in play (pending, available, sent_to_client, accepted, or filed)', () => {
    expect(allNamesDead([{ ...base, status: 'pending' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'pending' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'available' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'sent_to_client' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'accepted' }])).toBe(false)
    expect(allNamesDead([{ ...base, status: 'not_available' }, { ...base, status: 'filed' }])).toBe(false)
  })

  it('true only when every candidate is a dead end', () => {
    expect(allNamesDead([{ ...base, status: 'not_available' }])).toBe(true)
    expect(
      allNamesDead([
        { ...base, status: 'not_available' },
        { ...base, status: 'rejected_by_client' },
        { ...base, status: 'rejected_by_sos' },
      ]),
    ).toBe(true)
  })
})

describe('confirmedClientFacingName (2026-09-11, dev job cb771564)', () => {
  const base: NameCheck = { name: 'X', source: 'wizard', status: 'pending', updated_at: null }

  it('null when nothing is real enough yet — pending/available/not_available/rejected are not shown to the client', () => {
    expect(confirmedClientFacingName([])).toBeNull()
    expect(confirmedClientFacingName(null)).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'pending' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'available' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'not_available' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'rejected_by_client' }])).toBeNull()
    expect(confirmedClientFacingName([{ ...base, status: 'rejected_by_sos' }])).toBeNull()
  })

  it('shows a name the instant it is sent to the client for approval — the earliest real commitment', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'sent_to_client' }])).toBe('Lead Lift LLC')
  })

  it('shows an accepted name', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'accepted' }])).toBe('Lead Lift LLC')
  })

  it('shows a filed name', () => {
    expect(confirmedClientFacingName([{ ...base, name: 'Lead Lift LLC', status: 'filed' }])).toBe('Lead Lift LLC')
  })

  it('prefers the most-advanced qualifying candidate when somehow more than one qualifies', () => {
    const checks: NameCheck[] = [
      { ...base, name: 'First Choice LLC', status: 'sent_to_client' },
      { ...base, name: 'Actually Filed LLC', status: 'filed' },
    ]
    expect(confirmedClientFacingName(checks)).toBe('Actually Filed LLC')
  })

  it('skips a blank name and falls through to a qualifying one', () => {
    expect(confirmedClientFacingName([{ ...base, name: '   ', status: 'filed' }])).toBeNull()
    expect(
      confirmedClientFacingName([
        { ...base, name: '   ', status: 'filed' },
        { ...base, name: 'Real Name LLC', status: 'accepted' },
      ]),
    ).toBe('Real Name LLC')
  })

  it('AMBIGUITY GUARD (2026-09-11, senior-engineer council catch): returns null on a genuine tie between two DIFFERENT names at the same rank, rather than guessing', () => {
    // Nothing server-side stops staff from sending two different candidates
    // to the client before either is answered — if that happens, showing
    // either name confidently would be a coin flip against what the client's
    // actual decision card is asking about. The generic placeholder is safer.
    expect(
      confirmedClientFacingName([
        { ...base, name: 'First Sent LLC', status: 'sent_to_client' },
        { ...base, name: 'Second Sent LLC', status: 'sent_to_client' },
      ]),
    ).toBeNull()
  })

  it('is NOT fooled into false ambiguity by the exact same name appearing twice at the same rank', () => {
    expect(
      confirmedClientFacingName([
        { ...base, name: 'Lead Lift LLC', status: 'sent_to_client' },
        { ...base, name: 'Lead Lift LLC', status: 'sent_to_client' },
      ]),
    ).toBe('Lead Lift LLC')
  })

  it('a higher-rank candidate still wins outright over a lower-rank tie', () => {
    expect(
      confirmedClientFacingName([
        { ...base, name: 'Sent One LLC', status: 'sent_to_client' },
        { ...base, name: 'Sent Two LLC', status: 'sent_to_client' },
        { ...base, name: 'Actually Filed LLC', status: 'filed' },
      ]),
    ).toBe('Actually Filed LLC')
  })
})


describe('nameDedupeKey', () => {
  it('treats LLC suffix, case, punctuation and spacing as the same name', () => {
    const k = nameDedupeKey('Redstone Horizon')
    expect(nameDedupeKey('REDSTONE  HORIZON LLC')).toBe(k)
    expect(nameDedupeKey('Redstone Horizon L.L.C.')).toBe(k)
    expect(nameDedupeKey('Redstone Horizon, LLC')).toBe(k)
    expect(nameDedupeKey('Redstone Horizon Limited Liability Company')).toBe(k)
  })
  it('keeps genuinely different names apart and handles junk', () => {
    expect(nameDedupeKey('Redstone Atlas')).not.toBe(nameDedupeKey('Redstone Horizon'))
    expect(nameDedupeKey(null)).toBe('')
    expect(nameDedupeKey('   ')).toBe('')
  })
})

describe('addStaffName', () => {
  const NOW = '2026-10-15T00:00:00.000Z'
  const dead: NameCheck = { name: 'Redstone Global LLC', source: 'wizard', status: 'not_available', updated_at: null }

  it('appends a pending staff_added entry with a cleaned name, without mutating the input', () => {
    const input = [dead]
    const r = addStaffName(input, '  Redstone   Horizon  ', NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.checks).toHaveLength(2)
      expect(r.checks[1]).toEqual({ name: 'Redstone Horizon', source: 'staff_added', status: 'pending', updated_at: NOW })
    }
    expect(input).toHaveLength(1)
  })
  it('works on an empty or missing list', () => {
    expect(addStaffName(null, 'Acme LLC', NOW).ok).toBe(true)
    expect(addStaffName([], 'Acme LLC', NOW).ok).toBe(true)
  })
  it('rejects blank, non-text and over-long names', () => {
    expect(addStaffName([], '   ', NOW).ok).toBe(false)
    expect(addStaffName([], 42, NOW).ok).toBe(false)
    expect(addStaffName([], 'x'.repeat(MAX_STAFF_NAME_LENGTH + 1), NOW).ok).toBe(false)
  })
  it('rejects a duplicate of any existing name, dead ones included', () => {
    const r = addStaffName([dead], 'redstone global', NOW)
    expect(r.ok).toBe(false)
  })
  it('caps the number of candidates', () => {
    const many: NameCheck[] = Array.from({ length: 30 }, (_, i) => ({ name: `N${i}`, source: 'wizard', status: 'pending', updated_at: null }))
    expect(addStaffName(many, 'One More', NOW).ok).toBe(false)
  })
  it('a pending staff-added name makes the list not all-dead (hides Request New Names)', () => {
    const r = addStaffName([dead], 'Fresh Name', NOW)
    if (r.ok) expect(allNamesDead(r.checks)).toBe(false)
  })
})
