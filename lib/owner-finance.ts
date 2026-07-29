import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * The entity whose books these are — Tony Durante LLC. `td_books_transactions` carries an
 * `entity_id` from day one so a second company's books are an INSERT away, but today this
 * is the only entity. THE one definition: the projection and every owner API import it
 * from here (two independent copies of this constant were a named migration hazard).
 */
export const TD_ENTITY_ID = '00000000-0000-0000-0000-000000000001'

/** @deprecated Books moved OUT of the multi-tenant `bank_transactions` table (Phase 1a,
 * 2026-07-29) into `td_books_transactions`. This name survives for the historical import
 * scripts; new code uses TD_ENTITY_ID. Same value — the entity id IS the old sentinel. */
export const OWNER_ACCOUNT_ID = TD_ENTITY_ID

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type OwnerCategory =
  | 'income'
  | 'cogs'
  | 'expense'
  | 'distribution'
  | 'fee'
  | 'conversion'
  | 'refund'
  /** Owner money INTO the company — equity, never income (the S-corp roll-forward needs it). */
  | 'contribution'
  /** Money moving BETWEEN TD's own accounts — Stripe payouts (Stripe = clearing account,
   * the CPA's own Schedule L practice) and bank-to-bank moves. NEVER in the P&L: the
   * income behind a Stripe payout is recognized from the INVOICE ledger, so counting the
   * payout too would double-count. */
  | 'transfer'
  | 'uncategorized'

/** Runtime companion of OwnerCategory — the API routes validate against this so a bad
 * category gets a clear 400, not a raw Postgres CHECK-violation message (R099). */
export const OWNER_CATEGORIES = [
  'income', 'cogs', 'expense', 'distribution', 'fee', 'conversion', 'refund',
  'contribution', 'transfer', 'uncategorized',
] as const

export function isOwnerCategory(value: unknown): value is OwnerCategory {
  return typeof value === 'string' && (OWNER_CATEGORIES as readonly string[]).includes(value)
}

export interface OwnerTransaction {
  id: string
  transaction_date: string
  description: string
  category: OwnerCategory
  subcategory: string | null
  counterparty: string | null
  amount: number
  currency: string
  balance_after: number | null
  bank_name: string | null
  account_type: string | null
  transaction_ref: string | null
  is_related_party: boolean
  notes: string | null
  tax_year: number
  created_at: string
}

/**
 * One currency's P&L. The books NEVER sum mixed currencies (council rule: no unconverted
 * totals) — each currency gets its own block, rendered side by side. Conversion to a
 * single reporting currency is a later, CPA-informed step.
 */
export interface PnLBlock {
  currency: string
  /** Cash received against client invoices (the PAYMENTS ledger — the revenue universe;
   * 486/499 paid invoices have no bank-feed link, so bank rows can never be income). */
  invoice_income: number
  /** Books rows Antonio categorized 'income' — rewards, referral bonuses. The CPA books
   * these as Other Income on the filed return. */
  other_income: number
  cogs: number
  gross_profit: number
  expenses: number
  net_profit: number
  distributions: number
  contributions: number
  uncategorized_income: number
  uncategorized_expense: number
  by_subcategory: Record<string, number>
  monthly: MonthlyBreakdown[]
}

export interface OwnerPnL {
  year: number
  /** USD first, then any other currency with activity. */
  blocks: PnLBlock[]
  /** Cash recorded on Cancelled/Refunded invoices — EXCLUDED from income, needs review. */
  income_anomalies: InvoiceIncomeAnomaly[]
  /** Income rows whose receipt date was approximated (no paid date on the invoice). */
  approximated_date_count: number
  /** Part-paid invoices counted in income — cumulative cash attributed to one date. */
  partial_attribution_count: number
}

export interface MonthlyBreakdown {
  month: number  // 1-12
  income: number
  cogs: number
  expenses: number
  net: number
}

