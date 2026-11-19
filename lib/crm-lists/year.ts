/**
 * The "Invoice year" choice on the Accounts and Contacts lists.
 *
 * The year only decides which year's installment invoice the Paid / Pending / Overdue chip looks at. The amounts themselves are the
 * agreed contract amounts (one number per company) and never change with the year. Pure and client-safe.
 */

const MIN_YEAR = 2000
const MAX_YEAR = 2100

function validYear(y: unknown): y is number {
  return typeof y === 'number' && Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR
}

/** The years to offer: every year that has installment invoices, plus the current year, newest first. */
export function listYearOptions(yearsWithInvoices: (number | null | undefined)[], current: number): number[] {
  const set = new Set<number>()
  if (validYear(current)) set.add(current)
  for (const y of yearsWithInvoices) if (validYear(y)) set.add(y)
  return Array.from(set).sort((a, b) => b - a)
}

/** URL value -> a year from the offered list, else the current year. */
export function parseListYear(raw: string | string[] | undefined, options: number[], current: number): number {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  const n = /^\d{4}$/.test(v) ? Number(v) : NaN
  return options.includes(n) ? n : current
}
