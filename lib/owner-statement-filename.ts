/**
 * Statement filename → account identity, for the owner's own books.
 *
 * WHY THIS EXISTS (Antonio, 2026-08-30): "if the rules will be that the file name
 * must contain institution name, the type of account checking/credit card/saving/
 * loan, acc number in order the transactions to be treated properly, do it. if a
 * file is missing a proper wording the system has to give a message to rename it."
 *
 * The account TYPE is not cosmetic — it decides the accounting:
 *   - checking / savings : real cash. Balances are cash; spending is expense.
 *   - credit_card        : a LIABILITY. Charges are the expense; paying the card
 *                          from a bank is a TRANSFER, never an expense — counting
 *                          both double-counts every purchase. A card balance is
 *                          money owed and must never be added into cash.
 *   - loan               : a LIABILITY. Only the INTEREST is an expense; the
 *                          principal portion of a payment repays debt.
 *   - processor          : a clearing account (Stripe). Payouts to a bank are
 *                          transfers, not income — income comes from the invoice
 *                          ledger.
 *
 * It also decides IDENTITY. Three First Citizens accounts (checking 5812,
 * checking 5820, loan 7363) pass the same $1,068.30 between them; without the
 * account number they collapse into one and the duplicate check eats real rows.
 * That already happened: a bank payment to Amex and the card's own record of it
 * merged because both were labelled "unknown".
 *
 * DELIBERATELY REFUSES rather than guesses. A wrong account silently mis-states
 * money; an annoying error message costs a rename.
 */

export type OwnerAccountType = "checking" | "savings" | "credit_card" | "loan" | "processor"

export const OWNER_ACCOUNT_TYPES: OwnerAccountType[] = [
  "checking",
  "savings",
  "credit_card",
  "loan",
  "processor",
]

export interface ParsedStatementName {
  institution: string
  accountType: OwnerAccountType
  accountNumber: string
  /** Display/grouping label, e.g. "Chase checking 3920". This is what lands in
   *  bank_name, and what Cash Position groups balances by — so it is per-ACCOUNT,
   *  not per-institution. */
  label: string
}

export interface StatementNameProblem {
  /** What is missing or ambiguous, in the operator's terms. */
  problem: string
  /** Exactly how to rename the file. */
  suggestion: string
}

/**
 * Exactly one of `value` / `error` is set, keyed by `ok`.
 *
 * Written as ONE interface rather than a discriminated union deliberately: this
 * project compiles with `strict: false`, under which narrowing a union on a
 * boolean discriminant does not work, and the union form fails to typecheck at
 * every call site. Changing the project's tsconfig to suit one module would be a
 * far larger change than this.
 */
export interface StatementNameResult {
  ok: boolean
  value?: ParsedStatementName
  error?: StatementNameProblem
}

/**
 * Type keywords. Multi-word forms are tested FIRST: "credit card" must win before
 * anything could match on a bare word. A bare "card" is deliberately NOT a type
 * keyword — it appears as the number marker ("card#51007"), and treating it as a
 * type would silently classify a checking export as a credit card.
 */
const TYPE_PATTERNS: [RegExp, OwnerAccountType][] = [
  [/credit[\s._-]*cards?/i, "credit_card"],
  [/\bchecking\b|\bchequing\b/i, "checking"],
  [/\bsavings?\b/i, "savings"],
  [/\bloans?\b/i, "loan"],
  [/\bprocessor\b|\bmerchant\b/i, "processor"],
]

/** Strip the extension and the noise banks append (activity dumps, date ranges). */
function baseName(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]+$/, "")
}

/**
 * Underscores → spaces before word-boundary matching.
 *
 * NOT cosmetic: in JavaScript "_" is a WORD character, so /\bchecking\b/ does NOT
 * match "Firstcitizenbank_checking_acc" — there is no boundary between "_" and "c".
 * Caught by running this against Antonio's real filenames, where it refused files
 * that plainly stated their type. Underscore is the separator banks use most.
 */
function forWordMatch(fileName: string): string {
  return baseName(fileName).replace(/_+/g, " ")
}

/**
 * A 4-digit run in the range 2000–2099 is a YEAR, not an account. Antonio's files
 * are full of them ("2025 Stripe", "Amex_Credit_Card_2025_card#51007"), and taking
 * one as the account number would file a whole year of transactions under account
 * "2025".
 */
function looksLikeYear(digits: string): boolean {
  return digits.length === 4 && Number(digits) >= 2000 && Number(digits) <= 2099
}

export function detectAccountType(fileName: string): OwnerAccountType | null {
  const base = forWordMatch(fileName)
  for (const [re, type] of TYPE_PATTERNS) {
    if (re.test(base)) return type
  }
  return null
}

/**
 * Find the account number.
 *
 * Prefers an explicit marker (acc#, acct#, account#, card#, or a bare #) because
 * that is unambiguous. Falls back to digits fused to a word ("Chase3920").
 *
 * Returns "ambiguous" when a marked run is too long to be an account number —
 * e.g. "acc#45172025" (account 4517 immediately followed by the year 2025). That
 * MUST NOT be silently truncated: guessing between 4517 and 45172025 is guessing
 * which account the money belongs to.
 */
/** Collect capture-group 1 of every match. `exec` loop, not `matchAll`: this
 *  project sets no TS target, so iterating a `matchAll` iterator does not compile. */
function allCaptures(source: string, re: RegExp): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  while ((m = rx.exec(source)) !== null) {
    out.push(m[1])
    if (m.index === rx.lastIndex) rx.lastIndex++ // zero-length match guard
  }
  return out
}

