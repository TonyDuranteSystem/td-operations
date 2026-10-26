import { describe, it, expect } from 'vitest'
import { customTypesOnOffer, mergeSnapshot, untypedServiceNames, fillLineContractTypes, fillPackageContractTypes } from '@/lib/offers/contract-texts-snapshot'

const wording = (t: string) => ({
  title: t, shortTitle: t, pdfPrefix: 'X_Agreement',
  scope: { intro: 'i', items: ['a'], closing: 'c' }, procedure: { intro: 'p', steps: [{ title: 's', desc: 'd' }] },
  commitments: ['c1'], clientDuties: { intro: 'd', items: [{ bold: 'b', rest: 'r' }] }, signatureText: 'sig', successNote: 'ok', workPhrase: 'the work', liabilityPhrase: 'delays',
})
const row = (version: number, t = 'v') => ({ version, content_hash: `hash${version}`, content: wording(t) })

describe('customTypesOnOffer', () => {
  it('collects the offer type, every line type and every package option line type — custom ones only, once each', () => {
    const t = customTypesOnOffer({
      contractType: 'custom_a',
      services: [{ contract_type: 'custom_a' }, { contract_type: 'custom_b' }, { contract_type: 'shipping' }, { contract_type: null }, null],
      packages: [{ services: [{ contract_type: 'custom_c' }, { contract_type: 'custom_b' }] }],
    })
    expect(t.sort()).toEqual(['custom_a', 'custom_b', 'custom_c'])
  })
  it('an offer with no custom type needs nothing', () => {
    expect(customTypesOnOffer({ contractType: 'tax_return', services: [{ contract_type: 'itin' }] })).toEqual([])
    expect(customTypesOnOffer({})).toEqual([])
    expect(customTypesOnOffer({ services: 'text', packages: 5 })).toEqual([])
  })
})

describe('mergeSnapshot — the frozen copy', () => {
  const now = new Date('2026-10-26T12:00:00Z')

  it('adds the approved version of each needed type, with its version and fingerprint', () => {
    const r = mergeSnapshot(['custom_a'], null, { custom_a: row(2) }, now)
    expect(r.changed).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.texts.custom_a).toMatchObject({ version: 2, hash: 'hash2', snapshot_at: '2026-10-26T12:00:00.000Z' })
  })

  it('NEVER replaces an entry already frozen — a newer approved version does not reach an offer already sent', () => {
    const existing = { custom_a: { version: 1, hash: 'hash1', content: wording('old'), snapshot_at: '2026-10-01T00:00:00Z' } }
    const r = mergeSnapshot(['custom_a'], existing, { custom_a: row(2, 'new') }, now)
    expect(r.changed).toBe(false)
    expect(r.texts.custom_a.version).toBe(1)
    expect((r.texts.custom_a.content as { title: string }).title).toBe('old')
  })

  it('completes a partial copy: keeps the frozen type, adds the new one', () => {
    const existing = { custom_a: { version: 1, hash: 'h1', content: wording('a1') } }
    const r = mergeSnapshot(['custom_a', 'custom_b'], existing, { custom_a: row(5), custom_b: row(1, 'b1') }, now)
    expect(r.changed).toBe(true)
    expect(r.texts.custom_a.version).toBe(1)
    expect(r.texts.custom_b.version).toBe(1)
  })

  it('a needed type with no approved version is reported missing, not invented', () => {
    const r = mergeSnapshot(['custom_a', 'custom_b'], null, { custom_a: row(1) }, now)
    expect(r.missing).toEqual(['custom_b'])
    expect(r.texts.custom_b).toBeUndefined()
  })

  it('an approved row whose wording is not valid is treated as missing (never frozen)', () => {
    const r = mergeSnapshot(['custom_a'], null, { custom_a: { version: 1, content_hash: 'h', content: { title: 'only' } } }, now)
    expect(r.missing).toEqual(['custom_a'])
    expect(r.changed).toBe(false)
  })

  it('a damaged existing entry is not trusted: it is replaced by the approved version', () => {
    const r = mergeSnapshot(['custom_a'], { custom_a: { version: 1, hash: 'h', content: { broken: true } } }, { custom_a: row(3) }, now)
    expect(r.texts.custom_a.version).toBe(3)
    expect(r.changed).toBe(true)
  })

  it('ignores entries that are not custom types or not objects', () => {
    const r = mergeSnapshot([], { shipping: { version: 1, hash: 'h', content: wording('x') }, custom_z: 'str', custom_q: null }, {}, now)
    expect(r.texts).toEqual({})
  })
})


describe('an offer built BEFORE its new service had a contract — its lines carry no contract type', () => {
  const map = { Apostille: 'custom_apostille' }
  it('untypedServiceNames lists new-service lines with no type; historical services, typed lines and plain billing lines are ignored', () => {
    expect(untypedServiceNames({
      services: [{ pipeline_type: 'Apostille' }, { pipeline_type: 'Apostille' }, { pipeline_type: 'Notary plus', contract_type: '' }, { pipeline_type: 'Company Formation' }, { pipeline_type: 'Shipping', contract_type: 'shipping' }, { name: 'Setup fee' }, null],
      packages: [{ services: [{ pipeline_type: 'Other new' }] }],
    }).sort()).toEqual(['Apostille', 'Notary plus', 'Other new'])
    expect(untypedServiceNames({})).toEqual([])
    expect(untypedServiceNames({ services: 'x', packages: 3 })).toEqual([])
  })
  it('fillLineContractTypes gives an untyped line the service’s own type — and never overwrites a type', () => {
    const lines = [{ pipeline_type: 'Apostille', price: '$150' }, { pipeline_type: 'Apostille', contract_type: 'shipping' }, { pipeline_type: 'Other' }, { name: 'fee' }, null]
    const r = fillLineContractTypes(lines, map)
    expect(r.changed).toBe(true)
    expect((r.lines as Array<Record<string, unknown>>)[0]).toEqual({ pipeline_type: 'Apostille', price: '$150', contract_type: 'custom_apostille' })
    expect((r.lines as Array<Record<string, unknown>>)[1].contract_type).toBe('shipping')
    expect((r.lines as Array<Record<string, unknown>>)[2].contract_type).toBeUndefined()
    expect(lines[0]).not.toHaveProperty('contract_type') // input untouched
  })
  it('nothing to fill = the same array back and changed=false', () => {
    const lines = [{ pipeline_type: 'Apostille', contract_type: 'custom_apostille' }]
    const r = fillLineContractTypes(lines, map)
    expect(r.changed).toBe(false)
    expect(r.lines).toBe(lines)
    expect(fillLineContractTypes('text', map)).toEqual({ lines: 'text', changed: false })
    expect(fillLineContractTypes([{ pipeline_type: 'Apostille' }], { Apostille: 'shipping' }).changed).toBe(false) // only custom types are ever filled
  })
  it('fillPackageContractTypes does the same inside every package option', () => {
    const pk = [{ key: 'a', services: [{ pipeline_type: 'Apostille' }] }, { key: 'b', services: [{ pipeline_type: 'Other' }] }]
    const r = fillPackageContractTypes(pk, map)
    expect(r.changed).toBe(true)
    expect((r.packages as Array<{ services: Array<Record<string, unknown>> }>)[0].services[0].contract_type).toBe('custom_apostille')
    expect((r.packages as Array<{ services: Array<Record<string, unknown>> }>)[1]).toBe(pk[1])
    expect(fillPackageContractTypes(null, map).changed).toBe(false)
  })
})
