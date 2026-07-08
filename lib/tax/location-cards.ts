/**
 * Location-period + country-card builder (Phase B2, 2026-07-08).
 *
 * PURE extraction of the builder that lived inline in the staff GET
 * (`app/api/tools/pnl/[id]/route.ts`) so the portal GET can serve the SAME
 * cards from the client's books. Both callers load their own rows/answers
 * (workspace tables vs bank_transactions + account-scoped pnl_period_answers)
 * and feed plain arrays here — this module touches no DB.
 *
 * Semantics preserved verbatim from the staff builder (S2/S3/S4):
 *  - Period DETECTION is deterministic-only (loc_source 'text'|'map'); the
 *    FULL located set (incl. 'ai') feeds the country cards.
 *  - A period ≥80%-covered by an active answer for its primary country is
 *    answered — no card.
 *  - Country cards: one per non-residence country with still-sweepable located
 *    spend (amount<0, sweepable category, not hand-answered). Counts mirror
 *    the sweep predicate EXACTLY — they feed the confirm modal's expected_*
 *    guard.
 *  - A country covered by an ACTIVE full-year answer or a standing account
 *    policy shows no card (S4: revoked full-year answers stay booked but the
 *    card returns).
 */

import { detectPresencePeriods, PERIOD_SWEEPABLE_CATEGORIES, type PresencePeriod } from "./presence-periods"
import { rowRootKey } from "./row-root"

export interface LocatedRow {
  id: string
  transaction_date: string
  description: string | null
  counterparty: string | null
  amount: number
  category: string | null
  notes: string | null
  loc_code: string | null
  loc_source: string | null
}

export interface ActivePeriodAnswer {
  loc_codes: string[]
  period_start: string
  period_end: string
  policy_revoked_at: string | null
}

export interface CountryCard {
  loc_code: string
  count: number
  total: number
  merchants: string[]
  keys: string[]
}

function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = Math.max(Date.parse(aStart), Date.parse(bStart))
  const e = Math.min(Date.parse(aEnd), Date.parse(bEnd))
  return e < s ? 0 : (e - s) / 86400000 + 1
}

export function buildLocationCards(input: {
  locatedRows: LocatedRow[]
  /** ACTIVE (not-undone) period answers only — filter undone_at upstream. */
  periodAnswers: ActivePeriodAnswer[]
  /** Standing account policies' country codes (active only). */
  accountPolicyCodes: string[]
  residenceCountry: string | null
  taxYear: number
}): { periods: PresencePeriod[]; country_cards: CountryCard[] } {
  const { locatedRows, periodAnswers, accountPolicyCodes, residenceCountry, taxYear } = input

  // Period detection — deterministic sources only.
  const allPeriods = detectPresencePeriods(
    locatedRows
      .filter(r => r.loc_source === "text" || r.loc_source === "map")
      .map(r => ({
        id: r.id,
        transaction_date: r.transaction_date,
        description: r.description,
        counterparty: r.counterparty,
        amount: r.amount,
        category: r.category,
        notes: r.notes,
        loc_code: r.loc_code,
      })),
    residenceCountry,
  )
  const periods = allPeriods.filter(p => {
    if (p.sweepable_count === 0) return false
    const pDays = overlapDays(p.start, p.end, p.start, p.end)
    return !periodAnswers.some(b =>
      b.loc_codes.includes(p.primary) &&
      overlapDays(p.start, p.end, b.period_start, b.period_end) / pDays >= 0.8)
  })

  // Country coverage: active full-year answers + standing account policies.
  const yearStart = `${taxYear}-01-01`, yearEnd = `${taxYear}-12-31`
  const sweepableSet = new Set<string>(PERIOD_SWEEPABLE_CATEGORIES as readonly string[])
  const coveredCountries = new Set<string>(accountPolicyCodes)
  for (const b of periodAnswers) {
    if (b.policy_revoked_at) continue
    if (b.period_start <= yearStart && b.period_end >= yearEnd) {
      for (const c of b.loc_codes) coveredCountries.add(c)
    }
  }

  const byCountry = new Map<string, { count: number; total: number; merchants: Map<string, number>; keys: Set<string> }>()
  for (const r of locatedRows) {
    const code = r.loc_code ?? ""
    if (!code || code === residenceCountry || coveredCountries.has(code)) continue
    if (r.amount >= 0 || !sweepableSet.has(String(r.category)) || (r.notes !== null && r.notes.startsWith("manual:"))) continue
    const e = byCountry.get(code) ?? { count: 0, total: 0, merchants: new Map(), keys: new Set() }
    e.count++
    e.total += Math.abs(r.amount)
    const root = rowRootKey(r.description ?? "", r.counterparty)
    e.merchants.set(root.label, (e.merchants.get(root.label) ?? 0) + 1)
    e.keys.add(root.key)
    byCountry.set(code, e)
  }
  const country_cards: CountryCard[] = Array.from(byCountry.entries())
    .map(([loc_code, e]) => ({
      loc_code,
      count: e.count,
      total: Math.round(e.total * 100) / 100,
      merchants: Array.from(e.merchants.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m]) => m),
      keys: Array.from(e.keys),
    }))
    .sort((a, b) => b.count - a.count)

  return { periods, country_cards }
}
