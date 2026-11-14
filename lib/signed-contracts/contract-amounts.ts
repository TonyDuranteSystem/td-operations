/**
 * The installment amounts saved on a signed formation / onboarding contract (`contracts.annual_fee` and
 * `contracts.installments`, written by the signing page). Pure.
 *
 * Shown exactly as saved: the yearly figure is the saved `annual_fee`, NOT January + June, so a record whose
 * three values disagree is visible as it is.
 */
import { formatSavedNumber } from './amount-input'

/** a saved number with its currency symbol, never rounded */
const saved = (n: number, symbol: string) => `${symbol}${formatSavedNumber(n)}`

export interface SavedContractAmounts {
  january: number | null
  june: number | null
  /** the saved annual_fee text, as stored (null = nothing saved) */
  yearlyRaw: string | null
  /** installments could not be read as {"jan":n,"jun":n} */
  unreadable: boolean
}

export function readContractAmounts(annualFee: string | null | undefined, installments: unknown): SavedContractAmounts {
  let january: number | null = null
  let june: number | null = null
  let unreadable = false
  if (installments != null && installments !== '') {
    try {
      const parsed = typeof installments === 'string' ? JSON.parse(installments) : installments
      const jan = (parsed as { jan?: unknown })?.jan
      const jun = (parsed as { jun?: unknown })?.jun
      if (typeof jan === 'number' && Number.isFinite(jan)) january = jan
      else unreadable = true
      if (typeof jun === 'number' && Number.isFinite(jun)) june = jun
      else unreadable = true
    } catch {
      unreadable = true
    }
  }
  const yearlyRaw = typeof annualFee === 'string' && annualFee.trim() !== '' ? annualFee.trim() : null
  return { january, june, yearlyRaw, unreadable }
}

export interface AmountsDisplay {
  january: string
  june: string
  /** null when the contract holds no yearly figure */
  yearly: string | null
}

const NOTHING = 'nothing saved'

export function displayContractAmounts(record: SavedContractAmounts, symbol: string): AmountsDisplay {
  const yearlyNumber = record.yearlyRaw != null && /^\d+(\.\d+)?$/.test(record.yearlyRaw) ? Number(record.yearlyRaw) : null
  return {
    january: record.january != null ? saved(record.january, symbol) : NOTHING,
    june: record.june != null ? saved(record.june, symbol) : NOTHING,
    yearly:
      record.yearlyRaw == null
        ? null
        : yearlyNumber != null
          ? saved(yearlyNumber, symbol)
          : record.yearlyRaw, // not a number: shown as it is
  }
}

/** What an Edit writes: installments in the exact shape the signing page writes, and the yearly fee as their sum. */
export function buildContractUpdate(january: number, june: number): { annual_fee: string; installments: string } {
  const sum = Math.round((january + june) * 100) / 100
  return {
    annual_fee: String(sum),
    installments: JSON.stringify({ jan: january, jun: june }),
  }
}
