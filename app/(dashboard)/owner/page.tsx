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

  const year = parseInt(searchParams.year ?? String(new Date().getFullYear()), 10)
  const activeTab = searchParams.tab ?? 'dashboard'

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