/** Minimal projection of a payments-ledger row for income computation. */
export interface InvoiceIncomeRow {
  amount_paid: number | null
  amount_currency: string | null
  paid_date: string | null
  issue_date: string | null
  created_at: string | null
  status: string
  invoice_number: string | null
  /** Invoice total (falls back to `amount`) — used only to FLAG part-paid rows, whose
   * cumulative cash can span months/years the single paid date can't express. */
  total: number | null
  amount: number | null
}

export interface InvoiceIncomeCurrency {
  currency: string
  total: number
  monthly: number[]  // index 0-11
  /** Rows counted in total whose date came from issue/created date, not a real paid date. */
  approximated_count: number
  /** Rows counted in total whose cash is a PARTIAL payment — the ledger stores one date
   * for cumulative cash, so multi-installment receipts are attributed to one month. */
  partial_count: number
}

export interface InvoiceIncomeAnomaly {
  invoice_number: string | null
  status: string
  amount_paid: number
  currency: string
  paid_date: string | null
}

export interface InvoiceIncome {
  year: number
  byCurrency: Record<string, InvoiceIncomeCurrency>
  /** Cancelled/Refunded rows with cash whose effective date falls IN this year. */
  anomalies: InvoiceIncomeAnomaly[]
}

export interface CashAccountBalance {
  bank_name: string
  currency: string
  balance: number
  as_of: string
}

/** Per-currency cash totals — NEVER a single cross-currency number (council rule). */
export interface CashPosition {
  /** Per-currency totals over FRESH balances only (see stale). */
  totals: Record<string, number>
  accounts: CashAccountBalance[]
  /** Balances whose newest data is older than the freshness window — shown, dated,
   * but NEVER summed into totals: an imported December statement must not present
   * last year's balance as today's cash. */
  stale: CashAccountBalance[]
}

export interface VendorRule {
  id: string
  counterparty_pattern: string
  match_type: 'exact' | 'contains' | 'regex'
  category: string
  subcategory: string
  is_related_party: boolean
  notes: string | null
}

const FETCH_PAGE = 1000

/** PAGED — PostgREST silently caps un-ranged selects at 1000 rows, and after a
 * full-year statement backfill a year easily exceeds that. A truncated read here
 * silently understates the P&L. */
