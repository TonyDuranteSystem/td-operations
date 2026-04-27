import { describe, it, expect } from 'vitest'
import { extractMembersFromWizardData } from '@/lib/utils/wizard-members'

describe('extractMembersFromWizardData', () => {
  // ─── Path A: standalone form array ───────────────────────────

  it('returns array from additional_members (standalone form path)', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: 'Marco', member_last_name: 'Rossi', member_email: 'marco@test.com', member_ownership_pct: 40 },
      ],
    })
    expect(result).toHaveLength(1)
    expect(result[0].member_type).toBe('individual')
    if (result[0].member_type === 'individual') {
      expect(result[0].member_first_name).toBe('Marco')
      expect(result[0].member_last_name).toBe('Rossi')
      expect(result[0].member_ownership_pct).toBe(40)
    }
  })

  it('returns multiple members from additional_members array', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: 'Marco', member_last_name: 'Rossi', member_email: 'marco@test.com', member_ownership_pct: 40 },
        { member_first_name: 'Luca', member_last_name: 'Bianchi', member_email: 'luca@test.com', member_ownership_pct: 30 },
      ],
    })
    expect(result).toHaveLength(2)
    expect(result[1].member_type).toBe('individual')
    if (result[1].member_type === 'individual') {
      expect(result[1].member_first_name).toBe('Luca')
    }
  })

  // ─── Path B: portal wizard flat keys ─────────────────────────

  it('extracts members from flat wizard keys (portal wizard path)', () => {
    const result = extractMembersFromWizardData({
      member_count: 2,
      member_0_member_first_name: 'Marco',
      member_0_member_last_name: 'Rossi',
      member_0_member_email: 'marco@test.com',
      member_0_member_ownership_pct: '40',
      member_0_member_nationality: 'IT',
      member_0_member_street: 'Via Roma 1',
      member_0_member_city: 'Milan',
      member_0_member_country: 'Italy',
      member_1_member_first_name: 'Luca',
      member_1_member_last_name: 'Bianchi',
      member_1_member_email: 'luca@test.com',
      member_1_member_ownership_pct: '30',
    })
    expect(result).toHaveLength(2)
    expect(result[0].member_type).toBe('individual')
    expect(result[1].member_type).toBe('individual')
    if (result[0].member_type === 'individual') {
      expect(result[0].member_first_name).toBe('Marco')
      expect(result[0].member_ownership_pct).toBe(40)
    }
    if (result[1].member_type === 'individual') {
      expect(result[1].member_first_name).toBe('Luca')
    }
  })

  it('parses ownership_pct as number from string', () => {
    const result = extractMembersFromWizardData({
      member_count: 1,
      member_0_member_first_name: 'Marco',
      member_0_member_email: 'marco@test.com',
      member_0_member_ownership_pct: '40.5',
    })
    expect(result[0].member_type === 'individual' && result[0].member_ownership_pct).toBe(40.5)
  })

  // ─── Empty / edge cases ─────────────────────────────���─────────

  it('returns empty array when submitted is empty', () => {
    expect(extractMembersFromWizardData({})).toEqual([])
  })

  it('returns empty array when additional_members is empty array', () => {
    expect(extractMembersFromWizardData({ additional_members: [] })).toEqual([])
  })

  it('returns empty array when member_count is 0', () => {
    expect(extractMembersFromWizardData({ member_count: 0 })).toEqual([])
  })

  it('skips flat member entries with no identifying data', () => {
    const result = extractMembersFromWizardData({
      member_count: 2,
      member_0_member_first_name: 'Marco',
      member_0_member_email: 'marco@test.com',
      // member 1 has no data (user added slot but didn't fill it)
    })
    expect(result).toHaveLength(1)
  })

  // ─── Array wins over flat keys ───────────────────────────────���

  it('array path wins when both array and flat keys present', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: 'From Array', member_email: 'array@test.com' },
      ],
      member_count: 1,
      member_0_member_first_name: 'From Flat',
    })
    expect(result).toHaveLength(1)
    expect(result[0].member_type === 'individual' && result[0].member_first_name).toBe('From Array')
  })

  // ─── Company member type ─────────────────────────────���────────

  it('returns company member from array path', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        {
          member_type: 'company',
          member_company_name: 'Acme Corp',
          member_company_ein: '12-3456789',
          member_ownership_pct: 50,
          member_rep_name: 'John Doe',
          member_rep_email: 'john@acme.com',
        },
      ],
    })
    expect(result[0].member_type).toBe('company')
    if (result[0].member_type === 'company') {
      expect(result[0].member_company_name).toBe('Acme Corp')
      expect(result[0].member_company_ein).toBe('12-3456789')
      expect(result[0].member_ownership_pct).toBe(50)
      expect(result[0].member_rep_name).toBe('John Doe')
    }
  })

  it('returns company member from flat wizard keys', () => {
    const result = extractMembersFromWizardData({
      member_count: 1,
      member_0_member_type: 'company',
      member_0_member_company_name: 'Acme Corp',
      member_0_member_ownership_pct: '50',
      member_0_member_rep_email: 'john@acme.com',
    })
    expect(result[0].member_type).toBe('company')
    if (result[0].member_type === 'company') {
      expect(result[0].member_company_name).toBe('Acme Corp')
    }
  })

  it('defaults to individual type when member_type absent', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: 'Marco', member_email: 'marco@test.com' },
      ],
    })
    expect(result[0].member_type).toBe('individual')
  })

  // ─── Null / whitespace handling ─────────────────────��─────────

  it('converts empty strings to null', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: 'Marco', member_email: '', member_ownership_pct: '' },
      ],
    })
    if (result[0].member_type === 'individual') {
      expect(result[0].member_email).toBeNull()
      expect(result[0].member_ownership_pct).toBeNull()
    }
  })

  it('trims whitespace from string fields', () => {
    const result = extractMembersFromWizardData({
      additional_members: [
        { member_first_name: '  Marco  ', member_email: 'marco@test.com' },
      ],
    })
    if (result[0].member_type === 'individual') {
      expect(result[0].member_first_name).toBe('Marco')
    }
  })

  // ─── Count detection without member_count key ─────────────────

  it('detects member count from flat keys when member_count absent', () => {
    const result = extractMembersFromWizardData({
      member_0_member_first_name: 'Marco',
      member_0_member_email: 'marco@test.com',
      member_1_member_first_name: 'Luca',
      member_1_member_email: 'luca@test.com',
    })
    expect(result).toHaveLength(2)
  })
})
