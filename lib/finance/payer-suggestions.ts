/**
 * What the Bank Feed's "Match to invoice" popup can work out about WHO paid, so it can offer the
 * right invoices instead of every unpaid invoice of every client.
 *
 * Real case (Antonio, 2026-10-29): a $125 Stripe payment from "Bilaal Rajan". Seven earlier
 * payments from the same sender were all linked to one company, and two of that company's
 * invoices — $50 and $75, both already marked Paid on the payment's own date — add up to exactly
 * $125. The popup listed 22 unrelated unpaid invoices and, because the right ones were already
 * Paid, could not show them at all.
 *
 * Everything here is PURE (no database, no clock): the route reads the data and passes it in, so
 * the rules are unit-testable. Nothing here decides anything for a person — it orders and
 * suggests; a human still ticks the invoices and clicks.
 */

const round2 = (n: number) => Math.round(n * 100) / 100
const toCents = (n: number) => Math.round((Number(n) || 0) * 100)

/** A combination is shown only when it is built from at most this many invoices. */
export const MAX_COMBO_SIZE = 4
/** The combination search looks at no more than this many invoices (cost is C(n, k)). */
export const MAX_COMBO_POOL = 24
/** How many combinations are offered at most. */
export const MAX_COMBOS_SHOWN = 5
/** A paid date this close to the transaction date counts as "paid at the time of this payment". */
export const PAID_DATE_WINDOW_DAYS = 3

// ───────────────────────────────────────────────────────────────────────────────────────
// Who is the payer?
// ───────────────────────────────────────────────────────────────────────────────────────

