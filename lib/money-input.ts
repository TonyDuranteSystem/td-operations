/**
 * Money input parsing — one shared, pure rule for every client-typed amount
 * (dev job 89195c68, 2026-09-29).
 *
 * Why this exists: the tax wizard used a native <input type="number"> +
 * Number(raw), so an Italian-format "80.000" (eighty thousand) was saved as
 * 80. The typed text was never kept, so the damage could not be repaired
 * automatically. The rule now is: never guess. A value that is genuinely
 * ambiguous ("80.000" = 80,000 or 80.00?) is reported as `ambiguous` and the
 * UI ASKS the client which one they meant (Antonio's direction: teach the
 * client US format instead of silently interpreting it).
 *
 * Separator rules (after stripping the field's own currency symbol/code,
 * whitespace used as a thousands separator, and the sign):
 *  - digits only                       → ok
 *  - both "." and ","                  → the LAST one is the decimal mark
 *                                         (≤ maxDecimals digits), the other is
 *                                         a thousands separator (rule G)
 *  - commas only                       → valid grouping (rule G) = thousands;
 *                                         a single comma + 1–2 digits = decimal
 *  - dots only                         → several dots with valid grouping =
 *                                         thousands; a single dot + 1–2 digits
 *                                         = decimal; a single dot + exactly 3
 *                                         digits with a valid leading group is
 *                                         AMBIGUOUS when the cents reading is
 *                                         itself valid (third digit 0, e.g.
 *                                         "80.000", "1.500"), and otherwise can
 *                                         only be thousands ("10.596")
 *  - anything else                     → invalid
 * Rule G (thousands grouping): leading group 1–3 digits with no leading zero,
 * then groups of exactly 3 digits.
 *
 * Decimals are always counted on the STRING, never with float math
 * (17.65 * 100 = 1764.9999999999998).
 */

export type MoneyCurrency = 'USD' | 'EUR'

export interface MoneyParseOptions {
  allowNegative?: boolean
  currency?: MoneyCurrency
  maxDecimals?: number
  max?: number
}

export type MoneyInvalidReason =
  | 'unreadable'
  | 'too_many_decimals'
  | 'negative'
  | 'too_large'
  | 'wrong_currency'

export type MoneyParseResult =
  | { kind: 'empty' }
  | {
      kind: 'ok'
      value: number
      /** True when the input was not already plain US format (a dot used for
       *  thousands, a comma for decimals, spaces as separators) — the UI then
       *  shows the "Saved as …" line so the client sees how it was read. */
      normalized: boolean
    }
  | { kind: 'ambiguous'; asThousands: number; asDecimal: number }
  | { kind: 'invalid'; reason: MoneyInvalidReason }

const DEFAULTS: Required<MoneyParseOptions> = {
  allowNegative: false,
  currency: 'USD',
  maxDecimals: 2,
  max: 1e13,
}

// Currency tokens, longest first so "US$" is consumed before "$".
const CURRENCY_TOKENS: Record<MoneyCurrency, string[]> = {
  USD: ['US$', 'USD', '$'],
  EUR: ['EUR', '€'],
}
const ALL_CURRENCY_TOKENS = ['US$', 'USD', 'EUR', 'GBP', 'CHF', '$', '€', '£', '¥']

const GROUPED = (sep: '.' | ',') =>
  new RegExp(`^[1-9]\\d{0,2}(\\${sep}\\d{3})+$`)

function withDecimals(intDigits: string, decDigits: string): number {
  const i = intDigits === '' ? '0' : intDigits
  return decDigits ? Number(`${i}.${decDigits}`) : Number(i)
}

/**
 * Parse what a client typed into a money box.
 */
