/**
 * Reading an amount a person types ("1,250" or "1.250" or "$ 1 250,00") and showing it back.
 * Pure and client-safe: the edit form shows "Read as: …" with this same function before anything is saved,
 * and the server runs it again on Save. Never throws.
 *
 * The rule that makes both styles work: a separator followed by EXACTLY three digits (with 1-3 digits before it)
 * is a thousands separator ("1.250" and "1,250" are both one thousand two hundred fifty); one or two digits after
 * the separator is a decimal ("12.5", "1250,50"). Anything else is refused rather than guessed.
 */

export const MAX_AMOUNT = 1_000_000

export type AmountParse =
  | { kind: 'ok'; value: number; readAs: string }
  | { kind: 'refused'; error: string }

const round2 = (n: number) => Math.round(n * 100) / 100

/** 1250 -> "1,250", 1250.5 -> "1,250.50" (money with cents always shows both digits). No currency symbol. */
export function formatNumber(n: number): string {
  const r = round2(n)
  return r.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })
}

/**
 * A number that is SAVED, shown as it is: thousands separators added, but never rounded (a saved 2.5001 stays 2.5001, so a
 * wrong value is visible instead of being tidied into a plausible one).
 */
export function formatSavedNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

/** 1250, "$" -> "$1,250". An unknown currency shows the bare number, never a guessed symbol. */
export function formatAmount(n: number, symbol = ''): string {
  return `${symbol}${formatNumber(n)}`
}

function refused(error: string): AmountParse {
  return { kind: 'refused', error }
}

export function parseAmountInput(raw: unknown): AmountParse {
  if (typeof raw !== 'string') return refused('Type an amount.')
  // currency words and symbols, spaces of every kind, apostrophes used as thousands marks
  let s = raw
    .replace(/usd|eur|dollars?|euros?/gi, '')
    .replace(/[$€£\s  '’]/g, '')
  if (s === '') return refused('Type an amount.')
  if (s.startsWith('-')) return refused('An amount cannot be negative.')
  if (s.startsWith('+')) s = s.slice(1)
  if (!/^[0-9.,]+$/.test(s)) return refused('Use digits only, for example 1,250 or 1.250.')
  if (!/[0-9]/.test(s)) return refused('Type an amount.')

  const hasDot = s.includes('.')
  const hasComma = s.includes(',')
  let integerPart: string
  let fraction = ''

  if (hasDot && hasComma) {
    // the separator that comes LAST is the decimal one; the other one groups thousands
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','
    const thousandsSep = decimalSep === '.' ? ',' : '.'
    const at = s.lastIndexOf(decimalSep)
    integerPart = s.slice(0, at)
    fraction = s.slice(at + 1)
    if (integerPart.includes(decimalSep)) return refused('Could not read this amount. Try 1250 or 1,250.')
    if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(integerPart)) {
      return refused('Could not read this amount. Try 1250 or 1,250.')
    }
    integerPart = integerPart.split(thousandsSep).join('')
    if (!/^\d{1,2}$/.test(fraction)) return refused('Could not read this amount. Try 1250 or 1,250.')
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ','
    const parts = s.split(sep)
    if (parts.some((p) => p === '')) return refused('Could not read this amount. Try 1250 or 1,250.')
    if (parts.length > 2) {
      // several separators: they must all be thousands separators (1.250.000)
      const [head, ...rest] = parts
      if (head.length < 1 || head.length > 3 || rest.some((p) => p.length !== 3)) {
        return refused('Could not read this amount. Try 1250 or 1,250.')
      }
      integerPart = parts.join('')
    } else {
      const [before, after] = parts
      if (after.length === 3 && before.length >= 1 && before.length <= 3) {
        integerPart = before + after // 1.250 / 1,250 = one thousand two hundred fifty
      } else if (after.length >= 1 && after.length <= 2) {
        integerPart = before
        fraction = after // 12.5 / 1250,50
      } else {
        return refused('Could not read this amount. Try 1250 or 1,250.')
      }
    }
  } else {
    integerPart = s
  }

  const value = round2(Number(fraction ? `${integerPart}.${fraction}` : integerPart))
  if (!Number.isFinite(value)) return refused('Could not read this amount.')
  if (value > MAX_AMOUNT) return refused(`Amounts above ${formatNumber(MAX_AMOUNT)} are not accepted here.`)
  return { kind: 'ok', value, readAs: formatNumber(value) }
}
