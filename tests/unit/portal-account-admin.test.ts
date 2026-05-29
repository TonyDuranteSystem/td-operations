import { describe, it, expect } from 'vitest'
import {
  pickAccountAdminContactId,
  resolveAccountAdminContactId,
  isAccountAdmin,
  type AdminInputs,
} from '@/lib/portal/team/account-admin'

const base: AdminInputs = {
  persistedAdminId: null,
  isMMLLC: false,
  signerContactId: null,
  signerNameMatchContactId: null,
  ownerContactId: null,
  soleContactId: null,
}

describe('pickAccountAdminContactId — precedence', () => {
  it('persisted override always wins', () => {
    expect(pickAccountAdminContactId({ ...base, persistedAdminId: 'OVR', isMMLLC: true, signerContactId: 'SIG', ownerContactId: 'OWN' })).toBe('OVR')
  })

  it('SMLLC: owner contact, else sole contact', () => {
    expect(pickAccountAdminContactId({ ...base, ownerContactId: 'OWN', soleContactId: 'SOLE' })).toBe('OWN')
    expect(pickAccountAdminContactId({ ...base, ownerContactId: null, soleContactId: 'SOLE' })).toBe('SOLE')
    expect(pickAccountAdminContactId({ ...base })).toBeNull()
  })

  it('MMLLC: SS-4 signer contact first', () => {
    expect(pickAccountAdminContactId({ ...base, isMMLLC: true, signerContactId: 'SIG', ownerContactId: 'OWN' })).toBe('SIG')
  })

  it('MMLLC: signer name-match when signer has no contact_id', () => {
    expect(pickAccountAdminContactId({ ...base, isMMLLC: true, signerNameMatchContactId: 'NM', ownerContactId: 'OWN' })).toBe('NM')
  })

  it('MMLLC: falls back to owner then sole when no signer', () => {
    expect(pickAccountAdminContactId({ ...base, isMMLLC: true, ownerContactId: 'OWN', soleContactId: 'SOLE' })).toBe('OWN')
    expect(pickAccountAdminContactId({ ...base, isMMLLC: true, soleContactId: 'SOLE' })).toBe('SOLE')
    expect(pickAccountAdminContactId({ ...base, isMMLLC: true })).toBeNull()
  })
})

describe('resolveAccountAdminContactId + isAccountAdmin (wrapper)', () => {
  const deps = (inputs: Partial<AdminInputs>) => ({
    gatherAdminInputs: async () => ({ ...base, ...inputs }),
  })

  it('resolves via the gathered inputs', async () => {
    expect(await resolveAccountAdminContactId('a1', deps({ ownerContactId: 'OWN' }))).toBe('OWN')
  })

  it('isAccountAdmin true only for the resolved admin', async () => {
    const d = deps({ isMMLLC: true, signerContactId: 'SIG' })
    expect(await isAccountAdmin('SIG', 'a1', d)).toBe(true)
    expect(await isAccountAdmin('OWN', 'a1', d)).toBe(false)
  })

  it('isAccountAdmin false for empty contact or unresolvable admin', async () => {
    expect(await isAccountAdmin('', 'a1', deps({ ownerContactId: 'OWN' }))).toBe(false)
    expect(await isAccountAdmin('X', 'a1', deps({}))).toBe(false)
  })
})
