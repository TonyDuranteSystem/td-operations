/**
 * The tax YEAR a Tax Return line of an offer is for (dev job 0a60f416, part B).
 *
 * Before: nothing on an offer said which year a Tax Return was for. Activation hard-coded "this year minus one", the intake step hard-coded
 * "this year", and the service delivery was named "Tax Return - <company>" — so a return sold for 2026 was tracked as 2025 (an already-filed one).
 *
 * Now the year lives where staff already write it — in the NAME of the line ("Tax Return 2026") — and the repo's own reader of a service
 * delivery's year (`taxYearFromServiceName`, lib/flows/resolve-flows.ts) reads the delivery's name "Tax Return 2026 - <company>". One carrier, no
 * new column, nothing hard-coded: a line without a year behaves exactly as before.
 *
 * Pure: no database, client-safe (the offer builder imports it too).
 */
import { findTaxReturnService } from '@/lib/tax-return-context'

/** The year written in a Tax Return line's name: "Tax Return 2026", "Solo Tax Return 2025". Anchored on the words "Tax Return" so a year elsewhere in a name is never read. */
export function taxYearFromLineName(name: unknown): number | null {
  const m = /tax return\s+(20\d{2})(?!\d)/i.exec(typeof name === 'string' ? name : '')
  return m ? Number(m[1]) : null
}

/** "Tax Return" + 2026 → "Tax Return 2026". A name that already carries a year gets the new one instead (never "Tax Return 2025 2026"). */
export function lineNameWithYear(baseName: string, year: number): string {
  const stripped = baseName.replace(/\s*\b20\d{2}\b\s*$/, '').trim()
  return `${stripped || 'Tax Return'} ${year}`
}

export interface OfferTaxYear {
  /** the year the single Tax Return line states, or null (no Tax Return line, several, or none with a year) */
  year: number | null
  /** how many lines look like a Tax Return — more than one is refused at creation and blocked at activation */
  lineCount: number
}

/** The Tax Return line of an offer and the year it states. Uses the same finder as activation and the confirm-payment check. */
export function taxYearOfOffer(services: unknown): OfferTaxYear {
  const list = Array.isArray(services) ? (services as Array<Record<string, unknown>>) : []
  const found = findTaxReturnService(list)
  if (found.status === 'not_found') return { year: null, lineCount: 0 }
  if (found.status === 'multiple_matches') return { year: null, lineCount: found.count }
  return { year: taxYearFromLineName(found.entry.name), lineCount: 1 }
}

/** What the activation records as the Tax Return service delivery's name: the year goes in when the offer states one. */
export function taxReturnServiceName(clientName: string, year: number | null): string {
  return year ? `Tax Return ${year} - ${clientName}` : `Tax Return - ${clientName}`
}

/**
 * Is this year one a company can have a tax return for? An integer, not before the company existed (when its formation year is known) and not
 * after the current year. null = fine; otherwise a plain-English sentence for the person who typed it.
 */
export function taxYearProblem(year: number, opts: { formationYear?: number | null; currentYear: number }): string | null {
  if (!Number.isInteger(year) || year < 2000) return `"${year}" is not a tax year.`
  if (year > opts.currentYear) return `Tax year ${year} has not started yet (this is ${opts.currentYear}).`
  if (opts.formationYear && year < opts.formationYear) return `The company was formed in ${opts.formationYear}, so it had no tax return for ${year}.`
  return null
}