export function parseMoneyInput(text: string, options: MoneyParseOptions = {}): MoneyParseResult {
  const opts = { ...DEFAULTS, ...options }
  let s = String(text ?? '')
    // every flavour of space (NBSP, narrow NBSP, thin space) → plain space
    .replace(/[\s   ]+/g, ' ')
    .replace(/−/g, '-') // Unicode minus → ASCII
    .trim()
  if (s === '') return { kind: 'empty' }

  // ── Currency: the field's own symbol/code may appear once, anywhere around
  // the number; any other currency marker is refused (never silently accept
  // "€80.000" in a dollar field).
  const own = CURRENCY_TOKENS[opts.currency]
  let ownFound = 0
  for (const tok of own) {
    while (s.toUpperCase().includes(tok)) {
      const idx = s.toUpperCase().indexOf(tok)
      s = s.slice(0, idx) + ' ' + s.slice(idx + tok.length)
      ownFound++
    }
  }
  if (ownFound > 1) return { kind: 'invalid', reason: 'unreadable' }
  for (const tok of ALL_CURRENCY_TOKENS) {
    if (s.toUpperCase().includes(tok)) return { kind: 'invalid', reason: 'wrong_currency' }
  }
  s = s.replace(/ +/g, ' ').trim()

  // ── Sign: one leading or trailing minus, OR accounting parentheses. Any
  // combination of two sign markers is refused.
  let negative = false
  let signMarkers = 0
  if (/^\(.*\)$/.test(s)) {
    negative = true
    signMarkers++
    s = s.slice(1, -1).trim()
  }
  if (s.startsWith('-')) {
    negative = true
    signMarkers++
    s = s.slice(1).trim()
  }
  if (s.endsWith('-')) {
    negative = true
    signMarkers++
    s = s.slice(0, -1).trim()
  }
  if (signMarkers > 1) return { kind: 'invalid', reason: 'unreadable' }
  if (s === '' || /[()\-+]/.test(s)) return { kind: 'invalid', reason: 'unreadable' }

  // ── Spaces are only allowed as a thousands separator ("80 000", "1 234,56").
  let spaceGrouped = false
  if (s.includes(' ')) {
    const m = /^([1-9]\d{0,2}(?: \d{3})+)([.,]\d{1,})?$/.exec(s)
    if (!m) return { kind: 'invalid', reason: 'unreadable' }
    s = m[1].replace(/ /g, '') + (m[2] ?? '')
    spaceGrouped = true
  }

  if (!/^[\d.,]+$/.test(s)) return { kind: 'invalid', reason: 'unreadable' }

  const finish = (value: number, normalized: boolean): MoneyParseResult => {
    const signed = negative ? -value : value
    if (signed < 0 && !opts.allowNegative) return { kind: 'invalid', reason: 'negative' }
    if (Math.abs(signed) > opts.max) return { kind: 'invalid', reason: 'too_large' }
    return { kind: 'ok', value: signed === 0 ? 0 : signed, normalized: normalized || spaceGrouped }
  }

  const hasDot = s.includes('.')
  const hasComma = s.includes(',')

  // digits only
  if (!hasDot && !hasComma) return finish(Number(s), false)

  // both separators: the last one is the decimal mark
  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf('.')
    const lastComma = s.lastIndexOf(',')
    const decSep = lastDot > lastComma ? '.' : ','
    const thouSep = decSep === '.' ? ',' : '.'
    const decIdx = s.lastIndexOf(decSep)
    const intPart = s.slice(0, decIdx)
    const decPart = s.slice(decIdx + 1)
    if (intPart.includes(decSep)) return { kind: 'invalid', reason: 'unreadable' }
    if (!/^\d+$/.test(decPart)) return { kind: 'invalid', reason: 'unreadable' }
    if (!GROUPED(thouSep).test(intPart)) return { kind: 'invalid', reason: 'unreadable' }
    if (decPart.length > opts.maxDecimals) return { kind: 'invalid', reason: 'too_many_decimals' }
    return finish(withDecimals(intPart.split(thouSep).join(''), decPart), decSep === ',')
  }

  const sep = hasDot ? '.' : ','
  const parts = s.split(sep)

  // several of the same separator: only valid as thousands grouping
  if (parts.length > 2) {
    if (!GROUPED(sep).test(s)) return { kind: 'invalid', reason: 'unreadable' }
    return finish(Number(parts.join('')), sep === '.')
  }

  const [intPart, decPart] = parts
  if (!/^\d*$/.test(intPart) || !/^\d+$/.test(decPart)) return { kind: 'invalid', reason: 'unreadable' }

  if (sep === ',') {
    // "80,000" — US thousands
    if (GROUPED(',').test(s)) return finish(Number(intPart + decPart), false)
    // "80,5" / "80,50" — decimal comma
    if (decPart.length <= Math.min(2, opts.maxDecimals) && intPart !== '') {
      return finish(withDecimals(intPart, decPart), true)
    }
    return { kind: 'invalid', reason: decPart.length > opts.maxDecimals ? 'too_many_decimals' : 'unreadable' }
  }

  // single dot
  if (decPart.length <= opts.maxDecimals) return finish(withDecimals(intPart, decPart), false)
  if (decPart.length === 3 && GROUPED('.').test(s)) {
    const asThousands = Number(intPart + decPart)
    if (decPart.endsWith('0')) {
      const asDecimal = withDecimals(intPart, decPart.slice(0, 2))
      const signedT = negative ? -asThousands : asThousands
      const signedD = negative ? -asDecimal : asDecimal
      if ((signedT < 0 || signedD < 0) && !opts.allowNegative) return { kind: 'invalid', reason: 'negative' }
      if (Math.abs(signedT) > opts.max) return finish(asDecimal, false)
      return { kind: 'ambiguous', asThousands: signedT, asDecimal: signedD }
    }
    // "10.596" can't be cents (3 decimals) → only the thousands reading is valid
    return finish(asThousands, true)
  }
  return { kind: 'invalid', reason: 'too_many_decimals' }
}