export async function getOwnerTransactions(
  year: number,
  category?: OwnerCategory
): Promise<OwnerTransaction[]> {
  const all: OwnerTransaction[] = []
  for (let from = 0; ; from += FETCH_PAGE) {
    let q = supabaseAdmin
      .from('td_books_transactions')
      .select('*')
      .eq('entity_id', TD_ENTITY_ID)
      .eq('tax_year', year)
      .order('transaction_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + FETCH_PAGE - 1)
    if (category) q = q.eq('category', category)
    const { data, error } = await q
    if (error) throw new Error(`getOwnerTransactions: ${error.message}`)
    all.push(...((data ?? []) as OwnerTransaction[]))
    if ((data ?? []).length < FETCH_PAGE) break
  }
  return all
}

export async function getOwnerTransactionsPaginated(
  year: number,
  options: {
    category?: OwnerCategory
    search?: string
    bank?: string
    limit?: number
    offset?: number
  } = {}
): Promise<{ rows: OwnerTransaction[]; total: number }> {
  const { category, search, bank, limit = 50, offset = 0 } = options

  let q = supabaseAdmin
    .from('td_books_transactions')
    .select('*', { count: 'exact' })
    .eq('entity_id', TD_ENTITY_ID)
    .eq('tax_year', year)
    .order('transaction_date', { ascending: false })
    .range(offset, offset + limit - 1)

  if (category) q = q.eq('category', category)
  if (bank) q = q.eq('bank_name', bank)
  if (search) {
    q = q.or(`description.ilike.%${search}%,counterparty.ilike.%${search}%`)
  }

  const { data, count, error } = await q
  if (error) throw new Error(`getOwnerTransactionsPaginated: ${error.message}`)
  return { rows: (data ?? []) as OwnerTransaction[], total: count ?? 0 }
}

/** Month (1-12) from a date string WITHOUT timezone drift: 'YYYY-MM-DD' or ISO timestamp.
 * `new Date('2026-03-01').getMonth()` is UTC-parsed then locally-read — off by one for
 * evening-timezone users on month boundaries. Slice the string instead. */
function monthOf(dateStr: string): number {
  return Number(dateStr.slice(5, 7))
}
function yearOf(dateStr: string): number {
  return Number(dateStr.slice(0, 4))
}

/**
 * Income from the payments/invoice ledger — PURE, unit-tested. Cash method: money counts
 * in the year/month it was RECEIVED (paid_date). Rules:
 * - only real cash: amount_paid > 0, test rows excluded by the caller's query
 * - Cancelled/Refunded rows with cash are ANOMALIES: excluded from totals, surfaced
 *   for review (the money likely went back — silently counting it overstates income)
 * - a row with cash but NO paid date is still income (part-payments often lack one);
 *   its date falls back to issue date then created date and the row is COUNTED but
 *   flagged approximated — never silently dropped, never silently precise
 * - per-currency throughout; nothing is ever converted or mixed
 */
export function computeInvoiceIncome(rows: InvoiceIncomeRow[], year: number): InvoiceIncome {
  const byCurrency: Record<string, InvoiceIncomeCurrency> = {}
  const anomalies: InvoiceIncomeAnomaly[] = []

  for (const row of rows) {
    const paid = Number(row.amount_paid ?? 0)
    if (paid <= 0) continue
    const currency = row.amount_currency || 'USD'
    const effectiveDate = row.paid_date ?? row.issue_date ?? row.created_at

    if (row.status === 'Cancelled' || row.status === 'Refunded') {
      // Year-scoped: a 2025 refund must not haunt every later year's banner (a permanent
      // banner trains the reader to ignore the one control that catches bad income).
      // A dateless anomaly can't be scoped — shown everywhere, which is the safe side.
      if (effectiveDate && yearOf(effectiveDate) !== year) continue
      anomalies.push({
        invoice_number: row.invoice_number,
        status: row.status,
        amount_paid: paid,
        currency,
        paid_date: row.paid_date,
      })
      continue
    }

    if (!effectiveDate || yearOf(effectiveDate) !== year) continue

    const block = (byCurrency[currency] ??= {
      currency,
      total: 0,
      monthly: Array(12).fill(0),
      approximated_count: 0,
      partial_count: 0,
    })
    block.total += paid
    block.monthly[monthOf(effectiveDate) - 1] += paid
    if (!row.paid_date) block.approximated_count += 1
    const owed = Number(row.total ?? row.amount ?? 0)
    if (owed > 0 && paid < owed) block.partial_count += 1
  }

  return { year, byCurrency, anomalies }
}

/** Page size for the ledger fetch. PostgREST silently caps un-ranged selects (default
 * 1000 rows) with NO error — an unbounded fetch here would quietly understate income the
 * day the ledger outgrows the cap. So: explicit pages, ordered for determinism, loop
 * until a short page proves completeness. */
const INCOME_FETCH_PAGE = 1000

export async function getInvoiceIncome(year: number): Promise<InvoiceIncome> {
  const rows: InvoiceIncomeRow[] = []
  for (let from = 0; ; from += INCOME_FETCH_PAGE) {
    const { data, error } = await supabaseAdmin
      .from('payments')
      .select('amount_paid, amount_currency, paid_date, issue_date, created_at, status, invoice_number, total, amount')
      .gt('amount_paid', 0)
      .not('is_test', 'is', true)
      .order('id', { ascending: true })
      .range(from, from + INCOME_FETCH_PAGE - 1)

    if (error) throw new Error(`getInvoiceIncome: ${error.message}`)
    rows.push(...((data ?? []) as InvoiceIncomeRow[]))
    if ((data ?? []).length < INCOME_FETCH_PAGE) break
  }
  return computeInvoiceIncome(rows, year)
}

/** Categories that never enter the P&L: transfers between TD's own accounts (incl. Stripe
 * payouts — income is recognized from the invoice ledger, so the payout landing in the
 * bank is the SAME money), FX conversions, refund pass-throughs, and equity movements
 * (distribution/contribution — shown separately, never in profit). */
const NON_PNL_CATEGORIES: ReadonlySet<string> = new Set([
  'transfer', 'conversion', 'refund', 'distribution', 'contribution',
])

/**
 * Per-currency P&L from books rows + invoice-ledger income — PURE, unit-tested.
 * Income comes from the PAYMENTS ledger; books 'income' rows are Other Income only.
 */
export function computeOwnerPnL(
  txs: OwnerTransaction[],
  invoiceIncome: InvoiceIncome,
  year: number
): OwnerPnL {
  const blocks: Record<string, PnLBlock> = {}

  const blockFor = (currency: string): PnLBlock => {
    if (!blocks[currency]) {
      blocks[currency] = {
        currency,
        invoice_income: 0,
        other_income: 0,
        cogs: 0,
        gross_profit: 0,
        expenses: 0,
        net_profit: 0,
        distributions: 0,
        contributions: 0,
        uncategorized_income: 0,
        uncategorized_expense: 0,
        by_subcategory: {},
        monthly: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1, income: 0, cogs: 0, expenses: 0, net: 0,
        })),
      }
    }
    return blocks[currency]
  }

  let approximatedDates = 0
  let partials = 0
  for (const inc of Object.values(invoiceIncome.byCurrency)) {
    const b = blockFor(inc.currency)
    b.invoice_income = inc.total
    approximatedDates += inc.approximated_count
    partials += inc.partial_count
    for (let m = 0; m < 12; m++) b.monthly[m].income += inc.monthly[m]
  }

  for (const tx of txs) {
    const amt = Number(tx.amount)
    const b = blockFor(tx.currency || 'USD')
    const month = monthOf(tx.transaction_date) - 1
    const sub = tx.subcategory ?? tx.category ?? 'uncategorized'

    switch (tx.category as OwnerCategory) {
      case 'income':
        b.other_income += amt
        b.monthly[month].income += amt
        break
      case 'cogs':
        b.cogs += Math.abs(amt)
        b.monthly[month].cogs += Math.abs(amt)
        break
      case 'expense':
      case 'fee':
        b.expenses += Math.abs(amt)
        b.monthly[month].expenses += Math.abs(amt)
        break
      case 'distribution':
        b.distributions += Math.abs(amt)
        break
      case 'contribution':
        b.contributions += Math.abs(amt)
        break
      case 'uncategorized':
        // Uncategorized cash reaches BOTH the annual net and the monthly series — the
        // chart's monthly nets must sum to the Net Profit KPI (they diverged before).
        if (amt > 0) {
          b.uncategorized_income += amt
          b.monthly[month].income += amt
        } else {
          b.uncategorized_expense += Math.abs(amt)
          b.monthly[month].expenses += Math.abs(amt)
        }
        break
      // 'transfer' / 'conversion' / 'refund': deliberately no P&L effect
    }

    if (!NON_PNL_CATEGORIES.has(tx.category)) {
      b.by_subcategory[sub] = (b.by_subcategory[sub] ?? 0) + Math.abs(amt)
    }
  }

  for (const b of Object.values(blocks)) {
    b.gross_profit = b.invoice_income + b.other_income - b.cogs
    b.net_profit = b.gross_profit - b.expenses + b.uncategorized_income - b.uncategorized_expense
    for (const mb of b.monthly) mb.net = mb.income - mb.cogs - mb.expenses
  }

  // A currency whose only rows are non-P&L (transfers/conversions/refunds) would render
  // an all-zero table — drop blocks with no reportable activity at all.
  const hasActivity = (b: PnLBlock) =>
    b.invoice_income !== 0 || b.other_income !== 0 || b.cogs !== 0 || b.expenses !== 0 ||
    b.distributions !== 0 || b.contributions !== 0 ||
    b.uncategorized_income !== 0 || b.uncategorized_expense !== 0

  const ordered = Object.values(blocks).filter(hasActivity).sort((a, z) => {
    if (a.currency === 'USD') return -1
    if (z.currency === 'USD') return 1
    return a.currency.localeCompare(z.currency)
  })

  return {
    year,
    blocks: ordered,
    income_anomalies: invoiceIncome.anomalies,
    approximated_date_count: approximatedDates,
    partial_attribution_count: partials,
  }
}

