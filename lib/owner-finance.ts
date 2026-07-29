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
  | 'uncategorized'

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

export interface OwnerPnL {
  year: number
  income: number
  cogs: number
  gross_profit: number
  expenses: number
  net_profit: number
  distributions: number
  uncategorized_income: number
  uncategorized_expense: number
  by_subcategory: Record<string, number>
  monthly: MonthlyBreakdown[]
}

export interface MonthlyBreakdown {
  month: number  // 1-12
  income: number
  cogs: number
  expenses: number
  net: number
}

export interface CashPosition {
  total: number
  accounts: { bank_name: string; balance: number; as_of: string }[]
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
  let q = supabaseAdmin
    .from('td_books_transactions')
    .select('*')
    .eq('entity_id', TD_ENTITY_ID)
    .eq('tax_year', year)
    .order('transaction_date', { ascending: false })

  if (category) q = q.eq('category', category)

  const { data, error } = await q
  if (error) throw new Error(`getOwnerTransactions: ${error.message}`)
  return (data ?? []) as OwnerTransaction[]
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

export async function getOwnerPnL(year: number): Promise<OwnerPnL> {
  const txs = await getOwnerTransactions(year)

  const pnl: OwnerPnL = {
    year,
    income: 0,
    cogs: 0,
    gross_profit: 0,
    expenses: 0,
    net_profit: 0,
    distributions: 0,
    uncategorized_income: 0,
    uncategorized_expense: 0,
    by_subcategory: {},
    monthly: [],
  }

  const monthlyMap: Record<number, MonthlyBreakdown> = {}
  for (let m = 1; m <= 12; m++) {
    monthlyMap[m] = { month: m, income: 0, cogs: 0, expenses: 0, net: 0 }
  }

  for (const tx of txs) {
    const amt = Number(tx.amount)
    const month = new Date(tx.transaction_date).getMonth() + 1
    const sub = tx.subcategory ?? tx.category ?? 'uncategorized'

    switch (tx.category as OwnerCategory) {
      case 'income':
        pnl.income += amt
        monthlyMap[month].income += amt
        break
      case 'cogs':
        pnl.cogs += Math.abs(amt)
        monthlyMap[month].cogs += Math.abs(amt)
        break
      case 'expense':
      case 'fee':
        pnl.expenses += Math.abs(amt)
        monthlyMap[month].expenses += Math.abs(amt)
        break
      case 'distribution':
        pnl.distributions += Math.abs(amt)
        break
      case 'uncategorized':
        if (amt > 0) pnl.uncategorized_income += amt
        else pnl.uncategorized_expense += Math.abs(amt)
        break
    }

    if (!['distribution', 'conversion', 'refund'].includes(tx.category)) {
      pnl.by_subcategory[sub] = (pnl.by_subcategory[sub] ?? 0) + Math.abs(amt)
    }
  }

  pnl.gross_profit = pnl.income - pnl.cogs
  pnl.net_profit = pnl.gross_profit - pnl.expenses + pnl.uncategorized_income - pnl.uncategorized_expense

  for (let m = 1; m <= 12; m++) {
    const mb = monthlyMap[m]
    mb.net = mb.income - mb.cogs - mb.expenses
    pnl.monthly.push(mb)
  }

  return pnl
}

export async function getMonthlyBreakdown(year: number): Promise<MonthlyBreakdown[]> {
  const pnl = await getOwnerPnL(year)
  return pnl.monthly
}

export async function getCashPosition(): Promise<CashPosition> {
  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .select('bank_name, balance_after, transaction_date')
    .eq('entity_id', TD_ENTITY_ID)
    .not('balance_after', 'is', null)
    .not('bank_name', 'is', null)
    .order('transaction_date', { ascending: false })

  if (error) throw new Error(`getCashPosition: ${error.message}`)

  const seen = new Set<string>()
  const accounts: { bank_name: string; balance: number; as_of: string }[] = []

  for (const row of data ?? []) {
    if (!seen.has(row.bank_name)) {
      seen.add(row.bank_name)
      accounts.push({
        bank_name: row.bank_name,
        balance: Number(row.balance_after),
        as_of: row.transaction_date,
      })
    }
  }

  const total = accounts.reduce((s, a) => s + a.balance, 0)
  return { total, accounts }
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

export function applyVendorRules(
  transactions: OwnerTransaction[],
  rules: VendorRule[]
): OwnerTransaction[] {
  return transactions.map(tx => {
    if (tx.category !== 'uncategorized') return tx

    const counterparty = (tx.counterparty ?? tx.description ?? '').toLowerCase()
    const matched = rules.find(rule => {
      const pattern = rule.counterparty_pattern.toLowerCase()
      if (rule.match_type === 'exact') return counterparty === pattern
      if (rule.match_type === 'contains') return counterparty.includes(pattern)
      if (rule.match_type === 'regex') {
        try { return new RegExp(pattern, 'i').test(counterparty) } catch { return false }
      }
      return false
    })

    if (!matched) return tx
    return {
      ...tx,
      category: matched.category as OwnerCategory,
      subcategory: matched.subcategory,
      is_related_party: matched.is_related_party,
    }
  })
}

export function estimateQuarterlyTax(
  netProfit: number,
  effectiveRate = 0.25
): { annual: number; quarterly: number } {
  const annual = Math.max(0, netProfit * effectiveRate)
  return { annual, quarterly: annual / 4 }
}