/**
 * Currency codes accepted as an ACCOUNT IDENTIFIER.
 *
 * A multi-currency provider (Airwallex, Wise) does not give each wallet an account
 * number — the currency IS the identity, and its own export carries no number
 * anywhere (verified against Antonio's 2025 Airwallex activity report: 20 columns,
 * none of them an account id). Refusing those files would mean refusing a real
 * account for lacking something it does not have, so a currency code is a valid
 * identifier — but ONLY a recognised one, so a random three-letter word in a
 * filename can never be mistaken for an account.
 */
const CURRENCY_IDENTIFIERS = new Set([
  "USD", "EUR", "GBP", "CHF", "DKK", "SEK", "NOK", "PLN", "CZK",
  "CAD", "AUD", "NZD", "JPY", "CNY", "HKD", "SGD", "AED", "MXN", "BRL", "INR",
])

export function detectCurrencyIdentifier(fileName: string): string | null {
  for (const raw of forWordMatch(fileName).split(/[^A-Za-z]+/)) {
    const up = raw.trim().toUpperCase()
    if (up.length === 3 && CURRENCY_IDENTIFIERS.has(up)) return up
  }
  return null
}

export function detectAccountNumber(fileName: string): { value?: string; ambiguous?: string } | null {
  const base = baseName(fileName)

  // Collect EVERY marked candidate and keep looking past the bad ones. A single
  // first-match would stop on the "Card 2025" in "Amex_Credit_Card_2025_card#51007"
  // and call the file ambiguous, never reaching the real "card#51007". Caught by
  // running this against Antonio's actual filenames.
  const marked = allCaptures(base, /(?:acc(?:oun)?t?|card)\s*[#:._\-\s]?\s*(\d{3,})/gi)
    .concat(allCaptures(base, /#\s*(\d{3,})/g))

  const good = marked.find(d => d.length <= 6 && !looksLikeYear(d))
  if (good) return { value: good }

  // Only marked candidates that are too long to BE an account number are worth
  // reporting as ambiguous — "acc#45172025" is account 4517 with the year fused
  // on, and choosing between 4517 and 45172025 is choosing whose money this is.
  const overlong = marked.find(d => d.length > 6)
  if (overlong) return { ambiguous: overlong }

  // Digits fused to a word, e.g. "Chase3920". Skip bare years.
  const fused = allCaptures(base, /[A-Za-z]+(\d{3,6})/g).find(d => !looksLikeYear(d))
  if (fused) return { value: fused }

  // Last resort: a standalone 3–6 digit run, e.g. "Chase_checking_3920".
  // Without this the RECOMMENDED convention itself fails to parse — caught by a
  // test asserting the exact format this module tells operators to use. Years and
  // long runs (dates like 20260829) are excluded above and by the length bound.
  const standalone = allCaptures(base, /(?:^|[^0-9A-Za-z])(\d{3,6})(?:[^0-9]|$)/g).find(d => !looksLikeYear(d))
  if (standalone) return { value: standalone }

  return null
}

/**
 * The institution: the first alphabetic word that is not a type keyword, a month
 * name, or a bare filler token. Deliberately simple — the operator controls the
 * filename, and a wrong guess here is visible in the label rather than silent.
 */
export function detectInstitution(fileName: string): string | null {
  const base = forWordMatch(fileName)
  const STOP = new Set([
    "credit", "card", "cards", "checking", "chequing", "saving", "savings", "loan",
    "loans", "processor", "merchant", "activity", "statement", "statements",
    "transaction", "transactions", "report", "balance", "acc", "acct", "account",
    "final", "documents", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug",
    "sep", "sept", "oct", "nov", "dec", "to", "from", "and", "the",
  ])
  for (const raw of base.split(/[^A-Za-z]+/)) {
    const w = raw.trim()
    if (w.length < 3) continue
    if (STOP.has(w.toLowerCase())) continue
    return w
  }
  return null
}

const TYPE_LABEL: Record<OwnerAccountType, string> = {
  checking: "checking",
  savings: "savings",
  credit_card: "credit card",
  loan: "loan",
  processor: "processor",
}

export function parseStatementFilename(fileName: string): StatementNameResult {
  const institution = detectInstitution(fileName)
  const accountType = detectAccountType(fileName)
  const number = detectAccountNumber(fileName)

  // A recognised currency code stands in for an account number, but ONLY when there
  // is no number — a real number always wins, so a file naming both is unaffected.
  const currency = number ? null : detectCurrencyIdentifier(fileName)

  const missing: string[] = []
  if (!institution) missing.push("the bank or provider name")
  if (!accountType) missing.push("the account type (checking, savings, credit card, loan or processor)")
  if (!number && !currency) missing.push("the account or card number (or a currency code for a multi-currency wallet)")

  if (number && number.ambiguous) {
    return {
      ok: false,
      error: {
        problem: `The account number in "${fileName}" is unclear — "${number.ambiguous}" is too long to be an account number, so it probably has a date stuck to it.`,
        suggestion: `Separate the number from everything else, e.g. "Mercury_checking_4517_2025.csv". Which account the money belongs to is not something this should guess.`,
      },
    }
  }

  if (missing.length > 0 || !institution || !accountType || (!number && !currency)) {
    return {
      ok: false,
      error: {
        problem: `"${fileName}" is missing ${missing.join(", and ")}.`,
        suggestion: `Rename it as bank_type_number, for example "Chase_checking_3920.csv", "Amex_credit_card_51007.csv" or "FirstCitizens_loan_7363.csv". The type matters because a credit card and a loan are debts, not cash, and are accounted for differently.`,
      },
    }
  }

  return {
    ok: true,
    value: {
      institution,
      accountType,
      accountNumber: number ? number.value! : currency!,
      label: `${institution} ${TYPE_LABEL[accountType]} ${number ? number.value : currency}`,
    },
  }
}