export async function getOwnerPnL(year: number): Promise<OwnerPnL> {
  const [txs, invoiceIncome] = await Promise.all([
    getOwnerTransactions(year),
    getInvoiceIncome(year),
  ])
  return computeOwnerPnL(txs, invoiceIncome, year)
}

export async function getCashPosition(): Promise<CashPosition> {
  // PAGED — after a big backfill, >1000 rows carry balances; unpaged, a dormant
  // bank's newest balance beyond the cap would VANISH (not stale — gone).
  type BalRow = { bank_name: string; currency: string | null; balance_after: number | string; transaction_date: string }
  const data: BalRow[] = []
  for (let from = 0; ; from += FETCH_PAGE) {
    const { data: page, error } = await supabaseAdmin
      .from('td_books_transactions')
      .select('bank_name, currency, balance_after, transaction_date')
      .eq('entity_id', TD_ENTITY_ID)
      .not('balance_after', 'is', null)
      .not('bank_name', 'is', null)
      .order('transaction_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + FETCH_PAGE - 1)
    if (error) throw new Error(`getCashPosition: ${error.message}`)
    data.push(...((page ?? []) as BalRow[]))
    if ((page ?? []).length < FETCH_PAGE) break
  }

  // Latest balance per (bank, currency) — a bank holding USD and EUR is two balances,
  // and the totals stay per-currency (never a $-labeled EUR+USD sum).
  const seen = new Set<string>()
  const accounts: CashAccountBalance[] = []
  const stale: CashAccountBalance[] = []

  // Statement backfill writes HISTORICAL balances; without a freshness cut, importing
  // last year's statements would present a December balance as today's cash.
  const STALE_DAYS = 45
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString().slice(0, 10)

  for (const row of data ?? []) {
    const currency = row.currency || 'USD'
    const key = `${row.bank_name}|${currency}`
    if (!seen.has(key)) {
      seen.add(key)
      const entry = {
        bank_name: row.bank_name,
        currency,
        balance: Number(row.balance_after),
        as_of: row.transaction_date,
      }
      if (row.transaction_date >= cutoff) accounts.push(entry)
      else stale.push(entry)
    }
  }

  const totals: Record<string, number> = {}
  for (const a of accounts) totals[a.currency] = (totals[a.currency] ?? 0) + a.balance
  return { totals, accounts, stale }
}

export async function getUncategorizedCount(year: number): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('entity_id', TD_ENTITY_ID)
    .eq('tax_year', year)
    .eq('category', 'uncategorized')

  if (error) throw new Error(`getUncategorizedCount: ${error.message}`)
  return count ?? 0
}

