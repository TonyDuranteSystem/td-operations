import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { OwnerDashboard } from './owner-dashboard'
import {
  getOwnerPnL,
  getCashPosition,
  getUncategorizedCount,
  getOwnerTransactionsPaginated,
} from '@/lib/owner-finance'

export const dynamic = 'force-dynamic'

export default async function OwnerPage({
  searchParams,
}: {
  searchParams: { tab?: string; year?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect('/')

  const year = parseInt(searchParams.year ?? String(new Date().getFullYear()), 10)
  const activeTab = searchParams.tab ?? 'dashboard'

  const [pnl, cash, uncategorized, txResult] = await Promise.all([
    getOwnerPnL(year),
    getCashPosition(),
    getUncategorizedCount(year),
    getOwnerTransactionsPaginated(year, { category: 'uncategorized', limit: 50 }),
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
      />
    </div>
  )
}
