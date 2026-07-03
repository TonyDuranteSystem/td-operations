/**
 * rowRootKey (Phase 3R cond. 11-14, 18) — the single merchant-root shared by
 * grouping, periods, learned rules, and the eval. Fixtures are the REAL prod
 * fragment shapes that produced Dynamiq's 894-group review.
 */
import { describe, it, expect } from 'vitest'
import { rowRootKey, RAIL_SET, WISE_TRANSFER_PHRASES } from '@/lib/tax/row-root'

const key = (d: string | null, c: string | null = null) => rowRootKey(d, c).key

describe('rowRootKey — fragmentation killers (real Dynamiq shapes)', () => {
  it('Wise date tokens collapse: Glovo / Glovo 12MAR / Glovo 09MAR / GLOVO PRIME ••1266 → one key', () => {
    expect(key('Glovo')).toBe('glovo')
    expect(key('Glovo 12MAR')).toBe('glovo')
    expect(key('Glovo 09MAR')).toBe('glovo')
    expect(key('Glovo ••1266')).toBe('glovo')
    expect(key('Glovo  ••1266')).toBe('glovo')
  })

  it('first-pipe-segment: Relay/Chase folds root on the merchant', () => {
    expect(key('SMRBINTERNATIONA | paypal')).toBe('smrbinternationa')
    expect(key('Eroski | Spend | Corporate Card - (Busin')).toBe('eroski')
    expect(key('SUPER XOROI | Spend | Corporate Card - 6921 (Business Card)')).toBe('super xoroi')
  })

  it('Chase card-purchase boilerplate: prefix + trailing "Card NNNN" stripped', () => {
    expect(key('Card Purchase 01/21 Sq *Joffrey?S Coffee An Tampa FL Card 5782'))
      .toBe('sq *joffrey?s coffee an tampa fl')
    expect(key('Recurring Card Purchase 12/01 Klaviyo Inc Card 5790')).toBe('klaviyo inc')
  })

  it('Wise transfer sentences root on the counterparty name — any supported locale', () => {
    expect(key('Se ha enviado dinero a LOREA LLP')).toBe('lorea llp')
    expect(key('Se ha enviado dinero a Menorca Culinary')).toBe('menorca culinary')
    expect(key('Sent money to Acme GmbH')).toBe('acme gmbh')
    expect(key('Inviato denaro a Mario Rossi')).toBe('mario rossi')
    expect(key('Has recibido dinero de MAURO DULLI con I')).toBe('mauro dulli con i')
  })

  it('keys are lowercased (the period-chip case-sensitivity regression)', () => {
    expect(key('GLOVO PRIME')).toBe(key('glovo prime'))
    expect(rowRootKey('Glovo 12MAR', null).label).toBe('Glovo')
  })
})

describe('rowRootKey — degenerate-description fallback (cond. 11, NOT counterparty-first)', () => {
  it('falls back to counterparty when the description is card boilerplate', () => {
    const r = rowRootKey('Unknown - Corporate Card - 6921 (Business Card)', 'Bershka')
    expect(r.key).toBe('bershka')
    expect(r.source).toBe('counterparty')
  })

  it('does NOT use counterparty when the description carries a real merchant — MCC labels stay harmless', () => {
    // Prod falsification case: counterparty='Restaurants' spans 137 distinct
    // merchants; description-first keeps them 137 groups.
    const a = rowRootKey('Tabik Restaurante', 'Restaurants')
    const b = rowRootKey('Don Gelato E Coffee Sl', 'Restaurants')
    expect(a.source).toBe('description')
    expect(b.source).toBe('description')
    expect(a.key).not.toBe(b.key)
  })

  it('empty description + counterparty → counterparty; both empty → (no description)', () => {
    expect(rowRootKey('', 'XOROI BEACH')).toEqual({ key: 'xoroi beach', label: 'XOROI BEACH', source: 'counterparty' })
    expect(rowRootKey(null, null)).toEqual({ key: '(no description)', label: '(no description)', source: 'none' })
  })

  it('degenerate description with degenerate/empty counterparty keeps a stable description bucket', () => {
    const r = rowRootKey('Unknown - Corporate Card - 4848 (Business Virtual Card)', '')
    expect(r.source).toBe('description')
    expect(r.key.length).toBeGreaterThan(0)
  })
})

describe('exported vocabularies', () => {
  it('RAIL_SET holds lowercased rail names', () => {
    for (const rail of Array.from(RAIL_SET)) expect(rail).toBe(rail.toLowerCase())
    expect(RAIL_SET.has('paypal')).toBe(true)
  })
  it('WISE_TRANSFER_PHRASES are anchored prefixes (never mid-string strips)', () => {
    for (const re of WISE_TRANSFER_PHRASES) expect(re.source.startsWith('^')).toBe(true)
  })
})