/** Number of decimal places of a stored number, counted on its string form. */
export function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return Infinity
  const str = String(n)
  if (/e/i.test(str)) {
    // 1e-7 etc. — tiny values: compute from the exponent
    const m = /e-(\d+)$/i.exec(str)
    if (!m) return 0
    const mantissaDec = (str.split('e')[0].split('.')[1] ?? '').length
    return Number(m[1]) + mantissaDec
  }
  return (str.split('.')[1] ?? '').length
}

export type StoredMoneyProblem = 'not_a_number' | 'unanswered' | 'too_many_decimals' | 'negative'

/**
 * Check a value already sitting in form data for a money field. Used by the
 * wizard step gate AND the server backstop so both apply the same rule:
 *  - '' / null / undefined → fine (presence is the required check's job)
 *  - a number → at most maxDecimals decimals, and not negative unless allowed
 *  - a string → the client typed something that is not a settled amount yet
 *    (ambiguous or unreadable); a string that parses cleanly is fine here, the
 *    caller converts it with `coerceMoneyValue`
 */
export function checkStoredMoney(
  value: unknown,
  options: MoneyParseOptions = {},
): StoredMoneyProblem | null {
  const opts = { ...DEFAULTS, ...options }
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'not_a_number'
    if (value < 0 && !opts.allowNegative) return 'negative'
    if (decimalPlaces(value) > opts.maxDecimals) return 'too_many_decimals'
    return null
  }
  if (typeof value === 'string') {
    const r = parseMoneyInput(value, opts)
    if (r.kind === 'ok' || r.kind === 'empty') return null
    if (r.kind === 'invalid' && r.reason === 'negative') return 'negative'
    if (r.kind === 'invalid' && r.reason === 'too_many_decimals') return 'too_many_decimals'
    return 'unanswered'
  }
  return 'not_a_number'
}

/**
 * A stored string that parses cleanly becomes a number (e.g. a legacy "5000");
 * everything else is returned unchanged. Lets client and server agree that a
 * settled money value is always a number.
 */
export function coerceMoneyValue(value: unknown, options: MoneyParseOptions = {}): unknown {
  if (typeof value !== 'string') return value
  const r = parseMoneyInput(value, options)
  if (r.kind === 'ok') return r.value
  if (r.kind === 'empty') return ''
  return value
}

/** US formatting for the box text — pinned to en-US, NO currency symbol (the
 *  symbol is a separate prefix label, so a "€" box never contains "$"). */
