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
  /** Money moving BETWEEN accounts the company already owns: bank-to-bank moves, and
   * payouts from ANY payment processor (the processor is a clearing account — the CPA's
   * own Schedule L practice). Also covers paying down a credit card or a loan from a bank
   * account: that is settling a liability, not spending.
   * NEVER in the P&L. The income behind a processor payout is recognized from the INVOICE
   * ledger, so counting the payout too would double-count it; and a card payment is
   * already represented by the individual charges on the card.
   * Deliberately NOT named after a provider (Antonio, 2026-08-30) — the accounting is
   * identical whichever processor is in use, and a vendor name here ages badly. */
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
  /** For a NON-USD block: the rate the company ACTUALLY ACHIEVED converting this currency
   * during the year, derived from its own conversion rows (dollars bought ÷ currency sold).
   *
   * WHY DERIVED RATHER THAN LOOKED UP (2026-08-31). A US return must be filed in dollars,
   * and this screen deliberately never mixes currencies — correct, but it left the euro
   * block with no dollar figure at all, so the P&L on screen was not the whole company and
   * could not be handed to anyone. A published table rate would be a guess; the rate the
   * company genuinely got is in the books already, in the conversion rows.
   *
   * NULL when it cannot be derived honestly: no conversions, or MORE THAN ONE non-USD
   * currency converting, because the dollars bought cannot then be attributed to one
   * source currency. A wrong rate silently misstates revenue, so no rate is the safer
   * failure. The UI must show the block unconverted in that case, not a fabricated total. */
  usd_rate: number | null
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
  /** CASH ONLY — checking and savings. Cards and loans are debts, never cash. */
  totals: Record<string, number>
  accounts: CashAccountBalance[]
  /** Cards and loans, reported SEPARATELY as what they are: money owed. */
  liabilities: CashAccountBalance[]
  liabilityTotals: Record<string, number>
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

export async function getOwnerTransactions(
  year: number,
  category?: OwnerCategory
): Promise<OwnerTransaction[]> {
  // PAGED. An un-ranged select is silently capped at 1000 rows by PostgREST with NO
  // error — the same trap already documented and paged around for getInvoiceIncome
  // below (INCOME_FETCH_PAGE). This function feeds getOwnerPnL, and through it the
  // P&L tab, the dashboard KPIs, the Tax tab and the cash-flow chart, so the cap
  // would silently compute every headline figure from only the newest 1000 rows
  // while the Transactions tab — which is correctly ranged and uses count:'exact' —
  // reported the true total. Two surfaces disagreeing on the same year, no error.
  // A single real year of statements clears 1000 rows comfortably.
  // Ordered by (date, id) so paging is deterministic: date alone has ties on any
  // real statement, and an unstable sort would repeat some rows across pages and
  // skip others entirely.
  const PAGE = 1000
  const all: OwnerTransaction[] = []

  for (let offset = 0; ; offset += PAGE) {
    let q = supabaseAdmin
      .from('td_books_transactions')
      .select('*')
      .eq('entity_id', TD_ENTITY_ID)
      .eq('tax_year', year)
      .order('transaction_date', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + PAGE - 1)

    if (category) q = q.eq('category', category)

    const { data, error } = await q
    if (error) throw new Error(`getOwnerTransactions: ${error.message}`)
    const page = (data ?? []) as OwnerTransaction[]
    all.push(...page)
    if (page.length < PAGE) break
  }

  return all
}

