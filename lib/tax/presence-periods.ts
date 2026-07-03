/**
 * Presence-period detection (Smart Categorization v2, Phase 2b).
 *
 * PURE: given located workspace rows, find the stretches where the owner was
 * physically operating somewhere ("~6 months in Italy") so the review can ask
 * ONE question per stretch — "Were you in Italy, Feb–Aug? All business / all
 * personal / review one-by-one" — instead of hundreds of merchant questions.
 *
 * Dual-review requirements baked in:
 * - PER-LOCATION INDEPENDENT runs, overlap legal (two members can be in two
 *   countries at once — no one-country-per-week vote).
 * - Row-scoped by construction: a period only ever references rows whose
 *   loc_code is in its own code set; card counts/merchants come from the same
 *   set (an "Italy" card can never advertise or sweep a Dubai row).
 * - EU/country containment: one physical stay yields country-coded text rows
 *   (Lisboa → PT) AND region-coded map rows (Glovo → EU) over the same weeks;
 *   a country period overlapping an EU period ≥50% MERGES into one card whose
 *   code set is {country, EU} — never a double-ask.
 * - Residence anchor (Antonio, 2026-07-03): periods in the client's FISCAL-
 *   residence country are suppressed — home-country daily life stays in the
 *   normal one-by-one review. If residence is an EU member, 'EU' periods are
 *   suppressed too (indistinguishable from home).
 * - LOW-confidence periods are never emitted (property-tested): below-floor
 *   density simply isn't a period.
 * - Tuning constants exported by name; tuned once on the Dynamiq fork against
 *   Antonio's judgment, value recorded in the design doc.
 */

import { rowRootKey } from "./row-root"
import { EU_COUNTRIES, REGION_TOKENS } from "./merchant-locations"

/** A week "counts" toward presence when it has at least this many located
 *  presence rows for the location. */
export const PRESENCE_MIN_ROWS_PER_WEEK = 2
/** A period must span at least this many active weeks. */
export const PRESENCE_MIN_WEEKS = 3
/** Same-location blocks separated by up to this many INACTIVE weeks merge —
 *  a short home visit mid-stay doesn't split the business period. */
export const PRESENCE_MAX_GAP_WEEKS = 2
/** Country ⊂ EU merge threshold: overlap / shorter-duration ≥ this. */
export const PERIOD_MERGE_OVERLAP = 0.5

export interface LocatableRow {
  id: string
  transaction_date: string
  description: string | null
  counterparty: string | null
  amount: number
  category: string | null
  notes: string | null
  loc_code: string | null
}

export interface PresencePeriod {
  /** The swept/displayed code set — [country] or [country,'EU'] or ['EU']. */
  loc_codes: string[]
  /** Display anchor: the country when present, else 'EU'. */
  primary: string
  start: string // ISO date (inclusive)
  end: string   // ISO date (inclusive)
  confidence: "high" | "medium"
  /** All located rows in-window matching loc_codes (presence evidence). */
  row_count: number
  dollar_total: number
  /** Rows the sweep could actually book (category eligible + not manual). */
  sweepable_count: number
  sweepable_total: number
  top_merchants: string[]
  /** Merchant-group keys of matching rows — powers the review-one-by-one filter chip. */
  group_keys: string[]
}

/** Categories a period answer may rewrite (matches the endpoint predicate). */
export const PERIOD_SWEEPABLE_CATEGORIES = ["uncategorized", "expense", "fee", "cogs"] as const

export function isSweepableRow(r: LocatableRow): boolean {
  if (!(r.amount < 0)) return false
  if (!PERIOD_SWEEPABLE_CATEGORIES.includes((r.category ?? "uncategorized") as (typeof PERIOD_SWEEPABLE_CATEGORIES)[number])) return false
  if ((r.notes ?? "").startsWith("manual:")) return false
  return true
}

/** Monday (UTC) of the row's week — a continuous timeline key, so the ISO
 *  year boundary can never produce a phantom week. */
function weekStart(dateIso: string): number {
  const d = new Date(`${dateIso}T00:00:00Z`)
  const day = d.getUTCDay() // 0 Sun … 6 Sat
  const diff = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diff)
  return d.getTime()
}

const WEEK_MS = 7 * 24 * 3600 * 1000

interface RawPeriod {
  loc: string
  startWeek: number
  endWeek: number
  activeWeeks: number
  rows: LocatableRow[]
}

/** Contiguous active-week runs for ONE location (gaps < PRESENCE_MAX_GAP_WEEKS merge). */
function runsForLocation(loc: string, rows: LocatableRow[]): RawPeriod[] {
  const byWeek = new Map<number, LocatableRow[]>()
  for (const r of rows) {
    const w = weekStart(r.transaction_date)
    const list = byWeek.get(w) ?? []
    list.push(r)
    byWeek.set(w, list)
  }
  const activeWeeks = Array.from(byWeek.entries())
    .filter(([, list]) => list.length >= PRESENCE_MIN_ROWS_PER_WEEK)
    .map(([w]) => w)
    .sort((a, b) => a - b)

  const runs: RawPeriod[] = []
  let cur: { start: number; end: number; count: number } | null = null
  for (const w of activeWeeks) {
    // (w - cur.end)/WEEK_MS is the week-index step; step-1 = inactive weeks between.
    if (cur && (w - cur.end) / WEEK_MS - 1 <= PRESENCE_MAX_GAP_WEEKS) {
      cur.end = w
      cur.count++
    } else {
      if (cur) runs.push(finishRun(loc, cur, byWeek))
      cur = { start: w, end: w, count: 1 }
    }
  }
  if (cur) runs.push(finishRun(loc, cur, byWeek))
  return runs.filter(r => r.activeWeeks >= PRESENCE_MIN_WEEKS)
}

