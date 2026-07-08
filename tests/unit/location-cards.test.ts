/**
 * Unit tests for lib/tax/location-cards.ts (Phase B2, 2026-07-08) — the pure
 * period/country-card builder extracted from the staff GET so the portal
 * serves the same cards from the client's books. Pins the extracted semantics:
 *  - period detection is deterministic-only (text/map — never 'ai')
 *  - country cards count the FULL located set (incl. 'ai')
 *  - sweep-predicate mirror: amount<0, sweepable category, not manual
 *  - residence country never gets a card
 *  - active full-year answers + standing policies suppress cards; a revoked
 *    full-year answer's card RETURNS
 *  - ≥80%-covered periods are answered (no card)
 */

import { describe, it, expect } from "vitest"
import { buildLocationCards, type LocatedRow } from "@/lib/tax/location-cards"

const YEAR = 2024

/** A located spend row in ES, defaults sweepable. */
function row(over: Partial<LocatedRow> & { id: string }): LocatedRow {
  return {
    transaction_date: `${YEAR}-06-10`,
    description: "CARREFOUR MADRID",
    counterparty: null,
    amount: -25,
    category: "uncategorized",
    notes: null,
    loc_code: "ES",
    loc_source: "text",
    ...over,
  }
}

describe("buildLocationCards — country cards", () => {
  it("aggregates sweepable located spend per non-residence country", () => {
    const { country_cards } = buildLocationCards({
      locatedRows: [
        row({ id: "1", amount: -10 }),
        row({ id: "2", amount: -20, description: "GLOVO BARCELONA" }),
        row({ id: "3", loc_code: "IT", amount: -5, description: "ESSELUNGA MILANO" }),
      ],
      periodAnswers: [],
      accountPolicyCodes: [],
      residenceCountry: null,
      taxYear: YEAR,
    })
    expect(country_cards.map(c => c.loc_code)).toEqual(["ES", "IT"])
    const es = country_cards[0]
    expect(es.count).toBe(2)
    expect(es.total).toBe(30)
    expect(es.merchants.length).toBeGreaterThan(0)
    expect(es.keys.length).toBeGreaterThan(0)
  })

  it("excludes residence country, inflows, non-sweepable categories, and manual rows", () => {
    const { country_cards } = buildLocationCards({
      locatedRows: [
        row({ id: "1", loc_code: "IT" }),                                   // residence
        row({ id: "2", amount: 50 }),                                        // inflow
        row({ id: "3", category: "income" }),                                // not sweepable
        row({ id: "4", notes: "manual: staff answer" }),                     // hand-answered
        row({ id: "5" }),                                                    // counted
      ],
      periodAnswers: [],
      accountPolicyCodes: [],
      residenceCountry: "IT",
      taxYear: YEAR,
    })
    expect(country_cards).toHaveLength(1)
    expect(country_cards[0].loc_code).toBe("ES")
    expect(country_cards[0].count).toBe(1)
  })

  it("counts 'ai'-located rows in cards (full located set)", () => {
    const { country_cards } = buildLocationCards({
      locatedRows: [row({ id: "1", loc_source: "ai" })],
      periodAnswers: [],
      accountPolicyCodes: [],
      residenceCountry: null,
      taxYear: YEAR,
    })
    expect(country_cards).toHaveLength(1)
  })

  it("suppresses a country covered by an ACTIVE full-year answer, but a REVOKED one returns", () => {
    const base = {
      locatedRows: [row({ id: "1" })],
      accountPolicyCodes: [],
      residenceCountry: null,
      taxYear: YEAR,
    }
    const active = buildLocationCards({
      ...base,
      periodAnswers: [{ loc_codes: ["ES"], period_start: `${YEAR}-01-01`, period_end: `${YEAR}-12-31`, policy_revoked_at: null }],
    })
    expect(active.country_cards).toHaveLength(0)
    const revoked = buildLocationCards({
      ...base,
      periodAnswers: [{ loc_codes: ["ES"], period_start: `${YEAR}-01-01`, period_end: `${YEAR}-12-31`, policy_revoked_at: "2026-01-01T00:00:00Z" }],
    })
    expect(revoked.country_cards).toHaveLength(1)
  })

  it("suppresses a country covered by a standing account policy", () => {
    const { country_cards } = buildLocationCards({
      locatedRows: [row({ id: "1" })],
      periodAnswers: [],
      accountPolicyCodes: ["ES"],
      residenceCountry: null,
      taxYear: YEAR,
    })
    expect(country_cards).toHaveLength(0)
  })
})

describe("buildLocationCards — periods", () => {
  // A dense presence window: daily in-person spend in ES for 3 weeks.
  const denseEs = Array.from({ length: 21 }, (_, i) =>
    row({
      id: `d${i}`,
      transaction_date: `${YEAR}-03-${String(i + 1).padStart(2, "0")}`,
      description: `CAFETERIA MADRID ${i}`,
      amount: -8,
    }))

  it("detects a period from deterministic stamps and drops it once ≥80% answered", () => {
    const detected = buildLocationCards({
      locatedRows: denseEs,
      periodAnswers: [],
      accountPolicyCodes: [],
      residenceCountry: "IT",
      taxYear: YEAR,
    })
    expect(detected.periods.length).toBeGreaterThan(0)
    const p = detected.periods[0]
    const answered = buildLocationCards({
      locatedRows: denseEs,
      periodAnswers: [{ loc_codes: [p.primary], period_start: p.start, period_end: p.end, policy_revoked_at: null }],
      accountPolicyCodes: [],
      residenceCountry: "IT",
      taxYear: YEAR,
    })
    expect(answered.periods).toHaveLength(0)
  })

  it("'ai' stamps never create presence density", () => {
    const { periods } = buildLocationCards({
      locatedRows: denseEs.map(r => ({ ...r, loc_source: "ai" })),
      periodAnswers: [],
      accountPolicyCodes: [],
      residenceCountry: "IT",
      taxYear: YEAR,
    })
    expect(periods).toHaveLength(0)
  })
})