/** Lower-case, trimmed, single-spaced — so "BILAAL  Rajan " and "Bilaal Rajan" are one payer. */
export function normalizePayerName(name: string | null | undefined): string {
  return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * The email a payment processor put in the memo ("email: rajan.aman@gmail.com | visa ••••9765").
 * Null when there is none. A real address only — a stray "email:" with nothing usable is ignored.
 */
export function parsePayerEmail(memo: string | null | undefined): string | null {
  const m = /email:\s*([^\s|,;]+@[^\s|,;]+\.[^\s|,;]+)/i.exec(String(memo ?? ""))
  return m ? m[1].toLowerCase() : null
}

/**
 * Escape a user-controlled string for a PostgREST `ilike` pattern: `%` and `_` are wildcards, `\`
 * is the escape. The caller wraps the result in its own `%…%` when it wants "contains".
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * A payer's name is only a usable signal when it says something: a one-word or very short
 * sender ("Stripe", "ACH") would match a whole class of unrelated payments.
 */
export function isUsablePayerName(normalized: string): boolean {
  if (normalized.length < 4) return false
  // The processors write "Unknown" when they have no name at all — that identifies nobody.
  if (normalized === "unknown") return false
  // One word ("Mario", "Acme") is shared by too many unrelated payers to say who this one is.
  if (normalized.split(" ").filter((w) => /[a-z]/.test(w)).length < 2) return false
  return /[a-z]/.test(normalized)
}

export interface PayerHistoryRow {
  /** The company (account) the earlier payment was linked to, when it had one. */
  account_id: string | null
  /** The person (contact) it was linked to when there was no company. */
  contact_id: string | null
  /** The earlier transaction's date (YYYY-MM-DD). */
  transaction_date: string | null
}

export interface PayerCompany {
  kind: "account" | "contact"
  id: string
  times_linked: number
  last_linked: string | null
}

/**
 * The companies this payer was linked to before, most-linked first (ties: most recent). Never
 * hides anything beyond the cap — the full invoice list stays reachable from the popup.
 */
export function rankPayerCompanies(rows: ReadonlyArray<PayerHistoryRow>, limit = 3): PayerCompany[] {
  const byKey = new Map<string, PayerCompany>()
  for (const row of rows) {
    const kind = row.account_id ? "account" : row.contact_id ? "contact" : null
    const id = row.account_id ?? row.contact_id
    if (!kind || !id) continue
    const key = `${kind}:${id}`
    const existing = byKey.get(key)
    const date = row.transaction_date ? String(row.transaction_date).slice(0, 10) : null
    if (!existing) {
      byKey.set(key, { kind, id, times_linked: 1, last_linked: date })
    } else {
      existing.times_linked += 1
      if (date && (!existing.last_linked || date > existing.last_linked)) existing.last_linked = date
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.times_linked - a.times_linked || String(b.last_linked ?? "").localeCompare(String(a.last_linked ?? "")))
    .slice(0, Math.max(limit, 0))
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Which of that payer's invoices add up to the payment?
// ───────────────────────────────────────────────────────────────────────────────────────

export interface ComboInvoice {
  id: string
  /** What this invoice contributes: its total when paid, its balance when still owed. */
  amount: number
  currency: string | null
  /** Already Paid (record-only when linked) vs still owed. */
  paid: boolean
  paid_date: string | null
  /** Already tied to ANOTHER bank transaction — never suggested. */
  claimed_by_other: boolean
}

export interface ExactCombo {
  ids: string[]
  total: number
  /** Every paid member was paid within the window of the transaction date. */
  dates_match: boolean
}

function dayNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  if (!m) return null
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
}

/** Days between two calendar dates; null when either is missing. */
export function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = dayNumber(a)
  const y = dayNumber(b)
  return x == null || y == null ? null : Math.abs(x - y)
}

/**
 * Every set of 1–MAX_COMBO_SIZE of the given invoices whose amounts add up to EXACTLY the
 * payment (to the cent), best first:
 *   1. sets whose paid members were all paid within PAID_DATE_WINDOW_DAYS of the transaction,
 *   2. then fewer invoices,
 *   3. then the closest paid dates.
 * Invoices already tied to another transaction, in another currency, or with no positive amount
 * are never used. When the pool is bigger than MAX_COMBO_POOL it is cut to the invoices closest
 * in time to the payment (unpaid invoices count as "now"), so the search stays bounded.
 */
export function findExactCombos(
  transactionAmount: number,
  transactionDate: string | null,
  currency: string,
  invoices: ReadonlyArray<ComboInvoice>,
): ExactCombo[] {
  const target = toCents(transactionAmount)
  if (target <= 0) return []

  const usable = invoices.filter(
    (i) => !i.claimed_by_other && (i.currency ?? "USD") === currency && toCents(i.amount) > 0 && toCents(i.amount) <= target,
  )
  const distance = (i: ComboInvoice) => (i.paid ? (daysApart(i.paid_date, transactionDate) ?? 3650) : 0)
  const pool = usable
    .slice()
    .sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))
    .slice(0, MAX_COMBO_POOL)

  const cents = pool.map((i) => toCents(i.amount))
  const found: Array<{ idx: number[]; score: number[] }> = []

  const search = (start: number, picked: number[], sum: number) => {
    if (sum === target && picked.length > 0) {
      const members = picked.map((p) => pool[p])
      const paidDistances = members.filter((m) => m.paid).map((m) => daysApart(m.paid_date, transactionDate) ?? 3650)
      // "Paid around the date of this payment" is only a claim about PAID invoices: a set of
      // still-owed invoices has no paid dates, so it makes no such claim.
      const allClose = paidDistances.length > 0 && paidDistances.every((d) => d <= PAID_DATE_WINDOW_DAYS)
      found.push({
        idx: picked.slice(),
        // Lower sorts first: close-dated sets, then fewer invoices, then the nearest dates.
        score: [allClose ? 0 : 1, picked.length, paidDistances.reduce((s, d) => s + d, 0)],
      })
      return
    }
    if (picked.length >= MAX_COMBO_SIZE || sum >= target) return
    for (let i = start; i < pool.length; i++) {
      if (sum + cents[i] > target) continue
      picked.push(i)
      search(i + 1, picked, sum + cents[i])
      picked.pop()
    }
  }
  search(0, [], 0)

  found.sort((a, b) => {
    for (let k = 0; k < a.score.length; k++) if (a.score[k] !== b.score[k]) return a.score[k] - b.score[k]
    return a.idx.join(",").localeCompare(b.idx.join(","))
  })

  return found.slice(0, MAX_COMBOS_SHOWN).map(({ idx, score }) => ({
    ids: idx.map((p) => pool[p].id),
    total: round2(idx.reduce((s, p) => s + cents[p], 0) / 100),
    dates_match: score[0] === 0,
  }))
}