function finishRun(loc: string, run: { start: number; end: number; count: number }, byWeek: Map<number, LocatableRow[]>): RawPeriod {
  const rows: LocatableRow[] = []
  for (const [w, list] of Array.from(byWeek.entries())) {
    if (w >= run.start && w <= run.end) rows.push(...list)
  }
  return { loc, startWeek: run.start, endWeek: run.end, activeWeeks: run.count, rows }
}

function overlapRatio(a: RawPeriod, b: RawPeriod): number {
  const start = Math.max(a.startWeek, b.startWeek)
  const end = Math.min(a.endWeek, b.endWeek)
  if (end < start) return 0
  const overlapWeeks = (end - start) / WEEK_MS + 1
  const shorter = Math.min((a.endWeek - a.startWeek) / WEEK_MS + 1, (b.endWeek - b.startWeek) / WEEK_MS + 1)
  return overlapWeeks / shorter
}

function toPeriod(locCodes: string[], primary: string, rows: LocatableRow[], activeWeeks: number): PresencePeriod {
  const dates = rows.map(r => r.transaction_date).sort()
  const sweepable = rows.filter(isSweepableRow)
  // Shared rowRootKey (cond. 12): group_keys are the LOWERCASED keys the
  // review's groups use — fixes the live bug where a capitalized merchant
  // label could never match its group key in the period filter chip.
  const merchants = new Map<string, { label: string; n: number }>()
  const groupKeys = new Set<string>()
  for (const r of rows) {
    const { key, label, source } = rowRootKey(r.description, r.counterparty)
    if (source === "none") continue
    const e = merchants.get(key) ?? { label, n: 0 }
    e.n++
    merchants.set(key, e)
    groupKeys.add(key)
  }
  return {
    loc_codes: locCodes,
    primary,
    start: dates[0],
    end: dates[dates.length - 1],
    // High = long + comfortably above the floor (avg ≥ floor+1 rows/week);
    // everything emitted is at least medium — below-floor runs never existed.
    confidence: activeWeeks >= PRESENCE_MIN_WEEKS + 1 && rows.length >= activeWeeks * (PRESENCE_MIN_ROWS_PER_WEEK + 1) ? "high" : "medium",
    row_count: rows.length,
    dollar_total: rows.reduce((s, r) => s + Math.abs(r.amount), 0),
    sweepable_count: sweepable.length,
    sweepable_total: sweepable.reduce((s, r) => s + Math.abs(r.amount), 0),
    top_merchants: Array.from(merchants.values()).sort((a, b) => b.n - a.n).slice(0, 5).map(m => m.label),
    group_keys: Array.from(groupKeys),
  }
}

/**
 * Detect presence periods across all located rows.
 * `residenceCountry` = the client's fiscal-residence ISO code from the CRM
 * (null = unknown → nothing suppressed; the caller shows a "no residence on
 * file" note instead).
 */
export function detectPresencePeriods(rows: LocatableRow[], residenceCountry: string | null): PresencePeriod[] {
  const located = rows.filter(r => r.loc_code && r.amount < 0)
  if (located.length === 0) return []

  const byLoc = new Map<string, LocatableRow[]>()
  for (const r of located) {
    const list = byLoc.get(r.loc_code as string) ?? []
    list.push(r)
    byLoc.set(r.loc_code as string, list)
  }

  let raw: RawPeriod[] = []
  for (const [loc, list] of Array.from(byLoc.entries())) {
    raw.push(...runsForLocation(loc, list))
  }

  // Residence suppression: the fiscal-residence country's periods are home
  // life, not trips; if residence is an EU member, 'EU' region periods are
  // indistinguishable from home and are suppressed too.
  if (residenceCountry) {
    raw = raw.filter(p => p.loc !== residenceCountry)
    if (EU_COUNTRIES.has(residenceCountry)) raw = raw.filter(p => !(REGION_TOKENS as readonly string[]).includes(p.loc))
  }
  if (raw.length === 0) return []

  // EU/country containment merge: each EU period merges into the overlapping
  // (≥ threshold) country period with the LARGEST overlap; an EU period stands
  // alone only when no country period overlaps it.
  const countryPeriods = raw.filter(p => !(REGION_TOKENS as readonly string[]).includes(p.loc))
  const regionPeriods = raw.filter(p => (REGION_TOKENS as readonly string[]).includes(p.loc))
  const consumedRegions = new Set<RawPeriod>()
  const out: PresencePeriod[] = []

  for (const cp of countryPeriods) {
    let bestRegion: RawPeriod | null = null
    let bestOverlap = 0
    for (const rp of regionPeriods) {
      if (consumedRegions.has(rp)) continue
      const o = overlapRatio(cp, rp)
      if (o >= PERIOD_MERGE_OVERLAP && o > bestOverlap) { bestRegion = rp; bestOverlap = o }
    }
    if (bestRegion) {
      consumedRegions.add(bestRegion)
      out.push(toPeriod([cp.loc, bestRegion.loc], cp.loc, [...cp.rows, ...bestRegion.rows], Math.max(cp.activeWeeks, bestRegion.activeWeeks)))
    } else {
      out.push(toPeriod([cp.loc], cp.loc, cp.rows, cp.activeWeeks))
    }
  }
  for (const rp of regionPeriods) {
    if (!consumedRegions.has(rp)) out.push(toPeriod([rp.loc], rp.loc, rp.rows, rp.activeWeeks))
  }

  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}
