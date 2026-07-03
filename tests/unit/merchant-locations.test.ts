/**
 * Deterministic location inference (Phase 2b) — the frozen vocabulary and the
 * never-guess extractor the period cards stand on. Fixtures are lifted from
 * REAL prod statement strings (architect cond. 8).
 */
import { describe, it, expect } from 'vitest'
import {
  MERCHANT_LOCATION_MAP,
  REGION_TOKENS,
  inferLocation,
  residenceCountryToIso,
  EU_COUNTRIES,
} from '@/lib/tax/merchant-locations'

const out = (description: string, over: Partial<Parameters<typeof inferLocation>[0]> = {}) =>
  inferLocation({ description, counterparty: null, amount: -25, ...over })

describe('MERCHANT_LOCATION_MAP — frozen vocabulary pin', () => {
  it('every map value is ISO alpha-2 or a declared region token (no UK/EL-style variants can slip in)', () => {
    for (const { loc } of MERCHANT_LOCATION_MAP) {
      expect(loc).toMatch(/^[A-Z]{2}$/)
      const isRegion = (REGION_TOKENS as readonly string[]).includes(loc)
      const isCountry = !isRegion
      expect(isRegion || isCountry).toBe(true)
    }
  })

  it('pins the flagship entries: Glovo → EU (region, medium), Talabat → AE (high)', () => {
    expect(MERCHANT_LOCATION_MAP.find(m => m.pattern === 'glovo')).toEqual({ pattern: 'glovo', loc: 'EU', confidence: 'medium' })
    expect(MERCHANT_LOCATION_MAP.find(m => m.pattern === 'talabat')).toEqual({ pattern: 'talabat', loc: 'AE', confidence: 'high' })
  })

  it("region tokens are exactly ['EU'] and EU is in nobody's country list", () => {
    expect([...REGION_TOKENS]).toEqual(['EU'])
    expect(EU_COUNTRIES.has('EU')).toBe(false)
  })
})

describe('inferLocation — Chase card-suffix extractor (real prod strings)', () => {
  it('US city + state before "Card NNNN" → US, text, high', () => {
    expect(out('Card Purchase 01/21 Sq *Joffrey?S Coffee An Tampa FL Card 5782'))
      .toEqual({ loc_code: 'US', loc_source: 'text', loc_confidence: 'high' })
    expect(out('Card Purchase With Pin 01/17 Sunoco 0605562800 Clearwater FL Card 5790'))
      .toEqual({ loc_code: 'US', loc_source: 'text', loc_confidence: 'high' })
  })

  it('gazetteer city before "Card NNNN" → country', () => {
    expect(out('Card Purchase 04/02 Farmacia Exposul Lisboa Card 5790'))
      .toEqual({ loc_code: 'PT', loc_source: 'text', loc_confidence: 'high' })
  })

  it('truncated city ("Setu") → null — never guesses', () => {
    expect(out('Card Purchase 05/12 Repsol Comercial Setu Card 5790')).toBeNull()
  })

  it('ambiguous city ("Perth" — AU or Scotland) is not in the gazetteer → null', () => {
    expect(out('Card Purchase 03/03 Cafe Central Perth Card 5790')).toBeNull()
  })

  it('explicit currency-country token ("AE Dirham") → AE even without a card suffix', () => {
    expect(out('talabat pro Dubai                            10/31 AE Dirham  29.00 X 0.2724138 (EXCHG RTE) | DEBIT | DEBIT_CARD'))
      .toEqual({ loc_code: 'AE', loc_source: 'text', loc_confidence: 'high' })
  })
})

describe('inferLocation — merchant map + exclusions', () => {
  it('Glovo (bare Wise/Mercury description) → EU via the frozen map, medium', () => {
    expect(out('Glovo 24MAR')).toEqual({ loc_code: 'EU', loc_source: 'map', loc_confidence: 'medium' })
    expect(out('Glovo GLOVO PRIME  ••6776')).toEqual({ loc_code: 'EU', loc_source: 'map', loc_confidence: 'medium' })
  })

  it('Cars Taxi (Dubai) → AE via map', () => {
    expect(out('Cars Taxi Services ••7229')).toEqual({ loc_code: 'AE', loc_source: 'map', loc_confidence: 'high' })
  })

  it('online/global merchants are never located', () => {
    expect(out('Shopify ••6776')).toBeNull()
    expect(out('Klaviyo Inc')).toBeNull()
    expect(out('Fiverr')).toBeNull()
  })

  it('ATM / cash withdrawals are NEVER located — city text or not (they are draws, not expenses)', () => {
    expect(out('Non-Chase ATM Withdraw 06/11 Via Roma Milano Card 5790')).toBeNull()
    expect(out('ATM Cash Advance Dubai Mall')).toBeNull()
  })

  it('inflows have no spend location', () => {
    expect(out('Glovo refund', { amount: 19.15 })).toBeNull()
  })

  it('internal transfers/conversions are never located', () => {
    expect(out('Glovo something', { category: 'conversion' })).toBeNull()
  })

  it('empty description + no counterparty → null', () => {
    expect(inferLocation({ description: null, counterparty: null, amount: -10 })).toBeNull()
  })
})

describe('residenceCountryToIso — the CRM fiscal-residence anchor', () => {
  it('maps declared country names (free text) to ISO', () => {
    expect(residenceCountryToIso('United Arab Emirates')).toBe('AE')
    expect(residenceCountryToIso('Italia')).toBe('IT')
    expect(residenceCountryToIso('spain')).toBe('ES')
  })
  it('passes through ISO codes and rejects unknowns (null → no suppression, UI shows a note)', () => {
    expect(residenceCountryToIso('IT')).toBe('IT')
    expect(residenceCountryToIso('Wakanda')).toBeNull()
    expect(residenceCountryToIso(null)).toBeNull()
    expect(residenceCountryToIso('  ')).toBeNull()
  })
})