export async function getVendorRules(): Promise<VendorRule[]> {
  const { data, error } = await db
    .from('owner_vendor_rules')
    .select('*')
    .order('counterparty_pattern')

  if (error) throw new Error(`getVendorRules: ${error.message}`)
  return data as VendorRule[]
}

// Vendor matching (normalizeVendorKey / isSimilarVendor / rule application) lives in
// lib/owner-vendor-match.ts — CLIENT-SAFE, no DB imports (the transactions tab uses it
// at render time for rule suggestions). Re-exported here for server-side callers.
export { normalizeVendorKey, isSimilarVendor } from '@/lib/owner-vendor-match'
import { applyVendorRulesTo } from '@/lib/owner-vendor-match'

export function applyVendorRules(
  transactions: OwnerTransaction[],
  rules: VendorRule[]
): OwnerTransaction[] {
  return applyVendorRulesTo(transactions, rules)
}

// estimateQuarterlyTax DELETED (Phase 1b, 2026-07-29). The flat 25%+SE math was sole-prop
// arithmetic and WRONG for this S-corp (filed 1120-S: cash method, W-2 officer comp,
// distributions, AAA roll-forward — no SE tax on flow-through profit). Do NOT re-add a
// flat-rate estimate; owner-level tax comes from the CPA via K-1 + W-2 withholding.