export function formatMoneyUS(n: number, options: { keepAllDecimals?: boolean } = {}): string {
  if (options.keepAllDecimals) {
    const [i, d] = String(Math.abs(n)).split('.')
    const grouped = Number(i).toLocaleString('en-US')
    return `${n < 0 ? '-' : ''}${grouped}${d ? '.' + d : ''}`
  }
  const hasCents = Math.round(Math.abs(n) * 100) % 100 !== 0
  return n.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

/** "$80,000.00" / "€1,500.00" — for PDFs and the saved-as line. */
export function formatMoneyWithSymbol(n: number, currency: MoneyCurrency = 'USD'): string {
  const sym = currency === 'EUR' ? '€' : '$'
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : ''}${sym}${body}`
}

/** The same amount written the Italian way: "80.000" / "1,50" / "1.234,56". */
export function formatMoneyItalian(n: number, options: { cents?: boolean } = {}): string {
  // Built by hand: Intl's it-IT skips grouping on 4-digit numbers ("1500"),
  // which is exactly the case the client needs to recognise ("1.500").
  const totalCents = Math.round(Math.abs(n) * 100)
  const whole = Math.floor(totalCents / 100)
  const cents = totalCents % 100
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const showCents = cents !== 0 || options.cents
  return `${n < 0 ? '-' : ''}${grouped}${showCents ? ',' + String(cents).padStart(2, '0') : ''}`
}

// ─── Amount in words (EN / IT) ──────────────────────────────────────────────

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function enUnder1000(n: number): string {
  const parts: string[] = []
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h) parts.push(`${EN_ONES[h]} hundred`)
  if (r) {
    if (r < 20) parts.push(EN_ONES[r])
    else parts.push(EN_TENS[Math.floor(r / 10)] + (r % 10 ? `-${EN_ONES[r % 10]}` : ''))
  }
  return parts.join(' ')
}

function enUnder10000(n: number): string {
  if (n === 0) return 'zero'
  const th = Math.floor(n / 1000)
  const r = n % 1000
  return [th ? `${EN_ONES[th]} thousand` : '', r ? enUnder1000(r) : ''].filter(Boolean).join(' ')
}

const IT_ONES = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci',
  'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove']
const IT_TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta']

function itUnder100(n: number): string {
  if (n < 20) return IT_ONES[n]
  const t = IT_TENS[Math.floor(n / 10)]
  const u = n % 10
  if (u === 0) return t
  const stem = u === 1 || u === 8 ? t.slice(0, -1) : t
  return stem + (u === 3 ? 'tré' : IT_ONES[u])
}

function itUnder1000(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  let head = h === 0 ? '' : h === 1 ? 'cento' : `${IT_ONES[h]}cento`
  if (head && r >= 80 && r < 90) head = head.slice(0, -1) // centottanta
  return head + (r ? itUnder100(r) : '')
}

function itUnder10000(n: number): string {
  if (n === 0) return 'zero'
  const th = Math.floor(n / 1000)
  const r = n % 1000
  const head = th === 0 ? '' : th === 1 ? 'mille' : `${IT_ONES[th]}mila`
  return head + (r ? itUnder1000(r) : '')
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/**
 * Amount in plain words so the client never has to decode a notation they
 * just misread: "80 thousand dollars", "one thousand five hundred dollars",
 * "1 dollar and 50 cents" / IT equivalents. Returns null when no short,
 * natural wording exists (then the UI shows only the figures).
 */
export function amountInWords(n: number, lang: 'en' | 'it', currency: MoneyCurrency = 'USD'): string | null {
  if (!Number.isFinite(n) || n < 0) return null
  const cents = Math.round(n * 100) % 100
  const whole = Math.floor(Math.round(n * 100) / 100)
  const unitOne = currency === 'EUR' ? (lang === 'it' ? 'euro' : 'euro') : lang === 'it' ? 'dollaro' : 'dollar'
  const unitMany = currency === 'EUR' ? (lang === 'it' ? 'euro' : 'euros') : lang === 'it' ? 'dollari' : 'dollars'

  if (cents !== 0) {
    if (whole >= 10000) return null
    const centWord = lang === 'it' ? (cents === 1 ? 'centesimo' : 'centesimi') : cents === 1 ? 'cent' : 'cents'
    const joiner = lang === 'it' ? 'e' : 'and'
    return `${whole} ${whole === 1 ? unitOne : unitMany} ${joiner} ${cents} ${centWord}`
  }

  if (whole === 1) return `1 ${unitOne}`
  if (whole < 1000) return `${whole} ${unitMany}`
  if (whole < 10000) {
    return `${capitalize(lang === 'it' ? itUnder10000(whole) : enUnder10000(whole))} ${unitMany}`
  }
  if (whole % 1_000_000 === 0) {
    const m = whole / 1_000_000
    if (lang === 'it') return `${m} ${m === 1 ? 'milione' : 'milioni'} di ${unitMany}`
    return `${m} million ${unitMany}`
  }
  if (whole % 1000 === 0 && whole < 1_000_000) {
    return `${whole / 1000} ${lang === 'it' ? 'mila' : 'thousand'} ${unitMany}`
  }
  return null
}

/**
 * The text a money box shows for a value already in form data: a number is
 * written the US way (every decimal kept when there are more than 2, so a
 * legacy 10.596 is shown as-is and never silently rounded to "10.60"); a
 * pending string is shown exactly as the client typed it.
 */
export function boxTextForValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    return formatMoneyUS(value, { keepAllDecimals: decimalPlaces(value) > 2 })
  }
  return String(value)
}
