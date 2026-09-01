import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { OwnerDashboard } from './owner-dashboard'
import {
  getOwnerPnL,
  getCashPosition,
  getUncategorizedCount,
  getOwnerTransactionsPaginated,
  getFilingSummary,
  getAccountRegistry,
  getBalanceSheet,
} from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export default async function OwnerPage({
  searchParams,
}: {
  searchParams: { tab?: string; year?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) redirect('/')

  /* `?year=` (present but empty) is not nullish, so the default never applied and parseInt
   * returned NaN — which reached PostgREST as `tax_year=eq.NaN` and came back a 500. A URL
   * is user input, including a hand-edited or truncated one. */
  const parsedYear = parseInt(searchParams.year ?? '', 10)
  const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
    ? parsedYear
    : new Date().getFullYear()

  const TABS = ['dashboard', 'pnl', 'balance', 'accounts', 'cashflow', 'transactions', 'bookkeeper', 'tax']
  const activeTab = TABS.includes(searchParams.tab ?? '') ? (searchParams.tab as string) : 'dashboard'

  const [pnl, cash, uncategorized, txResult, filing, accounts, balanceSheet] = await Promise.all([
    getOwnerPnL(year),
    getCashPosition(),
    getUncategorizedCount(year),
    getOwnerTransactionsPaginated(year, { category: 'uncategorized', limit: 50 }),
    getFilingSummary(year),
    getAccountRegistry(),
    getBalanceSheet(year),
  ])

  return (
    <div className="h-full">
      <OwnerDashboard
        year={year}
        activeTab={activeTab}
        pnl={pnl}
        cash={cash}
        uncategorizedCount={uncategorized}
        initialTransactions={txResult.rows}
        initialTransactionTotal={txResult.total}
        filing={filing}
        accounts={accounts}
        balanceSheet={balanceSheet}
      />
    </div>
  )
}