export async function getOwnerTransactionsPaginated(
  year: number,
  options: {
    category?: OwnerCategory
    /** The P&L's own line names (payroll, rent, state_filing_fees…). Added 2026-08-31 so
     * every figure on the P&L can be opened and the rows behind it read — without it the
     * only way to check a number was to trust it. Deliberately paired with `category`
     * rather than replacing it: two categories can carry the same subcategory name
     * (income/client_payment and cogs/client_service_cost both being "client"-ish), so a
     * subcategory alone is not a unique line on the report. */
    subcategory?: string
    search?: string
    bank?: string
    limit?: number
    offset?: number
  } = {}
): Promise<{ rows: OwnerTransaction[]; total: number }> {
  const { category, subcategory, search, bank, limit = 50, offset = 0 } = options

  let q = supabaseAdmin
    .from('td_books_transactions')
    .select('*', { count: 'exact' })
    .eq('entity_id', TD_ENTITY_ID)
    .eq('tax_year', year)
    // (date, id) — a tie-break is required, not cosmetic. Many rows share a date on
    // a real statement, and Postgres gives no stable order for ties across separate
    // queries, so date-only paging shows some rows on two pages and NEVER shows an
    // equal number of others — rows that would then sit uncategorized forever while
    // the "Showing 51–100 of N" counter claims otherwise.
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (category) q = q.eq('category', category)
  if (subcategory) q = q.eq('subcategory', subcategory)
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

/** The ONLY categories that belong in a panel headed "Expenses by Subcategory".
 *
 * WHY THIS EXISTS (2026-08-31). The breakdown used to be built by EXCLUDING the non-P&L
 * categories (transfer/conversion/refund/distribution/contribution), which let `income`
 * through — so the panel listed client_payment alongside payroll and rent, as a cost. On
 * the real 2025 books that renders $426,946.58 of client revenue and $22,951.05 of bank
 * rewards under the word "Expenses". Because the panel takes the absolute value of every
 * row, the mistake is invisible: revenue looks exactly like a very large expense, and the
 * largest line on the screen is the one that is not an expense at all.
 *
 * An allowlist rather than another exclusion: a new SPENDING category must be added here
 * deliberately, whereas a new income-like category added to the enum would silently leak
 * back in under a denylist. */
const EXPENSE_BREAKDOWN_CATEGORIES: ReadonlySet<string> = new Set([
  'cogs', 'expense', 'fee',
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
        usd_rate: null,
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
      case 'refund':
        // A refund REVERSES something that already hit the P&L, so it must reduce
        // that thing — not vanish. Previously it fell through with no effect at all,
        // which OVERSTATED whatever it reversed.
        //
        // Direction decides which side it reverses, and it is unambiguous:
        //   money coming IN  reverses a payment we made      -> reduce expenses
        //   money going OUT  reverses money we received      -> reduce income
        //
        // Found on real data (2026-08-30): two Airwallex payouts to a provider were
        // reversed and the money came back, but the books still showed the full
        // €2,155 of professional services instead of the €2,020 actually spent.
        // Refunds are rare here today and will be common on the card statements.
        if (amt > 0) {
          b.expenses -= amt
          b.monthly[month].expenses -= amt
        } else {
          b.other_income -= Math.abs(amt)
          b.monthly[month].income -= Math.abs(amt)
        }
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
      // 'transfer' / 'conversion': deliberately no P&L effect — own money moving.
    }

    // Spending categories ONLY — see EXPENSE_BREAKDOWN_CATEGORIES. Using the
    // NON_PNL exclusion here let income into a panel headed "Expenses".
    if (EXPENSE_BREAKDOWN_CATEGORIES.has(tx.category)) {
      // Keyed "category/subcategory", not the bare name: the UI turns each line into a
      // link to the transactions behind it, and a subcategory name is NOT unique across
      // categories — filtering on the name alone would show rows from a different line
      // of the report and quietly contradict the total the reader just clicked.
      const key = `${tx.category}/${sub}`
      b.by_subcategory[key] = (b.by_subcategory[key] ?? 0) + Math.abs(amt)
    }
  }

  for (const b of Object.values(blocks)) {
    b.gross_profit = b.invoice_income + b.other_income - b.cogs
    b.net_profit = b.gross_profit - b.expenses + b.uncategorized_income - b.uncategorized_expense
    for (const mb of b.monthly) mb.net = mb.income - mb.cogs - mb.expenses
  }

  // THE ACHIEVED FX RATE. Every conversion has two legs in the books: the foreign
  // currency leaving (negative, in that currency) and the dollars arriving (positive,
  // in USD). Dividing one by the other gives the rate the company actually got, which
  // is a fact about the year rather than a table lookup. See PnLBlock.usd_rate.
  const soldByCurrency: Record<string, number> = {}
  let dollarsBought = 0
  for (const tx of txs) {
    if (tx.category !== 'conversion') continue
    const amt = Number(tx.amount)
    const cur = tx.currency || 'USD'
    if (cur === 'USD') { if (amt > 0) dollarsBought += amt; continue }
    if (amt < 0) soldByCurrency[cur] = (soldByCurrency[cur] ?? 0) + Math.abs(amt)
  }
  // Only attributable when a SINGLE non-USD currency was converted. With two, the
  // dollars bought cannot be split between them without inventing a split.
  const sources = Object.keys(soldByCurrency).filter(c => soldByCurrency[c] > 0)
  if (sources.length === 1 && dollarsBought > 0) {
    const only = sources[0]
    const block = blocks[only]
    if (block) block.usd_rate = dollarsBought / soldByCurrency[only]
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

/** Account types that hold CASH. A card or a loan balance is money OWED — adding it
 *  into cash reports debt as an asset. Measured: the First Citizens loan alone would
 *  have inflated cash by roughly $140,000, and three credit cards sit beside it. */
const CASH_PAGE = 1000

const CASH_ACCOUNT_TYPES = ['checking', 'savings']

export async function getCashPosition(): Promise<CashPosition> {
  // PAGED. An un-ranged select is silently capped at 1000 rows by PostgREST with no
  // error — and because this orders newest-first, the rows that fall off the end are
  // the QUIET accounts, which would disappear from the report entirely rather than
  // merely be stale. This file documents that trap twice and pages around it in three
  // other queries; this was the one that was missed.
  const rows: Array<{ bank_name: string; currency: string | null; balance_after: number | null; transaction_date: string; account_type: string | null }> = []
  for (let from = 0; ; from += CASH_PAGE) {
    const { data, error } = await supabaseAdmin
      .from('td_books_transactions')
      .select('bank_name, currency, balance_after, transaction_date, account_type')
      .eq('entity_id', TD_ENTITY_ID)
      .not('balance_after', 'is', null)
      .not('bank_name', 'is', null)
      // id is the TIE-BREAK, not decoration: several rows commonly share the closing
      // date, Postgres gives no stable order among ties, and without it "the latest
      // balance" is whichever row happened to come back first — a different answer on
      // a refresh with no data change. The same fix was already applied to two other
      // queries here and missed on this one.
      .order('transaction_date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + CASH_PAGE - 1)
    if (error) throw new Error(`getCashPosition: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < CASH_PAGE) break
  }

  // Latest balance per (bank, currency) — a bank holding USD and EUR is two balances,
  // and the totals stay per-currency (never a $-labeled EUR+USD sum).
  const seen = new Set<string>()
  const accounts: CashAccountBalance[] = []
  const liabilities: CashAccountBalance[] = []

  for (const row of rows) {
    const currency = row.currency || 'USD'
    const key = `${row.bank_name}|${currency}`
    if (seen.has(key)) continue
    seen.add(key)
    const entry: CashAccountBalance = {
      bank_name: row.bank_name,
      currency,
      balance: Number(row.balance_after),
      as_of: row.transaction_date,
    }
    // An account whose type is unknown is NOT assumed to be cash — it is reported as
    // a liability so it is visible and questioned, rather than silently inflating the
    // headline number.
    if (row.account_type && CASH_ACCOUNT_TYPES.includes(row.account_type)) accounts.push(entry)
    else liabilities.push(entry)
  }

  const totals: Record<string, number> = {}
  for (const a of accounts) totals[a.currency] = (totals[a.currency] ?? 0) + a.balance
  const liabilityTotals: Record<string, number> = {}
  for (const a of liabilities) liabilityTotals[a.currency] = (liabilityTotals[a.currency] ?? 0) + a.balance
  return { totals, accounts, liabilities, liabilityTotals }
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

/* ─────────────────────────────────────────────────────────────────────────────
 * THE FILING SUMMARY — the books, with tax treatment applied on top.
 *
 * WHY THIS IS A SEPARATE LAYER AND NOT AN EDIT TO THE BOOKS (Antonio, 2026-08-31).
 * The three adjustments below are real and must reach the return. The tempting move is
 * to change the rows — halve the meals, convert the euro income, strike the property.
 * That would be wrong, and expensively so:
 *
 *   - The books were just proven, row by row, against every bank's own running balance
 *     (818 rows, no unexplained steps). Halving a meal breaks that tie-out permanently,
 *     and the tie-out is the whole evidence base for saying these numbers are real.
 *   - The company genuinely spent $2,927.51 on meals and genuinely earned €144,770.90.
 *     Those are facts about the year. "Only half a meal is deductible" is a fact about
 *     the tax code, and the two do not belong in the same column.
 *   - Prior bookkeeping failed in exactly this direction — tax treatment baked into the
 *     ledger until nobody could tell what had actually happened from what someone had
 *     decided about it.
 *
 * So: books stay as recorded, this computes what the return needs, and every adjustment
 * is named and reversible.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface FilingAdjustment {
  label: string
  amount: number
  /** Plain-English reason, written for whoever files — not for us. */
  why: string
}

export interface FilingSummary {
  year: number
  /** Profit as the books report it, USD block only. */
  books_net_usd: number
  /** Foreign-currency profit converted at the rate the company actually achieved. */
  foreign: Array<{ currency: string; net: number; rate: number | null; net_usd: number | null }>
  adjustments: FilingAdjustment[]
  /** What the return should show. */
  taxable_income: number
  /** Property bought this year — already OUT of profit, needs depreciation set up. */
  capitalized: Array<{ label: string; amount: number }>
  /** Anything that could not be converted honestly and must be handled by hand. */
  warnings: string[]
}

/** The share of a business meal that is NOT deductible. 50% since the 2021-22 restaurant
 *  exception lapsed. A named constant so the day it changes there is one place to change. */
export const MEALS_NONDEDUCTIBLE_SHARE = 0.5

export function computeFilingSummary(
  txs: OwnerTransaction[],
  pnl: OwnerPnL,
): FilingSummary {
  const usdBlock = pnl.blocks.find(b => b.currency === 'USD')
  const books_net_usd = usdBlock?.net_profit ?? 0
  const warnings: string[] = []

  const foreign = pnl.blocks.filter(b => b.currency !== 'USD').map(b => {
    if (b.usd_rate === null) {
      warnings.push(
        `${b.currency} activity could not be converted: no single achieved rate exists for it. ` +
        `Its net of ${b.net_profit.toFixed(2)} ${b.currency} must be converted by hand before filing.`,
      )
      return { currency: b.currency, net: b.net_profit, rate: null, net_usd: null }
    }
    return { currency: b.currency, net: b.net_profit, rate: b.usd_rate, net_usd: b.net_profit * b.usd_rate }
  })

  const adjustments: FilingAdjustment[] = []

  // MEALS. The books hold what was spent; the return may deduct only half, so the other
  // half is added back to profit. Counted across every currency, converted where needed.
  let mealsAddBack = 0
  for (const b of pnl.blocks) {
    const meals = b.by_subcategory['expense/meals'] ?? 0
    if (meals === 0) continue
    const rate = b.currency === 'USD' ? 1 : b.usd_rate
    if (rate === null) {
      warnings.push(`${b.currency} meals of ${meals.toFixed(2)} could not be converted — add back half by hand.`)
      continue
    }
    mealsAddBack += meals * MEALS_NONDEDUCTIBLE_SHARE * rate
  }
  if (mealsAddBack > 0) {
    adjustments.push({
      label: 'Half of business meals added back',
      amount: mealsAddBack,
      why: 'A business meal is only 50% deductible. The books record the full amount actually spent; this adds the non-deductible half back to profit.',
    })
  }

  // PROPERTY. Already parked outside profit when the books were built, so there is
  // nothing to adjust — but it must be VISIBLE, or the depreciation it is owed is
  // simply forgotten and the deduction is lost every year thereafter.
  const capitalized = Object.entries(
    txs.filter(t => t.subcategory === 'fixed_asset_office_purchase')
       .reduce<Record<string, number>>((acc, t) => {
         acc['Office property purchased'] = (acc['Office property purchased'] ?? 0) + Math.abs(Number(t.amount))
         return acc
       }, {}),
  ).map(([label, amount]) => ({ label, amount }))

  const taxable_income =
    books_net_usd
    + foreign.reduce((s, f) => s + (f.net_usd ?? 0), 0)
    + adjustments.reduce((s, a) => s + a.amount, 0)

  return { year: pnl.year, books_net_usd, foreign, adjustments, taxable_income, capitalized, warnings }
}

/** Server helper: the filing summary for a year, straight from the books.
 *  Reads the FULL year (getOwnerTransactions pages, so no 1000-row cap) because the
 *  adjustments are whole-year facts — a summary computed from one page of transactions
 *  would understate the return and look perfectly reasonable doing it. */
export async function getFilingSummary(year: number): Promise<FilingSummary> {
  const [txs, pnl] = await Promise.all([getOwnerTransactions(year), getOwnerPnL(year)])
  return computeFilingSummary(txs, pnl)
}
