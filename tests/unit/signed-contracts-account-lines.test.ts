import { describe, it, expect } from 'vitest'
import { accountLineName, buildAccountContractLines } from '@/lib/signed-contracts/account-lines'

const offer = (token: string, contract_type: string | null) => ({ token, contract_type })
const contract = (id: string, offer_token: string, over: Partial<{ signed_at: string | null; created_at: string | null; pdf_path: string | null }> = {}) => ({
  id,
  offer_token,
  signed_at: '2026-05-27T15:00:00+00:00',
  created_at: '2026-05-27T15:00:01+00:00',
  pdf_path: 'T/contract.pdf',
  ...over,
})

describe('accountLineName — short, plain names', () => {
  it('formation and onboarding are "<type> contract"; a renewal is named as one, with its year', () => {
    expect(accountLineName('formation', null)).toBe('Formation contract')
    expect(accountLineName('onboarding', 2026)).toBe('Onboarding contract')
    expect(accountLineName('renewal', 2026)).toBe('Annual renewal agreement 2026')
    expect(accountLineName('renewal', null)).toBe('Annual renewal agreement')
  })
  it('other kinds use their real agreement title; an unknown kind is "Service agreement"', () => {
    expect(accountLineName('itin', null)).toBe('ITIN Application Service Agreement')
    expect(accountLineName('custom_x_y', null)).toBe('Service agreement')
    expect(accountLineName(null, null)).toBe('Service agreement')
  })
})

describe('buildAccountContractLines', () => {
  it('one line per signed offer, with the New York day it was signed and whether the file is recorded', () => {
    const lines = buildAccountContractLines({
      offers: [offer('T1', 'onboarding')],
      contracts: [contract('c1', 'T1', { signed_at: '2026-02-13T01:30:00+00:00' })], // 8:30 pm Feb 12 in New York
      agreementYears: {},
    })
    expect(lines).toEqual([{ id: 'c1', name: 'Onboarding contract', signedOn: '2026-02-12', isMain: true, fileAvailable: true }])
  })

  it('an offer signed twice shows once: the newest file', () => {
    const lines = buildAccountContractLines({
      offers: [offer('T1', 'formation')],
      contracts: [
        contract('old', 'T1', { created_at: '2026-05-27T10:00:00+00:00' }),
        contract('new', 'T1', { created_at: '2026-05-27T11:00:00+00:00' }),
      ],
      agreementYears: {},
    })
    expect(lines.map((l) => l.id)).toEqual(['new'])
  })

  it('the contract the client signed when they became a client comes first, then the rest newest first', () => {
    const lines = buildAccountContractLines({
      offers: [offer('R', 'renewal'), offer('F', 'formation'), offer('I', 'itin')],
      contracts: [
        contract('cr', 'R', { signed_at: '2026-04-20T15:00:00+00:00' }),
        contract('cf', 'F', { signed_at: '2026-01-05T15:00:00+00:00' }),
        contract('ci', 'I', { signed_at: '2026-06-10T15:00:00+00:00' }),
      ],
      agreementYears: { R: 2026 },
    })
    expect(lines.map((l) => l.name)).toEqual(['Formation contract', 'ITIN Application Service Agreement', 'Annual renewal agreement 2026'])
    expect(lines.map((l) => l.isMain)).toEqual([true, false, false])
  })

  it('a renewal is labelled with the agreement year, or with the year it was signed when the agreement has none', () => {
    const base = { offers: [offer('R', 'renewal')], contracts: [contract('cr', 'R', { signed_at: '2026-04-20T15:00:00+00:00' })] }
    expect(buildAccountContractLines({ ...base, agreementYears: { R: 2027 } })[0].name).toBe('Annual renewal agreement 2027')
    expect(buildAccountContractLines({ ...base, agreementYears: {} })[0].name).toBe('Annual renewal agreement 2026')
    expect(buildAccountContractLines({ ...base, agreementYears: { R: null } })[0].name).toBe('Annual renewal agreement 2026')
  })

  it('a contract whose offer is not one of this company\'s offers is never shown', () => {
    const lines = buildAccountContractLines({ offers: [offer('MINE', 'onboarding')], contracts: [contract('x', 'SOMEONE_ELSE')], agreementYears: {} })
    expect(lines).toEqual([])
  })

  it('no recorded file: the line still shows, with Open unavailable', () => {
    for (const pdf_path of [null, '', '  ', '../etc/passwd', 'a\\b']) {
      const [l] = buildAccountContractLines({ offers: [offer('T', 'onboarding')], contracts: [contract('c', 'T', { pdf_path })], agreementYears: {} })
      expect(l.fileAvailable).toBe(false)
    }
  })

  it('a contract with no signing date shows without a date and sorts last', () => {
    const lines = buildAccountContractLines({
      offers: [offer('A', 'itin'), offer('B', 'closure')],
      contracts: [contract('a', 'A', { signed_at: null }), contract('b', 'B', { signed_at: '2026-03-01T15:00:00+00:00' })],
      agreementYears: {},
    })
    expect(lines.map((l) => [l.id, l.signedOn])).toEqual([['b', '2026-03-01'], ['a', null]])
  })

  it('nothing signed: no lines', () => {
    expect(buildAccountContractLines({ offers: [offer('T', 'onboarding')], contracts: [], agreementYears: {} })).toEqual([])
  })
})
